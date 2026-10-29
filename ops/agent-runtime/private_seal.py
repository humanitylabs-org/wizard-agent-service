"""Opt-in legacy private package networking; never selected by privacy alone.

Port of the reviewed provider CONNECT boundary. This module does not inspect an
agent home, change ownership, alter keys or silently migrate installed recipes.
"""
import ipaddress
import json

POLICY = 'tinfoil-sealed-v1'
EDGE_IMAGE = 'wizard-private-network-edge:round9'
LABEL = 'wizard.private-network-policy'
# Go v0.15.0 uses ATC and its explicit GitHub provenance proxy. No wildcard
# destinations: SDK verifier/github/github.go pins github-proxy.tinfoil.sh.
# sigstore-go's default TUF trust-root mirror is also required for provenance.
HOSTS = ('atc.tinfoil.sh', 'github-proxy.tinfoil.sh', 'tuf-repo-cdn.sigstore.dev',
         'kds-proxy.tinfoil.sh', 'inference.tinfoil.sh', 'websearch.tinfoil.sh')
# Provider-only key contract (round 10): Hermes holds this public constant,
# never the provider bearer. The Service-owned injector replaces it.
PLACEHOLDER_KEY = 'wizard-sealed-provider-key-held-by-injector'
KEY_DIR = 'provider-key'          # Service-owned, sibling of the agent home
GATEWAY_IMAGE = 'restricted-agent-sidecars:local'   # REUSE restricted scoped edge.py
KEY_IMAGE = 'wizard-private-network-edge:round10'   # same stdlib egress image + injector


def enabled(agent):
    policy = agent.get('runtime', {}).get('network_policy', '')
    if not policy:
        return False
    if policy != POLICY or agent.get('privacy') != 'private' or agent.get('model', {}).get('provider') != 'tinfoil':
        raise ValueError('private_network_policy_invalid')
    return True


def networks(agent):
    values = agent.get('runtime', {}).get('sealed_networks', {})
    result = []
    fields = [('agent', '10.246.0.0/16'), ('provider', '10.247.0.0/16')]
    if key_injected(agent):
        fields.append(('keyed', '10.248.0.0/16'))
    for field, pool in fields:
        value = ipaddress.ip_network(values.get(field, ''), strict=True)
        if value.version != 4 or value.prefixlen != 28 or not value.subnet_of(ipaddress.ip_network(pool)):
            raise ValueError('private_network_subnet_invalid')
        result.append(value)
    return result


def key_injected(agent):
    """Opt-in provider-only key location; any other value fails closed."""
    value = agent.get('runtime', {}).get('provider_key_location', '')
    if value not in ('', 'provider'):
        raise ValueError('private_network_policy_invalid')
    return value == 'provider'


def gateway(agent):
    value = agent.get('runtime', {}).get('sealed_gateway', False)
    if not isinstance(value, bool):
        raise ValueError('private_network_policy_invalid')
    return value


def key_mount(home_source):
    """Host directory beside (never inside) the Hermes home."""
    if not home_source.endswith('/home'):
        raise ValueError('private_network_policy_invalid')
    return home_source[:-len('/home')] + '/' + KEY_DIR


