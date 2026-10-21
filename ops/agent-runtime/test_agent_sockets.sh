#!/usr/bin/env bash
# Unprivileged replacement for the legacy test_agent_firewall.sh. Disposable Docker projects only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/restricted-agent" && pwd)"
OUT="${1:?usage: test_agent_sockets.sh receipts-dir}"
mkdir -p "$OUT"
export AGENT_PROJECT="${AGENT_PROJECT:-socket-conf-$$}"
export AGENT_GATEWAY_DIR=/unused AGENT_EDGE_UID=1000 AGENT_EDGE_GID=1000
export SOCKET_HOST_PORT="${SOCKET_HOST_PORT:-28923}"
export AGENT_API_KEY=socket-fixture-api-key
export EDGE_TOKEN_SHA256
EDGE_TOKEN_SHA256=$(printf %s socket-fixture-token-one-0123456789abcdef | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')
export AGENT_INGRESS_BIND="${AGENT_INGRESS_BIND:-127.0.0.1:28642}"
DC=(docker compose -p "$AGENT_PROJECT" -f "$HERE/compose.yml" -f "$HERE/conformance/compose.socket.yml")
cleanup() { "${DC[@]}" logs --no-color > "$OUT/final-compose.log" 2>&1 || true; "${DC[@]}" down -v --remove-orphans > "$OUT/teardown.log" 2>&1; }
trap cleanup EXIT
"${DC[@]}" config --format json > "$OUT/compose.json"
"${DC[@]}" build > "$OUT/build.log" 2>&1
phase() {
  local phase="$1"
  for _ in $(seq 1 60); do
    if "${DC[@]}" exec -T socket-service test -S /state/agents/two/gateway/gateway.sock && \
       python3 -c 'import urllib.request,sys; urllib.request.urlopen("http://"+sys.argv[1]+"/",timeout=2).read()' "$AGENT_INGRESS_BIND" 2>/dev/null; then break; fi
    sleep 1
  done
  for svc in agent edge socket-service; do
    mode="$svc"; [ "$svc" != socket-service ] || mode=service
    "${DC[@]}" exec -T -e CONF_HOST_PORT="$SOCKET_HOST_PORT" "$svc" python3 - "$mode" < "$HERE/conformance/socket_probe.py" > "$OUT/$phase-$svc.json"
  done
  # Positive control: the synthetic host service really listens on the host stack.
  "${DC[@]}" exec -T host-listener python3 -c "import socket; socket.create_connection(('127.0.0.1', $SOCKET_HOST_PORT), 2).close()"
  docker network inspect "${AGENT_PROJECT}_sandbox" > "$OUT/$phase-network.json"
  python3 - "$OUT/$phase-network.json" <<'PY'
import json,sys
n=json.load(open(sys.argv[1]))[0]
assert n['Internal'] and not n['EnableIPv6'] and n['Options']['com.docker.network.bridge.inhibit_ipv4']=='true'
PY
  ids=$("${DC[@]}" ps -q)
  docker inspect $ids > "$OUT/$phase-inspect.json"
  python3 - "$OUT/$phase-inspect.json" <<'PY'
import json,sys
rows=json.load(open(sys.argv[1])); by={r['Config']['Labels']['com.docker.compose.service']:r for r in rows}
e=by['edge']; a=by['agent']; g=by['egress']; svc=by['socket-service']
assert len(e['NetworkSettings']['Networks']) == 1 and next(iter(e['NetworkSettings']['Networks'])).endswith('_sandbox')
assert not e['HostConfig'].get('ExtraHosts')
assert len(e['Mounts']) == 1 and e['Mounts'][0]['Name'].endswith('_gateway-one') and e['Mounts'][0]['Destination']=='/run/agent-gateway'
assert not g['Mounts'] and len(g['NetworkSettings']['Networks'])==2
assert not any(m['Type']=='bind' or 'gateway' in m.get('Name','') for m in a['Mounts'])
assert not svc['HostConfig'].get('PortBindings') and svc['HostConfig']['NetworkMode']=='none'
print('namespace and mount boundary PASS')
PY
  "${DC[@]}" logs --no-color > "$OUT/$phase-compose.log" 2>&1
}
"${DC[@]}" up -d > "$OUT/up.log" 2>&1
phase initial
# Replace socket in the mounted directory without recreating edge: restart and crash-stale recovery.
"${DC[@]}" restart socket-service > "$OUT/restart.log" 2>&1
phase restart
"${DC[@]}" down > "$OUT/down.log" 2>&1
"${DC[@]}" up -d > "$OUT/recreate.log" 2>&1
phase recreate
cleanup
trap - EXIT
python3 - "$AGENT_PROJECT" "$OUT" <<'PY'
import json,subprocess,sys
project,out=sys.argv[1:]
for cmd in (['ps','-aq'], ['volume','ls','-q'], ['network','ls','-q']):
    assert not subprocess.check_output(['docker',*cmd,'--filter',f'label=com.docker.compose.project={project}'],text=True).strip(), cmd
from pathlib import Path
checks=[c for f in Path(out).glob('*-*.json') if f.name.split('-')[0] in ('initial','restart','recreate') and not f.name.endswith(('-inspect.json', '-network.json')) for c in json.loads(f.read_text())['checks']]
assert checks and all(c['pass'] for c in checks)
summary={'passed':len(checks),'total':len(checks),'teardown_clean':True}
Path(out,'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary))
PY
