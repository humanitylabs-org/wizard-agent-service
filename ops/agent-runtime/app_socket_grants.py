"""Trusted host extension of RestrictedDriver, not a second runtime or gateway.

Only a per-agent socket inode and fixed source-packaged credential-free plugin are
mounted. No app-supplied compose or agent.json grant is consumed. Socket replacement
requires force-recreate (the existing driver apply/start path); never mount its directory.
"""
import hashlib
import json
import os
from pathlib import Path
import stat

AGENT_UID = 10000
TARGET = '/run/shared-vault/agent.sock'
PLUGIN = Path(__file__).parent / 'app-sockets' / 'shared-vault' / '__init__.py'
PLUGIN_SHA256 = 'ee6dc8c0b40b8c4860429b9db0cdd63bc7073d7cb2a1c3387160b32935aef416'


def private_file(path):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError('unsafe_socket_grants')
    parent = path.parent.lstat()
    if parent.st_uid not in (0, os.geteuid()) or stat.S_IMODE(parent.st_mode) & 0o077:
        raise ValueError('unsafe_socket_grants')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid not in (0, os.geteuid()) or st.st_mode & 0o077 or st.st_size > 65536:
            raise ValueError('unsafe_socket_grants')
        with os.fdopen(os.dup(fd)) as src:
            return json.load(src)
    finally:
        os.close(fd)


def grant_for(path, agent, *, ready=True):
    if path is None:
        return None
    doc = private_file(path)
    if set(doc) != {'schema', 'agents'} or doc['schema'] != 1 or not isinstance(doc['agents'], dict):
        raise ValueError('invalid_socket_grants')
    paths = [g.get('socket') for g in doc['agents'].values() if isinstance(g, dict)]
    if len(paths) != len(doc['agents']) or any(not isinstance(p, str) for p in paths) or len(set(paths)) != len(paths):
        raise ValueError('shared_app_socket_forbidden')
    grant = doc['agents'].get(agent['id'])
    if grant is None:
        return None
    if set(grant) != {'app', 'socket', 'broker_uid', 'edge_uid', 'agent_uid'} or grant['app'] != 'shared-vault':
        raise ValueError('invalid_socket_grant')
    uids = [grant[k] for k in ('broker_uid', 'edge_uid', 'agent_uid')]
    if any(type(uid) is not int or uid <= 0 for uid in uids) or len(set(uids)) != 3 or grant['agent_uid'] != AGENT_UID:
        raise ValueError('isolated_socket_uids_required')
    if agent.get('imported') or agent.get('runtime', {}).get('isolation') != 'restricted':
        raise ValueError('restricted_socket_runtime_required')
    sock = Path(grant['socket'])
    if not sock.is_absolute() or sock.resolve() != sock:
        raise ValueError('unsafe_app_socket')
    # A dedicated app edge directory, not an agent-owned home. All ancestors must
    # be nonsymlink and non-writable by the model uid. The daemon remains trusted.
    for parent in sock.parents:
        st = parent.lstat()
        if st.st_uid == AGENT_UID or (st.st_mode & 0o002) or (st.st_gid == AGENT_UID and st.st_mode & 0o020):
            raise ValueError('unsafe_app_socket_parent')
    if ready:
        st = sock.lstat()
        if not stat.S_ISSOCK(st.st_mode) or st.st_uid != grant['edge_uid'] or st.st_gid != AGENT_UID or stat.S_IMODE(st.st_mode) != 0o660:
            raise ValueError('app_socket_not_ready')
    if PLUGIN.is_symlink() or hashlib.sha256(PLUGIN.read_bytes()).hexdigest() != PLUGIN_SHA256:
        raise ValueError('app_socket_plugin_integrity')
    manifest = PLUGIN.with_name('plugin.yaml')
    if manifest.is_symlink() or hashlib.sha256(manifest.read_bytes()).hexdigest() != 'd37d9a60d3f44b3fc9d9b131937eec0a9c8b36901d83420291dada0f98a77ebf':
        raise ValueError('app_socket_manifest_integrity')
    return grant