def apply(doc, agent, *, ports, home_source='', uid=1000, gid=1000):
    if not enabled(agent):
        return doc
    nets = networks(agent)
    seal, egress = nets[0], nets[1]
    main = agent['runtime']['app_id']; proxy = main + '-tinfoil'
    services = doc['services']; client = services[main]; provider = services[proxy]
    edge_name = main + '-edge'
    seal_name, egress_name, uplink_name = main+'-seal', main+'-provider', main+'-edge-uplink'
    client['networks'] = {seal_name: {'ipv4_address': str(seal[2])}}
    client['ports'] = []
    client['dns'] = ['127.0.0.1']
    client['cap_drop'] = ['ALL']
    client['security_opt'] = ['no-new-privileges:true']
    # Stock dispatch requires CHOWN/SETUID/SETGID at boot; these do not confer
    # network capabilities. Preserve the live uid and data mount exactly.
    client['cap_add'] = ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE']
    client['restart'] = 'no'
    client['labels'] = {LABEL: POLICY}
    provider['networks'] = {seal_name: {'ipv4_address': str(seal[3])}, egress_name: {'ipv4_address': str(egress[2])}}
    # Bind plaintext listeners only on the agent seal, not provider egress.
    command = provider['command']
    command[command.index('--bind') + 1] = str(seal[3])
    command += ['--host', 'inference.tinfoil.sh', '--repo', 'tinfoilsh/confidential-model-router']
    provider['environment'] = {'HTTPS_PROXY': f'http://{egress[3]}:3128', 'NO_PROXY': ''}
    # The SDK's validateTLS uses a raw tls.Dial and ignores HTTPS_PROXY.
    # Exact enclave aliases reach only an SNI-checked opaque TLS edge; no DNS
    # relay, public interface, certificate substitution or SDK patch is used.
    provider['extra_hosts'] = {h: str(egress[3]) for h in ('inference.tinfoil.sh','websearch.tinfoil.sh')}
    provider['dns'] = ['127.0.0.1']
    provider['restart'] = 'no'
    search = services[main+'-search']
    search['command'][search['command'].index('--bind') + 1] = str(seal[3])
    search['environment'] = dict(provider['environment'])
    search['restart'] = 'no'
    # Search shares only the inference namespace (never the agent namespace).
    services[edge_name] = {
        'image': EDGE_IMAGE,
        'networks': {seal_name: {'ipv4_address': str(seal[4])},
                     egress_name: {'ipv4_address': str(egress[3])}, uplink_name: {}},
        'environment': {'LISTEN_IP': str(egress[3]), 'ALLOWED_HOSTS': json.dumps(HOSTS),
                        'DIRECT_TLS_HOSTS': json.dumps(['inference.tinfoil.sh','websearch.tinfoil.sh']),
                        'INGRESS_ROUTES': json.dumps([[8642, str(seal[2]), 8642]])},
        'ports': [f"127.0.0.1:{agent['runtime']['port']}:8642"] if ports else [],
        'read_only': True, 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
        'user': '1000:1000', 'pids_limit': 64, 'mem_limit': '64m', 'restart': 'no',
        'logging': {'driver': 'none'},
    }
    provider.setdefault('depends_on', []).append(edge_name)
    internal = [(seal_name, seal), (egress_name, egress)]
    if key_injected(agent):
        keyed = nets[2]; keyed_name = main + '-keyed'
        internal.append((keyed_name, keyed))
        # Hermes keeps its unchanged URL; the seal alias now names the
        # injector. The official proxy leaves the seal: only the injector
        # (holding the Service-owned key) can reach its plaintext listeners.
        provider['networks'] = {keyed_name: {'ipv4_address': str(keyed[2])}, egress_name: {'ipv4_address': str(egress[2])}}
        command[command.index('--bind') + 1] = str(keyed[2])
        search['command'][search['command'].index('--bind') + 1] = str(keyed[2])
        services[main + '-key'] = {
            'image': KEY_IMAGE, 'entrypoint': ['python', '/app/provider-key-injector.py'],
            'networks': {seal_name: {'ipv4_address': str(seal[3]), 'aliases': [proxy]},
                         keyed_name: {'ipv4_address': str(keyed[3])}},
            'environment': {'LISTEN_IP': str(seal[3]), 'UPSTREAM_IP': str(keyed[2]),
                            'PORTS': json.dumps([3301, 3302]), 'KEY_FILE': '/run/provider-key/key'},
            'volumes': [f'{key_mount(home_source)}:/run/provider-key:ro'],
            'read_only': True, 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
            # Same owner as the Service-written 0400 key file; no other reader.
            'user': f'{int(uid)}:{int(gid)}', 'pids_limit': 64, 'mem_limit': '64m', 'restart': 'no',
            'logging': {'driver': 'none'}, 'depends_on': [proxy],
        }
        client.setdefault('depends_on', [])
        if isinstance(client['depends_on'], list) and main + '-key' not in client['depends_on']:
            client['depends_on'].append(main + '-key')
    if gateway(agent):
        # REUSE the restricted scoped edge: token-hash + path allowlist, then
        # the Service's per-agent Unix socket. No TCP route to the Service.
        root = key_mount(home_source).rsplit('/', 1)[0]
        services[main + '-gateway'] = {
            'image': GATEWAY_IMAGE, 'command': ['python3', '/srv/edge.py'],
            'networks': {seal_name: {'ipv4_address': str(seal[5]), 'aliases': ['edge']}},
            'environment': {'EDGE_TOKEN_SHA256_FILE': '/run/edge/token.sha256',
                            'EDGE_UPSTREAM_SOCKET': '/run/agent-gateway/gateway.sock',
                            'EDGE_INGRESS_SOCKET': '/run/edge-ingress/ingress.sock',
                            'EDGE_AGENT_HOST': str(seal[2])},
            'volumes': [f'{root}/gateway:/run/agent-gateway', f'{root}/gateway-edge:/run/edge:ro'],
            'tmpfs': ['/run/edge-ingress:uid=1000,gid=1000,mode=0700'],
            'read_only': True, 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
            'user': '1000:1000', 'pids_limit': 64, 'mem_limit': '64m', 'restart': 'no',
        }
    for name, subnet in internal:
        doc.setdefault('networks', {})[name] = {
            'internal': True, 'enable_ipv6': False,
            'driver_opts': {'com.docker.network.bridge.inhibit_ipv4': 'true'},
            'ipam': {'config': [{'subnet': str(subnet)}]},
            'labels': {LABEL: POLICY, 'wizard.agent.id': agent['id']},
        }
    doc['networks'][uplink_name] = {'internal': False, 'enable_ipv6': False}
    return doc
