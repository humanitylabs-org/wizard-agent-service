#!/usr/bin/env python3
"""Private-provider acceptance probes. Never prints request bodies, logs or secrets."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time


def run(argv, *, ok=True, timeout=30):
    p = subprocess.run(argv, capture_output=True, timeout=timeout)
    if ok and p.returncode:
        raise RuntimeError('command failed: ' + argv[0] + ' (output withheld)')
    return p


def docker(*args, **kw):
    return run(['docker', *args], **kw)


def inspect(kind, name):
    return json.loads(docker(kind, 'inspect', name).stdout)[0]


def require(value, message):
    if not value:
        raise RuntimeError(message)


def container(name):
    c = inspect('container', name)
    require(c['State']['Running'], 'container not running: ' + name)
    return c


def probe(cid, url):
    """0 HTTP success, 22 reachable HTTP error, 28 connection failure; 90 no probe tool."""
    shell = '''if command -v curl >/dev/null; then
 curl -fsS --noproxy '*' --connect-timeout 3 --max-time 7 -o /dev/null "$1" 2>/dev/null
elif command -v python3 >/dev/null; then
 python3 - "$1" <<'PY'
import sys,urllib.request,urllib.error
try:
 urllib.request.build_opener(urllib.request.ProxyHandler({})).open(sys.argv[1],timeout=6).read(1)
except urllib.error.HTTPError: sys.exit(22)
except Exception: sys.exit(28)
PY
elif command -v node >/dev/null; then
 node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(6000)}).then(r=>process.exit(r.ok?0:22)).catch(()=>process.exit(28))' "$1"
else exit 90; fi'''
    p = docker('exec', cid, 'sh', '-c', shell, 'pp-probe', url, ok=False, timeout=12)
    require(p.returncode in (0, 6, 7, 22, 28, 35, 52, 56), 'probe tool unavailable or exec failed')
    return p.returncode


def blocked(cid, url):
    rc = probe(cid, url)
    require(rc in (6, 7, 28), 'unexpected reachable endpoint (including TLS/HTTP errors): ' + url)
    print('BLOCKED', url, 'exit=' + str(rc))


def provider_containers(a):
    # Explicit ids may be supplied; defaults select exact compose service, never substring matching.
    if a.provider_container:
        return [container(x) for x in a.provider_container]
    ids = docker('ps', '-q', '--filter', 'label=com.docker.compose.service=' + a.provider_app).stdout.decode().split()
    require(ids, 'provider containers absent; pass --provider-container for a nonstandard package')
    return [container(x) for x in ids]


def data_roots(a, cs):
    roots = [Path(x).resolve() for x in a.provider_data]
    for c in cs:
        for m in c.get('Mounts', []):
            if m.get('Type') in ('bind', 'volume') and m.get('RW'):
                p = Path(m['Source']).resolve()
                # Do not scan host socket, shared registry, or unrelated global storage as app data.
                if a.provider_app in p.parts:
                    roots.append(p)
    require(roots, 'no provider data directory: pass --provider-data explicitly')
    for p in roots:
        require(p.is_dir() and p != Path('/'), 'provider data directory missing or unsafe')
    return sorted(set(roots))


def files(roots):
    seen = set()
    for root in roots:
        require(root.exists(), 'scan root missing: ' + str(root))
        if root.is_file():
            yield root
            continue
        def failed(err):
            raise err
        for d, dirs, names in os.walk(root, followlinks=False, onerror=failed):
            for name in names:
                p = Path(d) / name
                if p.is_symlink():
                    require(p.resolve().is_relative_to(root.resolve()), 'scan symlink escapes root: ' + str(p))
                if p.is_file() and p.resolve() not in seen:
                    seen.add(p.resolve())
                    yield p


def contains(path, needle):
    overlap = b''
    with path.open('rb') as f:
        while chunk := f.read(1024 * 1024):
            chunk = overlap + chunk
            if needle in chunk:
                return True
            overlap = chunk[-max(1, len(needle) - 1):]
    return False


def fingerprint_match(data, target):
    # ENV/YAML/JSON/plain-file secrets; no candidate value leaves this function.
    values = [data, data.strip()]
    values.extend(re.findall(rb'[^\s\x00\x22\x27`:,{}\[\]<>]+', data))
    values.extend(v.split(b'=', 1)[1] for v in list(values) if b'=' in v)
    for line in data.splitlines():
        if b'=' in line:
            values.append(line.split(b'=', 1)[1].strip().strip(b'\x22\x27'))
    return any(hashlib.sha256(v).hexdigest() == target for v in values)


def scan_key(path, target):
    # Read lines with overlap for ordinary config secrets; bounded memory for large data/model files.
    with path.open('rb') as f:
        prev = b''
        while chunk := f.read(1024 * 1024):
            if fingerprint_match(prev + chunk, target):
                return True
            prev = chunk[-65536:]
    return False


def relay_network(a):
    c = container(a.client_container or 'agent-' + a.agent + '-client')
    name = 'wzpr-' + hashlib.sha256(a.agent.encode()).hexdigest()[:24]
    require(name in c['NetworkSettings']['Networks'], 'client missing per-agent relay')
    net = inspect('network', name)
    labels = net.get('Labels') or {}
    require(net['Internal'] and labels.get('wizard.private-agent') == a.agent and
            labels.get('wizard.private-provider') == a.provider_app, 'relay ownership/internal mismatch')
    providers = provider_containers(a)
    require(len(providers) == 1, 'provider ambiguous')
    require(set(net.get('Containers', {})) == {c['Id'], providers[0]['Id']}, 'per-agent relay must have exactly client + provider')
    return net


def relay(a):
    require(a.codeword and a.trigger, '--codeword and --trigger required')
    net = relay_network(a)
    require(net['Internal'], 'relay network is not internal')
    bridge = net.get('Options', {}).get('com.docker.network.bridge.name') or 'br-' + net['Id'][:12]
    require(Path('/sys/class/net', bridge).exists(), 'relay bridge absent')
    out = Path(a.evidence_dir)
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    out.chmod(0o700)
    pcap = out / ('relay-' + str(time.time_ns()) + '.pcap')
    pcap.touch(mode=0o600, exist_ok=False)
    # File contains ciphertext and bearer tokens: private evidence only, never print packet contents.
    cap = subprocess.Popen(['tcpdump', '-Z', 'root', '-i', bridge, '-s', '0', '-U', '-w', str(pcap), 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        time.sleep(1)
        require(cap.poll() is None, 'tcpdump could not start')
        p = run([a.trigger], ok=False, timeout=a.timeout)
        require(p.returncode == 0, 'request trigger failed')
        time.sleep(1)
    finally:
        if cap.poll() is None:
            cap.send_signal(signal.SIGINT)
        _, err = cap.communicate(timeout=10)
    require(cap.returncode == 0, 'tcpdump failed')
    dropped = re.search(rb'(\d+) packets dropped by kernel', err)
    require(dropped and int(dropped[1]) == 0, 'capture incomplete or dropped packets')
    streams = run(['tshark', '-r', str(pcap), '-T', 'fields', '-e', 'tcp.stream']).stdout.decode().split()
    require(streams, 'no TCP traffic captured')
    found = False
    for stream in sorted(set(streams)):
        raw = run(['tshark', '-r', str(pcap), '-q', '-z', 'follow,tcp,raw,' + stream]).stdout.decode()
        directions = [bytearray(), bytearray()]
        for line in raw.splitlines():
            if re.fullmatch(r'\t?[0-9a-fA-F]+', line) and len(line.strip()) % 2 == 0:
                directions[int(line.startswith('\t'))].extend(bytes.fromhex(line.strip()))
        for data in directions:
            found |= b'ehbp-encapsulated-key:' in data.lower()
            require(a.codeword.encode() not in data, 'codeword leaked in relay stream')
    require(found, 'Ehbp-Encapsulated-Key absent from reassembled capture')
    print('PASS relay EHBP header present; codeword absent; pcap=' + str(pcap))


def hermes(a):
    c = container(a.hermes_container or 'agent-' + a.agent)
    blocked(c['Id'], 'https://example.com')
    # Direct IP distinguishes a DNS-only failure from an actual network seal.
    blocked(c['Id'], 'http://1.1.1.1')
    require(probe(c['Id'], 'http://agent-' + a.agent + '-client:3301/healthz') == 0, 'Hermes cannot reach client healthz')
    print('PASS Hermes internet blocked; in-seal client reachable')


def client(a):
    c = container(a.client_container or 'agent-' + a.agent + '-client')
    nets = c['NetworkSettings']['Networks']
    expected_relay = relay_network(a)['Name']
    require(expected_relay in nets and len(nets) == 2, 'client must have only agent + relay networks')
    for name in nets:
        require(inspect('network', name)['Internal'], 'client attached to noninternal network')
    require(probe(c['Id'], 'http://' + a.provider_app + '-relay:' + str(a.relay_port) + '/healthz') == 0, 'client cannot reach relay')
    for url in ['https://example.com', 'http://1.1.1.1', 'http://169.254.169.254/latest/meta-data/', 'http://host.lima.internal:7795'] + a.deny_url:
        blocked(c['Id'], url)
    print('PASS client topology and egress probes (add --deny-url for integration-specific lateral targets)')


def key_location(a):
    require(re.fullmatch(r'[a-f0-9]{64}', a.key_sha256 or ''), '--key-sha256 must be a SHA256 fingerprint, not the key')
    cs = provider_containers(a)
    allowed = data_roots(a, cs)
    base = Path(a.os_home)
    roots = [base, Path(a.runtipi_root) / 'apps', Path(a.runtipi_root) / 'user-config', *map(Path, a.scan_root)]
    forbidden = []
    for p in files(roots):
        if scan_key(p, a.key_sha256):
            forbidden.append(str(p))
    container(a.hermes_container or 'agent-' + a.agent)
    container(a.client_container or 'agent-' + a.agent + '-client')
    for cid in docker('ps', '-aq').stdout.decode().split():
        c = inspect('container', cid)
        doc = json.dumps(c).encode()
        if fingerprint_match(doc, a.key_sha256):
            forbidden.append('docker-inspect:' + c['Name'])
    require(not forbidden, 'provider key outside provider data: ' + ', '.join(forbidden))
    matches = [str(p) for p in files(allowed) if scan_key(p, a.key_sha256)]
    require(matches, 'provider key not found in provider data (or unsupported encoding)')
    print('PASS provider key fingerprint present only in provider data; matched_files=' + str(len(matches)))


def stop_provider(a):
    require(a.trigger, '--trigger required; must assert a real successful completed agent request')
    cs = provider_containers(a)
    # A failing preflight cannot be counted as fail-closed proof.
    require(run([a.trigger], ok=False, timeout=a.timeout).returncode == 0, 'baseline agent request did not succeed')
    ids = [c['Id'] for c in cs]
    try:
        docker('stop', '--time', '10', *ids, timeout=60)
        require(all(not inspect('container', x)['State']['Running'] for x in ids), 'provider did not stop')
        result = run([a.trigger], ok=False, timeout=a.timeout)
        # 42 is the trigger adapter contract: terminal, user-visible provider failure (not HTTP admission).
        require(result.returncode == 42, 'trigger must return 42 for verified visible provider failure; got ' + str(result.returncode))
        print('PASS stopped provider yields visible failure without fallback')
    finally:
        docker('start', *ids, timeout=90)
        require(all(inspect('container', x)['State']['Running'] for x in ids), 'provider restart failed')
    require(run([a.trigger], ok=False, timeout=a.timeout).returncode == 0, 'provider restored but request still fails')
    print('PASS provider restored and agent request recovers')


def codeword(a):
    require(a.codeword, '--codeword required')
    needle = a.codeword.encode()
    cs = provider_containers(a)
    leaks = []
    for c in cs:
        log = docker('logs', c['Id'], timeout=60)
        if needle in log.stdout or needle in log.stderr:
            leaks.append('docker-logs:' + c['Name'])
        # json-file logs include rotated files, not only docker logs' currently retained view.
        logpath = c.get('LogPath')
        if logpath:
            lp = Path(logpath)
            for p in lp.parent.glob(lp.name + '*'):
                if p.is_file() and contains(p, needle):
                    leaks.append('log-file:' + str(p))
    for p in files(data_roots(a, cs)):
        if contains(p, needle):
            leaks.append(str(p))
    require(not leaks, 'codeword found in provider logs/data: ' + ', '.join(leaks))
    print('PASS codeword absent from provider logs/data')


def main():
    p = argparse.ArgumentParser(__doc__)
    p.add_argument('check', choices=['relay', 'hermes', 'client', 'key-location', 'stop-provider', 'codeword'])
    p.add_argument('--agent', required=True)
    p.add_argument('--provider-app', required=True, choices=['wizard-tinfoil', 'wizard-local-model'])
    p.add_argument('--codeword')
    p.add_argument('--key-sha256')
    p.add_argument('--hermes-container')
    p.add_argument('--client-container', help='Exact client container name for Compose-generated names')
    p.add_argument('--provider-container', action='append', default=[])
    p.add_argument('--provider-data', action='append', default=[])
    p.add_argument('--scan-root', action='append', default=[])
    p.add_argument('--deny-url', action='append', default=[])
    p.add_argument('--os-home', default='/home/rig/.wizard-os')
    p.add_argument('--runtipi-root', default='/home/rig/runtipi')
    p.add_argument('--evidence-dir', default='/opt/pp-rig/evidence/private')
    p.add_argument('--relay-port', type=int, default=8090)
    p.add_argument('--trigger', help='executable adapter: success=0, verified terminal provider error=42; no output is printed')
    p.add_argument('--timeout', type=int, default=90)
    p.add_argument('--dry-run', action='store_true')
    a = p.parse_args()
    require(Path('/etc/pp-rig').read_text().strip() == 'pp-private-providers', 'not the disposable private-provider rig')
    require(re.fullmatch(r'pp-test-[a-z0-9-]{1,23}', a.agent), 'agent must have pp-test- prefix')
    require(os.geteuid() == 0, 'run under sudo inside the VM')
    for name in ['docker', 'tcpdump', 'tshark', 'python3']:
        require(shutil.which(name), 'missing tool: ' + name)
    docker('info', '--format', '{{.ServerVersion}}')
    if a.dry_run:
        ids = docker('ps', '-aq').stdout.decode().split()
        print('DRY_RUN', a.check, 'prerequisites OK; containers=' + str(len(ids)) + '; no acceptance assertion made')
        return
    {'relay': relay, 'hermes': hermes, 'client': client, 'key-location': key_location,
     'stop-provider': stop_provider, 'codeword': codeword}[a.check](a)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError, ValueError, KeyError) as e:
        print('FAIL', str(e), file=sys.stderr)
        sys.exit(1)