def compose_override(grant, *, home, image):
    def bind(source, target):
        return {'type': 'bind', 'source': str(source), 'target': target, 'read_only': True,
                'bind': {'create_host_path': False}}
    packaged = [bind(PLUGIN, '/opt/data/plugins/shared-vault/__init__.py'),
                bind(PLUGIN.with_name('plugin.yaml'), '/opt/data/plugins/shared-vault/plugin.yaml')]
    return {'services': {'agent': {'user': '10000:10000', 'userns_mode': 'host',
        'environment': {'SHARED_VAULT_SOCKET': TARGET},
        'depends_on': {'app-plugin-init': {'condition': 'service_completed_successfully'}},
        'volumes': [bind(grant['socket'], TARGET), *packaged]},
        'app-plugin-init': {'image': image, 'user': '10000:10000', 'userns_mode': 'host',
            'read_only': True, 'network_mode': 'none', 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
            'restart': 'no', 'entrypoint': ['/opt/hermes/.venv/bin/hermes'], 'command': ['plugins', 'enable', 'shared-vault'],
            'environment': {'HOME': '/opt/data', 'HERMES_HOME': '/opt/data'},
            'depends_on': {'home-init': {'condition': 'service_completed_successfully'}},
            'tmpfs': ['/tmp:rw,nosuid,nodev,size=64m,mode=1777'],
            'volumes': [{'type': 'bind', 'source': str(home), 'target': '/opt/data', 'bind': {'create_host_path': False}}, *packaged]}}}


def identity_script(pid):
    if pid not in ('self', '1'):
        raise ValueError('invalid_identity_probe')
    return ("import json,os,pathlib; p=pathlib.Path('/proc/" + pid + "'); "
            "s=dict(line.split(':',1) for line in (p/'status').read_text().splitlines() if ':' in line); "
            "print(json.dumps({'uids':s['Uid'].split(),'caps':{k:s[k].strip() for k in "
            "('CapInh','CapPrm','CapEff','CapBnd','CapAmb')},'nnp':s['NoNewPrivs'].strip(),"
            "'uid_map':(p/'uid_map').read_text().split(),'userns':os.stat(p/'ns/user').st_ino}))")


def verify_identity(snapshot):
    # Initial namespace only. No synthetic or assumed uid-map accepted in production.
    if not isinstance(snapshot, dict):
        raise ValueError('invalid_socket_identity')
    initial = ['0', '0', '4294967295']
    if Path('/proc/self/uid_map').read_text().split() != initial or snapshot.get('uid_map') != initial:
        raise ValueError('mapped_socket_namespace')
    if snapshot.get('userns') != os.stat('/proc/self/ns/user').st_ino:
        raise ValueError('different_socket_namespace')
    if snapshot.get('uids') != ['10000'] * 4 or snapshot.get('nnp') != '1' or set(snapshot.get('caps', {})) != {'CapInh','CapPrm','CapEff','CapBnd','CapAmb'}:
        raise ValueError('unsafe_socket_process')
    if any(int(value, 16) != 0 for value in snapshot['caps'].values()):
        raise ValueError('privileged_socket_process')


def verify_applied(record, grant, home):
    """Exact added mount and whole-runtime authority gate, run outside the container."""
    cfg, host = record['Config'], record['HostConfig']
    if cfg['User'] != '10000:10000' or not host['ReadonlyRootfs'] or host.get('Privileged') or host.get('CapAdd') or 'ALL' not in host.get('CapDrop', []):
        raise ValueError('unsafe_socket_runtime')
    if host.get('PidMode') or host.get('IpcMode') not in ('private', '') or host.get('NetworkMode') == 'host' or host.get('Devices') or host.get('PortBindings'):
        raise ValueError('unsafe_socket_namespaces')
    if host.get('UsernsMode') != 'host' or not any(s.startswith('no-new-privileges') for s in host.get('SecurityOpt', [])):
        raise ValueError('unsafe_socket_uid_mapping')
    expected = {'/opt/data', '/opt/wizard-skills', TARGET, '/opt/data/plugins/shared-vault/__init__.py', '/opt/data/plugins/shared-vault/plugin.yaml'}
    mounts = record['Mounts']
    # tmpfs may appear in Mounts depending on Engine version.
    actual = {m['Destination'] for m in mounts if m['Type'] != 'tmpfs'}
    if actual != expected:
        raise ValueError('unexpected_socket_runtime_mount')
    for m in mounts:
        target = m['Destination']
        if target == '/opt/data' and (m['Type'] != 'bind' or Path(m['Source']).resolve() != Path(home).resolve()):
            raise ValueError('wrong_socket_runtime_home')
        if target in (TARGET, '/opt/data/plugins/shared-vault/__init__.py', '/opt/data/plugins/shared-vault/plugin.yaml'):
            source = grant['socket'] if target == TARGET else str(PLUGIN if target.endswith('__init__.py') else PLUGIN.with_name('plugin.yaml'))
            if m['Type'] != 'bind' or m['RW'] or m['Source'] != source:
                raise ValueError('wrong_app_socket_mount')
        if target == '/opt/wizard-skills' and (m['Type'] != 'volume' or m['RW']):
            raise ValueError('unsafe_system_skills_mount')
    if any(m['Type'] == 'tmpfs' and m['Destination'] != '/tmp' for m in mounts):
        raise ValueError('unexpected_socket_runtime_tmpfs')
