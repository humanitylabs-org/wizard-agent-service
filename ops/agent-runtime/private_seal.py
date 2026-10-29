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
# The injector mounts the Service's own provider key file read-only; no
# per-agent copy exists (agent backups/exports/imports cannot capture one).
KEY_TARGET = '/run/provider-key/key'
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


def agent_root(home_source):
    if not home_source.endswith('/home'):
        raise ValueError('private_network_policy_invalid')
    return home_source[:-len('/home')]


def key_owner(key_source, home_source):
    """Absolute Service key file outside the agent tree; injector runs as its owner."""
    import os
    if not key_source.startswith('/') or key_source.startswith(agent_root(home_source).rsplit('/', 1)[0] + '/'):
        raise ValueError('private_network_policy_invalid')
    try:
        st = os.stat(key_source)
    except OSError:
        raise ValueError('provider_not_configured') from None
    if st.st_mode & 0o077:
        raise ValueError('private_network_policy_invalid')
    return st.st_uid, st.st_gid


def apply(doc, agent, *, ports, home_source='', uid=1000, gid=1000, key_source=''):
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
        key_uid, key_gid = key_owner(key_source, home_source)
        internal.append((keyed_name, keyed))
        # Hermes keeps its unchanged URL; the seal alias now names the
        # injector. The official proxy leaves the seal: only the injector
        # (holding the Service-owned key) can reach its plaintext listeners.
        provider['networks'] = {keyed_name: {'ipv4_address': str(keyed[2])}, egress_name: {'ipv4_address': str(egress[2])}}
        command[command.index('--bind') + 1] = str(keyed[2])
        # During down/force-recreate a service: reference can retain the OLD
        # provider's namespace. Dependencies cannot repair that dead reference.
        # The key-held candidate uses independent proxy namespaces, both without
        # an uplink; the legacy non-injected renderer remains byte-compatible.
        search.pop('network_mode', None)
        search['networks'] = {keyed_name: {'ipv4_address': str(keyed[4])},
                              egress_name: {'ipv4_address': str(egress[4])}}
        search['command'][search['command'].index('--bind') + 1] = str(keyed[4])
        search['extra_hosts'] = dict(provider['extra_hosts'])
        search['dns'] = ['127.0.0.1']
        search['depends_on'] = [edge_name]
        services[main + '-key'] = {
            'image': KEY_IMAGE, 'entrypoint': ['python', '/app/provider-key-injector.py'],
            'networks': {seal_name: {'ipv4_address': str(seal[3]), 'aliases': [proxy]},
                         keyed_name: {'ipv4_address': str(keyed[3])}},
            'environment': {'LISTEN_IP': str(seal[3]), 'UPSTREAM_IP': str(keyed[2]),
                            'PORTS': json.dumps([3301, 3302]), 'KEY_FILE': KEY_TARGET,
                            'UPSTREAM_IPS': json.dumps({'3301': str(keyed[2]), '3302': str(keyed[4])})},
            'volumes': [f'{key_source}:{KEY_TARGET}:ro'],
            'read_only': True, 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
            # Same owner as the Service key file (0600/0400); no other reader.
            'user': f'{key_uid}:{key_gid}', 'pids_limit': 64, 'mem_limit': '64m', 'restart': 'no',
            'logging': {'driver': 'none'}, 'depends_on': [proxy, main + '-search'],
        }
        client.setdefault('depends_on', [])
        if isinstance(client['depends_on'], list) and main + '-key' not in client['depends_on']:
            client['depends_on'].append(main + '-key')
    if gateway(agent):
        # REUSE the restricted scoped edge: token-hash + path allowlist, then
        # the Service's per-agent Unix socket. No TCP route to the Service.
        root = agent_root(home_source)
        services[main + '-gateway'] = {
            'image': GATEWAY_IMAGE, 'command': ['python3', '/srv/edge.py'],
            'networks': {seal_name: {'ipv4_address': str(seal[5]), 'aliases': ['edge']}},
            'environment': {'EDGE_TOKEN_SHA256_FILE': '/run/edge/token.sha256',
                            'EDGE_UPSTREAM_SOCKET': '/run/agent-gateway/gateway.sock',
                            'EDGE_INGRESS_SOCKET': '/run/edge-ingress/ingress.sock',
                            'EDGE_AGENT_HOST': str(seal[2])},
            'volumes': [f'{root}/gateway:/run/agent-gateway', f'{root}/gateway-edge:/run/edge:ro'],
            'tmpfs': [f'/run/edge-ingress:uid={int(uid)},gid={int(gid)},mode=0700'],
            'read_only': True, 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
            'user': f'{int(uid)}:{int(gid)}', 'pids_limit': 64, 'mem_limit': '64m', 'restart': 'no',
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


# ---- installed Runtipi recipe (round 10) ----
# Runtipi's generator (app-manager bundle getDockerCompose/buildService) adds
# every service of a multi-service app to a NON-internal per-app bridge, the
# main service to the shared runtipi_tipi_main_network, may publish APP_PORT,
# and the legacy-format conversion keeps only fields it knows. The owner
# user-config file is the last `-f`. It replaces each sealed service wholesale
# with Compose's `!override` tag (docker-compose >= 2.24.4; Runtipi bundles
# 2.40.0), so the final definition is exactly the reviewed seal.
# Stays False until the round-10 installed-recipe runner evidence admits it.
RUNTIPI_ADMITTED = False
RUNTIPI_MARK = '# wizard: tinfoil-sealed-v1 owner override; do not edit'


def runtipi_override(doc, urn):
    """YAML text (JSON flow nodes) for Runtipi's user-config docker-compose.yml.

    Keeps Runtipi's own ownership labels (status/lifecycle find the app by
    them); drops its bridges, published port and Traefik exposure.
    """
    if not any(n.get('labels', {}).get(LABEL) == POLICY for n in doc.get('networks', {}).values()):
        raise ValueError('private_network_policy_invalid')
    lines = [RUNTIPI_MARK, 'services:']
    for name, service in sorted(doc['services'].items()):
        service = {**service, 'labels': {**(service.get('labels') or {}), 'runtipi.managed': 'true', 'runtipi.appurn': urn}}
        lines.append(f'  {json.dumps(name)}: !override {json.dumps(service, sort_keys=True)}')
    lines.append('networks:')
    for name, network in sorted(doc['networks'].items()):
        lines.append(f'  {json.dumps(name)}: {json.dumps(network, sort_keys=True)}')
    return '\n'.join(lines) + '\n'


def runtime_violations(doc, attached):
    """Compare running containers' networks with the sealed document.

    attached: {service: set(network names as Compose created them)} with the
    project prefix removed. Any extra network (Runtipi app bridge, main
    network) or missing service is a violation; callers stop the app.
    """
    problems = []
    for name, service in doc['services'].items():
        want = set((service.get('networks') or {}).keys())
        have = attached.get(name)
        if have is None:
            problems.append(f'{name}:missing')
        elif have != want:
            problems.append(f'{name}:networks:{sorted(have - want)}:{sorted(want - have)}')
    for name in attached:
        if name not in doc['services']:
            problems.append(f'{name}:unexpected_service')
    return problems
