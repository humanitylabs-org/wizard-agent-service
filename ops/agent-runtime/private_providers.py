"""Private app control plane. No provider credential is read by this module."""
import ipaddress
import hashlib
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from provider_egress import ProviderEgress, declared_hosts

RELAY_POOL = ipaddress.ip_network('10.252.0.0/16')
NETWORK_LOCK = threading.Lock()
CLIENT_IMAGE = 'ghcr.io/humanitylabs-org/wizard-private-client:0.1.0@sha256:c562bef2166e6e1054be8eed34229cf0ead4574002da28f8fe5d4f09ad0e6631'
CLIENT_UID = 1000  # agreed image user; EVIDENCE-client.md


def migrate_provider(value):
    return {'tinfoil': 'wizard-tinfoil', 'local': 'wizard-local-model'}.get(value, value)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class PrivateProviders:
    def __init__(self, agents, apps_path, docker, failure, client_image=CLIENT_IMAGE):
        self.agents, self.apps_path = agents, apps_path
        self.docker, self.failure, self.client_image = docker, failure, client_image

    def app(self, provider):
        try:
            apps = json.loads(self.apps_path.read_text()).get('apps', [])
        except (OSError, ValueError):
            apps = []
        app = next((a for a in apps if a.get('id') == migrate_provider(provider)), None)
        if not app or not isinstance(app.get('private_inference'), dict):
            raise self.failure('private_provider_unavailable', 503)
        spec = app['private_inference']
        if (not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', app['id']) or
                spec.get('kind') not in ('attested-relay', 'local') or
                type(spec.get('relay_port')) is not int or not 1024 <= spec['relay_port'] <= 65535):
            raise self.failure('private_provider_invalid', 409)
        if app.get('status') != 'running':
            raise self.failure('private_provider_unavailable', 503)
        try:
            declared_hosts(spec)
        except (ValueError, TypeError):
            raise self.failure('private_provider_egress_invalid', 409) from None
        return app

    def is_private(self, agent):
        # Explicit irreversible per-agent marker, or a previously linked record.
        # App installation and privacy alone NEVER migrate legacy agents.
        return bool(agent.get('runtime', {}).get('private_client') or
                    (self.agents.root / agent['id'] / 'runtime' / 'private-provider.json').exists())

    def origin(self, app):
        # Same host-network route as Agent Service aiConnectionUrl; never follow a redirect.
        for value in ((app.get('view') or {}).get('local'), app.get('health')):
            try:
                url = urllib.parse.urlsplit(value or '')
                if (url.scheme in ('http', 'https') and url.hostname in ('localhost', '127.0.0.1', '::1')
                        and not url.username and not url.password):
                    return f'{url.scheme}://{url.netloc}'
            except ValueError:
                pass
        raise self.failure('private_provider_address_invalid', 409)

    def request(self, app, method, path, body=None):
        request = urllib.request.Request(self.origin(app) + path, method=method,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={'Content-Type': 'application/json', 'Origin': self.origin(app),
                                                  'X-Wizard-Request': '1'})
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=5) as response:
                raw = response.read(65537)
                if len(raw) > 65536:
                    raise ValueError('oversize response')
                return json.loads(raw) if raw else {}
        except (OSError, ValueError, urllib.error.URLError):
            raise self.failure('private_provider_unavailable', 503) from None

    def require_weights(self, app, cid):
        spec = app['private_inference']
        marker = spec.get('weights_ready') if spec.get('kind') == 'local' else None
        if not marker:
            return
        if not isinstance(marker, str) or not marker.startswith('/models/') or '..' in marker.split('/'):
            raise self.failure('private_provider_unavailable', 503)
        result = self.docker(['exec', cid, 'test', '-r', marker], check=False, timeout=10)
        if result.returncode:
            raise self.failure('private_provider_unavailable', 503)

    def wait_ready(self, app):
        spec = app['private_inference']
        if spec.get('kind') != 'local' or not spec.get('weights_ready'):
            return
        # Reconciliation restarts the model. Only poll bodyless readiness, never a prompt or token write.
        deadline = time.monotonic() + 60
        while True:
            try:
                value = self.request(app, 'GET', '/api/connection')
                if value.get('weights_ready') is True and value.get('status') == 'connected':
                    return
            except self.failure:
                pass
            if time.monotonic() >= deadline:
                raise self.failure('private_provider_unavailable', 503)
            time.sleep(0.25)

    @staticmethod
    def network_name(agent):
        return 'wzpr-' + hashlib.sha256(agent['id'].encode()).hexdigest()[:24]

    def validate_network(self, value, app, agent):
        ranges = value.get('IPAM', {}).get('Config') or []
        try:
            block = ipaddress.ip_network(ranges[0]['Subnet'])
            valid = len(ranges) == 1 and block.version == 4 and block.prefixlen == 24 and block.subnet_of(RELAY_POOL)
        except (ValueError, KeyError, IndexError):
            valid = False
        if (not valid or not value.get('Internal') or value.get('EnableIPv6') or value.get('Driver') != 'bridge' or
                value.get('Labels', {}).get('wizard.private-provider') != app['id'] or
                value.get('Labels', {}).get('wizard.private-agent') != agent['id'] or
                value.get('Name') != self.network_name(agent) or
                value.get('Options', {}).get('com.docker.network.bridge.inhibit_ipv4') != 'true'):
            raise self.failure('relay_network_unsafe', 409)
        for cid in value.get('Containers', {}):
            peer = json.loads(self.docker(['inspect', cid], timeout=60).stdout)[0]
            labels = peer.get('Config', {}).get('Labels') or {}
            provider = labels.get('com.docker.compose.service') == app['id']
            client = (labels.get('com.docker.compose.service') == 'agent-' + agent['id'] + '-client' and
                      labels.get('com.docker.compose.project') == 'agent-' + agent['id'])
            if not (provider or client):
                raise self.failure('relay_network_unexpected_peer', 409)
        if len(value.get('Containers', {})) > 2:
            raise self.failure('relay_network_unexpected_peer', 409)

    def relays(self, app):
        ids = self.docker(['network', 'ls', '-q', '--filter', 'label=wizard.private-provider=' + app['id']], timeout=60).stdout.split()
        values = json.loads(self.docker(['network', 'inspect', *ids], timeout=60).stdout) if ids else []
        result = []
        for value in values:
            agent = {'id': value.get('Labels', {}).get('wizard.private-agent', '')}
            self.validate_network(value, app, agent)
            result.append(value['Name'])
        return result

    def network(self, app, agent):
        name = self.network_name(agent)
        with NETWORK_LOCK:
            found = self.docker(['network', 'inspect', name], check=False, timeout=60)
            if found.returncode:
                ids = self.docker(['network', 'ls', '-q'], timeout=60).stdout.split()
                networks = json.loads(self.docker(['network', 'inspect', *ids], timeout=60).stdout) if ids else []
                used = [ipaddress.ip_network(c['Subnet']) for n in networks for c in (n.get('IPAM', {}).get('Config') or []) if c.get('Subnet')]
                subnet = next((s for s in RELAY_POOL.subnets(new_prefix=24) if not any(s.overlaps(u) for u in used if s.version == u.version)), None)
                if subnet is None:
                    raise self.failure('relay_network_pool_exhausted', 503)
                self.docker(['network', 'create', '--internal', '--subnet', str(subnet),
                             '--opt', 'com.docker.network.bridge.inhibit_ipv4=true',
                             '--label', 'wizard.private-provider=' + app['id'],
                             '--label', 'wizard.private-agent=' + agent['id'], name], timeout=60)
                found = self.docker(['network', 'inspect', name], timeout=60)
            value = json.loads(found.stdout)[0]
            self.validate_network(value, app, agent)
            # Service labels work for both Runtipi and plain Compose; ambiguous installations fail closed.
            ids = self.docker(['ps', '-aq', '--filter', 'label=com.docker.compose.service=' + app['id']], timeout=60).stdout.split()
            if len(ids) != 1:
                raise self.failure('private_provider_container_ambiguous', 503)
            cid = ids[0]
            info = json.loads(self.docker(['inspect', cid], timeout=60).stdout)[0]
            # Provisioning must complete before a local provider is attached to the relay.
            self.require_weights(app, cid)
            attachment = info.get('NetworkSettings', {}).get('Networks', {}).get(name)
            alias = app['id'] + '-relay'
            if attachment and alias not in (attachment.get('Aliases') or []):
                raise self.failure('relay_network_alias_invalid', 409)
            if not attachment:
                ProviderEgress(self.docker, self.failure).ensure_bootstrap(app, info)
                self.docker(['network', 'connect', '--alias', alias, name, cid], timeout=60)
                info = json.loads(self.docker(['inspect', cid], timeout=60).stdout)[0]
                if alias not in (info['NetworkSettings']['Networks'][name].get('Aliases') or []):
                    raise self.failure('relay_network_attach_failed', 503)
            ProviderEgress(self.docker, self.failure).reconcile(app, cid, self.relays(app))
        return name

    def remove_network(self, name, agent_id, app_id):
        found = self.docker(['network', 'inspect', name], check=False, timeout=60)
        if found.returncode:
            return
        value = json.loads(found.stdout)[0]
        self.validate_network(value, {'id': app_id}, {'id': agent_id})
        for cid in value.get('Containers', {}):
            peer = json.loads(self.docker(['inspect', cid], timeout=60).stdout)[0]
            if peer.get('Config', {}).get('Labels', {}).get('com.docker.compose.service') == app_id:
                self.docker(['network', 'disconnect', '-f', name, cid], timeout=60)
            else:
                self.docker(['rm', '-f', cid], timeout=60)
        self.docker(['network', 'rm', name], timeout=60)

    def reconcile_installed(self):
        """Rebuild linked per-agent networks and seal installed providers before admission."""
        try:
            apps = json.loads(self.apps_path.read_text()).get('apps', [])
        except (OSError, ValueError):
            return []
        failures, desired = [], {}
        for path in self.agents.root.glob('*/agent.json'):
            try:
                agent = json.loads(path.read_text())
                if not isinstance(agent, dict) or agent.get('id') != path.parent.name or not re.fullmatch(r'[a-z][a-z0-9-]{0,30}', str(agent.get('id', ''))):
                    continue
                if not isinstance(agent.get('runtime'), dict) or not isinstance(agent.get('model'), dict):
                    continue
                if self.is_private(agent):
                    desired[agent['id']] = agent
            except (OSError, ValueError, TypeError, KeyError):
                continue
        ids = self.docker(['network', 'ls', '-q', '--filter', 'label=wizard.private-agent'], timeout=60).stdout.split()
        for value in (json.loads(self.docker(['network', 'inspect', *ids], timeout=60).stdout) if ids else []):
            labels = value.get('Labels') or {}
            aid, appid = labels.get('wizard.private-agent'), labels.get('wizard.private-provider')
            agent = desired.get(aid)
            if not agent or migrate_provider(agent.get('model', {}).get('provider')) != appid:
                self.remove_network(value['Name'], aid, appid)
        for entry in apps:
            if not isinstance(entry.get('private_inference'), dict):
                continue
            try:
                app = self.app(entry['id'])
                linked = [a for a in desired.values() if migrate_provider(a.get('model', {}).get('provider')) == app['id']]
                for agent in linked:
                    self.network(app, agent)
                if not linked:
                    cids = self.docker(['ps', '-aq', '--filter', 'label=com.docker.compose.service=' + app['id']], timeout=60).stdout.split()
                    if len(cids) != 1:
                        raise self.failure('private_provider_container_ambiguous', 503)
                    self.require_weights(app, cids[0])
                    ProviderEgress(self.docker, self.failure).reconcile(app, cids[0], [])
            except self.failure as error:
                failures.append({'app': entry.get('id'), 'error': error.code})
        return failures

    def revoke(self, agent):
        runtime = self.agents.root / agent['id'] / 'runtime'
        state = runtime / 'private-provider.json'
        if not state.exists():
            return
        saved = json.loads(state.read_text())
        # Keep the original app origin for revocation if its registry row was removed.
        self.request(saved['app'], 'DELETE', '/api/private-clients/' + agent['id'])
        self.remove_network(saved.get('link', {}).get('network', self.network_name(agent)), agent['id'], saved['app']['id'])
        state.unlink()
        (runtime / 'relay-token').unlink(missing_ok=True)

    def addresses(self, agent, app, network):
        runtime = self.agents.root / agent['id'] / 'runtime'
        with NETWORK_LOCK:
            info = json.loads(self.docker(['network', 'inspect', network], timeout=60).stdout)[0]
            subnet = ipaddress.ip_network(info['IPAM']['Config'][0]['Subnet'])
            ids = self.docker(['ps', '-aq', '--no-trunc', '--filter', 'label=com.docker.compose.service=' + app['id']], timeout=60).stdout.split()
            if len(ids) != 1:
                raise self.failure('private_provider_container_ambiguous', 503)
            peer = info.get('Containers', {}).get(ids[0])
            if not peer:
                raise self.failure('relay_network_attach_failed', 503)
            provider_ip = str(ipaddress.ip_interface(peer['IPv4Address']).ip)
            used = {str(ipaddress.ip_interface(c['IPv4Address']).ip) for c in info.get('Containers', {}).values()}
            own = None
            for path in self.agents.root.glob('*/runtime/private-provider.json'):
                try:
                    saved = json.loads(path.read_text())
                    if saved.get('link', {}).get('network') == network:
                        ip = saved['link']['relay_ip']
                        if path.parent == runtime:
                            own = ip
                        else:
                            used.add(ip)
                except (OSError, ValueError, KeyError):
                    continue
            relay_ip = own if own and own not in used else next((str(ip) for ip in subnet.hosts() if ip != subnet.network_address + 1 and str(ip) not in used), None)
            if not relay_ip:
                raise self.failure('relay_network_full', 503)
            sandbox = ipaddress.ip_network(agent['runtime']['network']['sandbox'])
            link = {'network': network, 'relay_ip': relay_ip, 'provider_ip': provider_ip,
                    'sandbox_ip': str(sandbox.network_address + 3), 'relay_port': app['private_inference']['relay_port']}
            # Reserve under the same lock so concurrent agents cannot pick the same static address.
            state = runtime / 'private-provider.json'
            state.write_text(json.dumps({'app': {'id': app['id'], 'view': {'local': self.origin(app)}}, 'link': link}))
            os.chmod(state, 0o600)
            return link

    def require_client_image(self):
        result = self.docker(['image', 'inspect', self.client_image], check=False, timeout=60)
        try:
            labels = json.loads(result.stdout)[0]['Config'].get('Labels') or {}
        except (ValueError, KeyError, IndexError, TypeError):
            labels = {}
        if result.returncode or labels.get('wizard.private-client.sandbox-bind') != 'v1':
            raise self.failure('private_client_image_unsafe', 409)

    def prepare(self, agent):
        app = self.app(agent.get('model', {}).get('provider'))
        # Older clients ignore LISTEN_HOST and expose plaintext on relay interfaces.
        self.require_client_image()
        runtime = self.agents.root / agent['id'] / 'runtime'
        runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
        state = runtime / 'private-provider.json'
        if state.exists() and json.loads(state.read_text())['app']['id'] != app['id']:
            self.revoke(agent)
        network = self.network(app, agent)
        self.wait_ready(app)
        addresses = self.addresses(agent, app, network)
        value = self.request(app, 'POST', '/api/private-clients', {'agent': agent['id']})
        token, relay = value.get('token'), value.get('relay_url')
        expected = f"http://{app['id']}-relay:{app['private_inference']['relay_port']}"
        if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43,512}', token) or relay != expected:
            self.request(app, 'DELETE', '/api/private-clients/' + agent['id'])
            raise self.failure('private_provider_response_invalid', 502)
        target = runtime / 'relay-token'
        tmp = runtime / ('relay-token-' + secrets.token_hex(8))
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
        with os.fdopen(fd, 'w') as out:
            out.write(token)
        # Client runs non-root. The helper runs as the owner; use a no-network root helper to chown.
        self.docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
                     '--security-opt', 'no-new-privileges:true', '--user', '0:0', '-v', f'{tmp}:/relay-token',
                     '--entrypoint', '/bin/sh', 'restricted-agent-sidecars:local', '-c',
                     f'chown {CLIENT_UID}:{CLIENT_UID} /relay-token'], timeout=60)
        tmp.replace(target)
        # Store only the control-plane address, not tokens or provider metadata with secrets.
        state.write_text(json.dumps({'app': {'id': app['id'], 'view': {'local': self.origin(app)}}, 'link': addresses}))
        os.chmod(state, 0o600)
        return {**addresses, 'app_id': app['id'], 'kind': app['private_inference']['kind'], 'relay_url': relay,
                'network': network, 'token_file': str(target), 'models': agent.get('model', {}).get('allowed_models', [])}


def client_service(link, image):
    return {
        'image': image, 'user': f'{CLIENT_UID}:{CLIENT_UID}', 'read_only': True,
        'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'], 'restart': 'no',
        'environment': {'PROFILE': 'tinfoil' if link['kind'] == 'attested-relay' else 'passthrough',
                        'RELAY_URL': link['relay_url'], 'RELAY_TOKEN_FILE': '/run/wizard/relay-token',
                        'LISTEN_PORT': '3301', 'LISTEN_HOST': link['sandbox_ip'], 'MODELS': ','.join(link['models'])},
        'volumes': [link['token_file'] + ':/run/wizard/relay-token:ro'],
        'networks': {'sandbox': {'ipv4_address': link['sandbox_ip']}, 'relay': {'ipv4_address': link['relay_ip']}},
        'dns': ['127.0.0.1'], 'pids_limit': 128, 'mem_limit': '256m',
    }
