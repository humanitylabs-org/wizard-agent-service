"""Runtime-owned provider egress. Never change host firewall or copy app secrets.

Linking is an explicit migration: stop the provider, remove ALL old interfaces,
attach internal-only networks, then start. Apps must ship proxy-aware images and
DNS/proxy settings; incompatible installations are left stopped, never bypassed.
"""
import ipaddress
import json
from pathlib import Path
from urllib.parse import urlsplit

from importlib.util import module_from_spec, spec_from_file_location
_spec = spec_from_file_location('provider_connect_proxy', Path(__file__).with_name('provider-connect-proxy.py'))
_proxy = module_from_spec(_spec)
_spec.loader.exec_module(_proxy)
hostname = _proxy.hostname
IMAGE = 'wizard-provider-egress:local'
POOL = ipaddress.ip_network('10.253.0.0/16')


def declared_hosts(spec):
    hosts = spec.get('egress')
    if not isinstance(hosts, list) or len(hosts) > 32 or not all(isinstance(h, str) for h in hosts) or len(set(hosts)) != len(hosts):
        raise ValueError('egress list required')
    result = sorted(hostname(h) for h in hosts)
    if spec['kind'] == 'local' and result:
        raise ValueError('local egress must be empty')
    return result


class ProviderEgress:
    def __init__(self, docker, failure, namespace='wizard', image=IMAGE):
        self.docker, self.failure = docker, failure
        self.namespace, self.image = namespace, image

    def inspect(self, kind, name):
        command = ['network', 'inspect'] if kind == 'network' else ['inspect']
        value = self.docker([*command, name], check=False, timeout=60)
        return json.loads(value.stdout)[0] if value.returncode == 0 else None

    def network(self, app):
        name = self.namespace + '-egress-' + app['id']
        value = self.inspect('network', name)
        if value is None:
            ids = self.docker(['network', 'ls', '-q'], timeout=60).stdout.split()
            nets = json.loads(self.docker(['network', 'inspect', *ids], timeout=60).stdout) if ids else []
            used = [ipaddress.ip_network(c['Subnet']) for n in nets for c in (n.get('IPAM', {}).get('Config') or []) if c.get('Subnet')]
            subnet = next((s for s in POOL.subnets(new_prefix=24) if not any(s.overlaps(u) for u in used if s.version == u.version)), None)
            if subnet is None:
                raise self.failure('provider_egress_pool_exhausted', 503)
            self.docker(['network', 'create', '--internal', '--subnet', str(subnet),
                         '--opt', 'com.docker.network.bridge.inhibit_ipv4=true',
                         '--label', 'wizard.private-egress=' + app['id'], name], timeout=60)
            value = self.inspect('network', name)
        if (not value or not value.get('Internal') or value.get('EnableIPv6') or
            value.get('Driver') != 'bridge' or
            value.get('Labels', {}).get('wizard.private-egress') != app['id'] or
            value.get('Options', {}).get('com.docker.network.bridge.inhibit_ipv4') != 'true'):
            raise self.failure('provider_egress_network_unsafe', 409)
        blocks = value.get('IPAM', {}).get('Config') or []
        try:
            block = ipaddress.ip_network(blocks[0]['Subnet'])
            valid = len(blocks) == 1 and block.version == 4 and block.prefixlen == 24 and block.subnet_of(POOL)
        except (ValueError, KeyError, IndexError):
            valid = False
        if not valid:
            raise self.failure('provider_egress_network_unsafe', 409)
        return name

    def validate(self, info, hosts):
        env = dict(v.split('=', 1) for v in info['Config'].get('Env', []) if '=' in v)
        h = info['HostConfig']
        expected = 'http://wizard-egress-proxy:3128'
        if hosts:
            if env.get('HTTPS_PROXY') != expected or env.get('https_proxy', expected) != expected:
                raise self.failure('provider_proxy_configuration_required', 409)
            if any(env.get(k) for k in ('ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy')):
                raise self.failure('provider_proxy_configuration_unsafe', 409)
        elif any(env.get(k) for k in ('HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy')):
            raise self.failure('local_provider_proxy_forbidden', 409)
        if (h.get('Privileged') or h.get('CapAdd') or 'ALL' not in h.get('CapDrop', []) or
            h.get('Devices') or h.get('ExtraHosts') or h.get('Dns') != ['127.0.0.1'] or
            h.get('NetworkMode') in ('host', 'none') or str(h.get('NetworkMode', '')).startswith('container:') or
            not h.get('ReadonlyRootfs') or 'no-new-privileges:true' not in h.get('SecurityOpt', [])):
            raise self.failure('provider_container_unsafe', 409)
        if any(m['Destination'] in ('/var/run/docker.sock', '/run/docker.sock') for m in info.get('Mounts', [])):
            raise self.failure('provider_container_unsafe', 409)

    def helper(self, name, args, network, alias=None):
        self.docker(['rm', '-f', name], check=False, timeout=60)
        self.docker(['create', '--name', name, '--network', network, '--restart', 'no',
                     '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
                     '--security-opt', 'no-new-privileges:true', '--pids-limit', '64',
                     '--memory', '64m', *args], timeout=60)
        return name

    def reconcile(self, app, cid, relays):
        relays = set(relays)
        hosts = declared_hosts(app['private_inference'])
        info = self.inspect('container', cid)
        if not info:
            raise self.failure('private_provider_unavailable', 503)
        # Stop BEFORE validating/migrating: unsafe existing installs never stay serving.
        self.docker(['update', '--restart', 'no', cid], timeout=60)
        self.docker(['stop', cid], timeout=60)
        try:
            self.validate(info, hosts)
            net = self.network(app)
            proxy = self.namespace + '-egress-proxy-' + app['id']
            edge = self.namespace + '-provider-edge-' + app['id']
            allowed_peers = {info['Name'].lstrip('/'), proxy, edge}
            if any(peer.get('Name') not in allowed_peers for peer in (self.inspect('network', net).get('Containers') or {}).values()):
                raise self.failure('provider_egress_network_unexpected_peer', 409)
            # Helpers are replaced on every reconcile, so policy/listen IP updates are atomic
            # with respect to the stopped app, including after runtime/Docker restart.
            for name in (proxy, edge):
                current = self.inspect('container', name)
                if current and current['Config'].get('Labels', {}).get('wizard.private-egress') != app['id']:
                    raise self.failure('provider_helper_name_conflict', 409)
                self.docker(['rm', '-f', name], check=False, timeout=60)
            for old in info.get('NetworkSettings', {}).get('Networks', {}):
                if old not in relays | {net}:
                    self.docker(['network', 'disconnect', '-f', old, cid], timeout=60)
            subnet = ipaddress.ip_network(self.inspect('network', net)['IPAM']['Config'][0]['Subnet'])
            address, proxy_ip = (str(subnet.network_address + n) for n in (2, 3))
            current = self.inspect('container', cid)
            if net in current['NetworkSettings']['Networks']:
                self.docker(['network', 'disconnect', '-f', net, cid], timeout=60)
            self.docker(['network', 'connect', '--ip', address, net, cid], timeout=60)
            label = ['--label', 'wizard.private-egress=' + app['id']]
            # Original provider PortBindings are inert on internal-only Docker networks.
            # A narrow ingress-only TCP edge preserves owner/Agent Service reachability.
            ports = info['HostConfig'].get('PortBindings') or {}
            mappings, routes = [], []
            if ports:
                local = urlsplit(app.get('view', {}).get('local') or app.get('health') or '')
                if local.hostname not in ('localhost', '127.0.0.1'):
                    raise self.failure('provider_management_origin_invalid', 409)
                for key, bindings in ports.items():
                    port, protocol = key.split('/')
                    if protocol != 'tcp' or int(port) in (3128, app['private_inference']['relay_port']):
                        raise self.failure('provider_management_port_unsafe', 409)
                    for binding in bindings or []:
                        # Never preserve a public/wildcard exposure during migration.
                        if binding.get('HostIp') not in ('127.0.0.1', '::1') or not binding.get('HostPort'):
                            raise self.failure('provider_management_binding_unsafe', 409)
                        mappings += ['-p', '127.0.0.1:' + binding['HostPort'] + ':' + port]
                    routes.append([int(port), address, int(port)])
            if hosts or routes:
                # One system edge per app: CONNECT + fixed ingress, not two uplinks.
                helper = proxy if hosts else edge
                self.helper(helper, [*label, *mappings, '--ip', proxy_ip,
                                     '--network-alias', 'wizard-egress-proxy' if hosts else 'wizard-provider-ingress',
                                     '-e', 'ALLOWED_HOSTS=' + json.dumps(hosts),
                                     '-e', 'LISTEN_IP=' + proxy_ip,
                                     '-e', 'INGRESS_ROUTES=' + json.dumps(routes), self.image], net)
                self.docker(['network', 'connect', 'bridge', helper], timeout=60)
                self.docker(['start', helper], timeout=60)
            self.docker(['start', cid], timeout=60)
            final = self.inspect('container', cid)
            if set(final['NetworkSettings']['Networks']) != relays | {net}:
                raise self.failure('provider_network_verification_failed', 503)
            return {'network': net, 'hosts': hosts}
        except Exception:
            self.docker(['stop', cid], check=False, timeout=60)
            raise
