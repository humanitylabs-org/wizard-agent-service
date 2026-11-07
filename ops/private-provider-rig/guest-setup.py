#!/usr/bin/env python3
"""Run as Lima's owner user on the disposable pp-private-providers VM."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tarfile
import time
import urllib.request

ROOT = Path('/opt/pp-rig')
HOME = Path.home()
OSHOME = HOME / '.wizard-os'
USER = os.environ['USER']
ENV = {**os.environ, 'DEBIAN_FRONTEND': 'noninteractive', 'RUNTIPI_ROOT': str(HOME / 'runtipi'),
       'WIZARD_PRIVATE_ACCESS': 'none', 'WAM_NO_BOOTSTRAP': '1', 'WIZARD_MODE': 'fresh',
       'TMPDIR': str(ROOT / 'tmp'), 'PATH': str(HOME / '.local/bin') + ':/usr/local/bin:/usr/bin:/bin'}


def run(*args, cwd=None, timeout=1200, capture=False):
    print('+', args[0], ' '.join(args[1:3]), flush=True)
    return subprocess.run(args, cwd=cwd, env=ENV, check=True, timeout=timeout,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None)


def write(p, text, mode=0o644):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    p.chmod(mode)


def secret(p):
    if not p.exists():
        write(p, secrets.token_urlsafe(48) + '\n', 0o600)


def unit(name, command, extra=''):
    text = f'''[Unit]
Description=Private-provider rig {name}
After=network-online.target docker.service
Requires=docker.service
[Service]
Type=simple
User={USER}
SupplementaryGroups=docker
Environment=HOME={HOME}
Environment=RUNTIPI_ROOT={HOME}/runtipi
Environment=PATH={HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory={ROOT}/src/service
{extra}
ExecStart={command}
Restart=on-failure
[Install]
WantedBy=multi-user.target
'''
    staging = ROOT / (name + '.service')
    write(staging, text)
    run('sudo', 'install', '-m', '0644', str(staging), '/etc/systemd/system/' + name + '.service')


def wait(url):
    for _ in range(45):
        try:
            with urllib.request.urlopen(url, timeout=3) as r:
                if r.status == 200:
                    print('HEALTH', url, r.status, flush=True)
                    return
        except OSError:
            time.sleep(2)
    raise RuntimeError('health check failed: ' + url)


def main():
    stage = Path(os.environ['PP_STAGE'])
    run('sudo', 'mkdir', '-p', str(ROOT))
    run('sudo', 'chown', f'{os.getuid()}:{os.getgid()}', str(ROOT))
    (ROOT / 'tmp').mkdir(exist_ok=True)
    (ROOT / 'src').mkdir(exist_ok=True)
    run('sudo', 'apt-get', 'update', timeout=300)
    run('sudo', '-E', 'apt-get', 'install', '-y', 'python3-yaml',
        'git', 'curl', 'tcpdump', 'tshark', 'jq', 'xz-utils', 'sqlite3', 'ca-certificates', timeout=900)
    # Docker's official packages emit a semver Compose version accepted by Runtipi.
    # Ubuntu's docker-compose-v2 includes a Debian suffix that Runtipi rejects.
    conflicts = []
    for package in ['docker.io', 'docker-compose', 'docker-compose-v2', 'docker-doc',
                    'docker-buildx', 'podman-docker', 'containerd', 'runc']:
        result = subprocess.run(['dpkg-query', '-W', '-f=${Status}', package],
                                env=ENV, capture_output=True, text=True)
        if result.returncode == 0 and result.stdout == 'install ok installed':
            conflicts.append(package)
    if conflicts:
        run('sudo', '-E', 'apt-get', 'remove', '-y', *conflicts, timeout=600)
    run('sudo', 'install', '-m', '0755', '-d', '/etc/apt/keyrings')
    run('sudo', 'curl', '-fsSL', 'https://download.docker.com/linux/ubuntu/gpg',
        '-o', '/etc/apt/keyrings/docker.asc')
    run('sudo', 'chmod', '0644', '/etc/apt/keyrings/docker.asc')
    release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    codename = release.get('UBUNTU_CODENAME', release['VERSION_CODENAME']).strip('"')
    assert codename == 'noble', 'this rig supports only Ubuntu 24.04'
    arch = run('dpkg', '--print-architecture', capture=True).stdout.decode().strip()
    assert arch == 'arm64', 'this rig supports only arm64'
    sources = ROOT / 'docker.sources'
    write(sources, f'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: {codename}\n'
          f'Components: stable\nArchitectures: {arch}\nSigned-By: /etc/apt/keyrings/docker.asc\n')
    run('sudo', 'install', '-m', '0644', str(sources), '/etc/apt/sources.list.d/docker.sources')
    run('sudo', 'apt-get', 'update', timeout=300)
    run('sudo', '-E', 'apt-get', 'install', '-y', 'docker-ce', 'docker-ce-cli', 'containerd.io',
        'docker-buildx-plugin', 'docker-compose-plugin', timeout=900)
    compose = run('sudo', 'docker', 'compose', 'version', '--short', capture=True).stdout.decode().strip().removeprefix('v')
    assert len(compose.split('.')) == 3 and all(p.isdigit() for p in compose.split('.')), 'non-semver Compose: ' + compose
    print('COMPOSE_SEMVER', compose, flush=True)
    # Network topology must not rely on optional bridge-netfilter or owner module loading.
    run('sudo', 'usermod', '-aG', 'docker', USER)
    run('sudo', 'systemctl', 'enable', '--now', 'docker')
    run('sudo', 'loginctl', 'enable-linger', USER)
    marker = ROOT / 'marker'
    write(marker, 'pp-private-providers\n')
    run('sudo', 'install', '-m', '0644', str(marker), '/etc/pp-rig')
    for name in ['wam', 'service']:
        dest = ROOT / 'src' / name
        dest.mkdir(exist_ok=True)
        with tarfile.open(stage / (name + '.tar')) as tf:
            # The repo tracks a dev-only node_modules symlink to an absolute host path; drop it (npm ci rebuilds).
            def keep(member, path):
                if member.issym() and member.linkname.startswith('/'):
                    return None
                return tarfile.data_filter(member, path)
            tf.extractall(dest, filter=keep)
    firewall = ROOT / 'src/service/ops/agent-runtime'
    run('sudo', 'install', '-m', '0755', str(firewall / 'agent-firewall.sh'), '/usr/local/sbin/wizard-agent-firewall')
    run('sudo', 'install', '-m', '0644', str(firewall / 'wizard-agent-firewall.service'), '/etc/systemd/system/wizard-agent-firewall.service')
    run('sudo', 'systemctl', 'daemon-reload')
    run('sudo', 'systemctl', 'enable', '--now', 'wizard-agent-firewall')
    run('sudo', 'wizard-agent-firewall', 'check', '8929')
    # Official stock base pinned to the manager's inherited API/database version.
    rt = HOME / 'runtipi'
    write(rt / 'user-config/tipi-compose.yml', '''services:
  runtipi-reverse-proxy:
    ports: !override
      - 127.0.0.1:8480:80
      - 127.0.0.1:8443:443
''')
    write(ROOT / 'base.env', 'NGINX_PORT=8480\nNGINX_PORT_SSL=8443\nINTERNAL_IP=127.0.0.1\n', 0o600)
    if not (rt / '.env').exists():
        run('sudo', 'bash', str(stage / 'runtipi-setup.sh'), '--version', 'v4.10.2', '--env-file', str(ROOT / 'base.env'), cwd=HOME)
        run('sudo', 'chown', f'{os.getuid()}:{os.getgid()}', str(rt))
        for item in rt.iterdir():
            if item.name != 'data':
                run('sudo', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', str(item))
    OSHOME.mkdir(exist_ok=True)
    write(OSHOME / 'updates.json', '{"mode":"ask"}\n')
    # Install documented WAM from frozen main source; no default apps or provider credentials.
    run('sg', 'docker', '-c', 'umask 022; bash ./install.sh', cwd=ROOT / 'src/wam', timeout=1800)
    run(str(HOME / '.local/bin/wam'), 'updates', '--ask')
    run(str(HOME / '.local/bin/wam'), 'apps', '--json')
    # Node 22 required by the Agent Service's node:sqlite; verify the upstream archive hash.
    ver = '22.22.3'
    filename = f'node-v{ver}-linux-arm64.tar.xz'
    url = f'https://nodejs.org/dist/v{ver}/'
    archive = ROOT / 'tmp' / filename
    if not shutil.which('node') or run('node', '--version', capture=True).stdout.decode().split('.')[0] != 'v22':
        urllib.request.urlretrieve(url + filename, archive)
        sums = urllib.request.urlopen(url + 'SHASUMS256.txt', timeout=30).read().decode()
        expected = next(x.split()[0] for x in sums.splitlines() if x.split()[-1] == filename)
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected
        run('sudo', 'tar', '-xJf', str(archive), '-C', '/usr/local', '--strip-components=1')
        archive.unlink()
    run('npm', 'ci', '--no-audit', '--no-fund', cwd=ROOT / 'src/service', timeout=900)
    run('npm', 'test', cwd=ROOT / 'src/service', timeout=1200)
    run('node', '--test', 'tests/locked-run-bridge.test.mjs', cwd=ROOT / 'src/service', timeout=300)
    runtime = OSHOME / 'agent-runtime'
    for p in [runtime / 'token', runtime / 'owner-proof', runtime / 'hermes-api-key']:
        secret(p)
    (OSHOME / 'agents').mkdir(exist_ok=True)
    # Runtime helper remains a separate host process with Runtipi driver and no provider key argument.
    unit('pp-agent-runtime', f'/usr/bin/python3 {ROOT}/src/service/ops/agent-runtime/agent_runtime.py --driver runtipi --wam {ROOT}/src/wam --agents-dir {OSHOME}/agents --token-file {runtime}/token --home-mount alongside')
    service_env = ROOT / 'service.env'
    write(service_env, '\n'.join([
        'WIZARD_HERMES_API_KEY=' + (runtime / 'hermes-api-key').read_text().strip(),
        'WIZARD_HOST=127.0.0.1', 'WIZARD_PORT=8787', 'WIZARD_AUTH_MODE=none',
        'WIZARD_AGENT_HOST=0.0.0.0', 'WIZARD_AGENT_PORT=8929',
        f'WIZARD_OS_HOME={OSHOME}', f'WIZARD_AGENTS_DIR={OSHOME}/agents',
        'WIZARD_AGENT_RUNTIME_URL=http://127.0.0.1:7795', f'WIZARD_AGENT_RUNTIME_TOKEN_FILE={runtime}/token',
        f'WIZARD_OWNER_PROOF_FILE={runtime}/owner-proof',
        'WIZARD_FOLLOW_THROUGH=off', 'WIZARD_JOINED_DELEGATION=prefer',
        'HERMES_ORIGIN=http://127.0.0.1:8642', f'HERMES_HOME={ROOT}/hermes',
    ]) + '\n', 0o600)
    unit('pp-agent-service', f'/usr/local/bin/node {ROOT}/src/service/server/index.mjs', 'EnvironmentFile=' + str(service_env))
    run('sudo', 'systemctl', 'daemon-reload')
    run('sudo', 'systemctl', 'enable', '--now', 'pp-agent-runtime', 'pp-agent-service')
    wait('http://127.0.0.1:7795/healthz')
    wait('http://127.0.0.1:8787/wizard/health')
    wait('http://127.0.0.1:8480/api/health')
    checks = ROOT / 'checks'
    if checks.exists():
        shutil.rmtree(checks)
    shutil.copytree(ROOT / 'src/service/ops/private-provider-rig/checks', checks)
    for p in checks.glob('*.sh'):
        p.chmod(0o755)
        run('sudo', 'bash', str(p), '--agent', 'pp-test-dryrun', '--provider-app', 'wizard-tinfoil', '--dry-run')
    # Prefetch the stock Hermes image while holding the worker lease; integration supplies new client/provider images.
    run('sudo', 'docker', 'pull', 'ghcr.io/humanitylabs-org/hermes-agent:v2026.9.24-wizard2', timeout=1200)
    run('sudo', 'docker', 'ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}')
    run('sudo', 'docker', 'version', '--format', '{{.Server.Version}}')
    run('sudo', 'docker', 'compose', 'version')
    run('node', '--version')
    run('sudo', 'systemctl', 'is-active', 'pp-agent-runtime', 'pp-agent-service')
    inventory = json.loads((stage / 'source-manifest.json').read_text())
    inventory.update({'guest_home': str(HOME), 'runtipi': 'v4.10.2', 'agent_service_port': 8787, 'runtime_port': 7795,
                      'checks': str(checks), 'ready': True, 'dry_run_only': True, 'provider_key_present': False})
    write(ROOT / 'ready.json', json.dumps(inventory, indent=2) + '\n')
    print('PP_RIG_READY ' + json.dumps(inventory), flush=True)


if __name__ == '__main__':
    main()
