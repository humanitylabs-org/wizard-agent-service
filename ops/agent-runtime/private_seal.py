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
    for field, pool in [('agent', '10.246.0.0/16'), ('provider', '10.247.0.0/16')]:
        value = ipaddress.ip_network(values.get(field, ''), strict=True)
        if value.version != 4 or value.prefixlen != 28 or not value.subnet_of(ipaddress.ip_network(pool)):
            raise ValueError('private_network_subnet_invalid')
        result.append(value)
    return result


def apply(doc, agent, *, ports):
    if not enabled(agent):
        return doc
    seal, egress = networks(agent)
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
                        'INGRESS_ROUTES': json.dumps([[8642, str(seal[2]), 8642]])},
        'ports': [f"127.0.0.1:{agent['runtime']['port']}:8642"] if ports else [],
        'read_only': True, 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
        'user': '1000:1000', 'pids_limit': 64, 'mem_limit': '64m', 'restart': 'no',
        'logging': {'driver': 'none'},
    }
    provider.setdefault('depends_on', []).append(edge_name)
    for name, subnet in [(seal_name, seal), (egress_name, egress)]:
        doc.setdefault('networks', {})[name] = {
            'internal': True, 'enable_ipv6': False,
            'driver_opts': {'com.docker.network.bridge.inhibit_ipv4': 'true'},
            'ipam': {'config': [{'subnet': str(subnet)}]},
            'labels': {LABEL: POLICY, 'wizard.agent.id': agent['id']},
        }
    doc['networks'][uplink_name] = {'internal': False, 'enable_ipv6': False}
    return doc
