#!/bin/bash
# Restricted-agent conformance run (acceptance test 6). Runs on a Docker host (Thales/colima or Linux).
#
# 1. Plants synthetic canaries (fake host-home file, fake SSH key, fake control-plane secret) on the
#    Docker host and inside a stand-in Agent Service, starts a synthetic host-only service that greets
#    with the canary, and mints a fresh agent token and API key. Nothing real is read or copied.
# 2. Self-tests the outside-in mount/env rules against bad layouts (host home, /, sockets, ...) and
#    the egress TLS gate against a local recording upstream (fragmented hello, refused tunnels).
# 3. Starts the runtime with an empty agent home.
# 4. Each phase: conformance/in_agent.py inside the agent (Hermes' own tool dispatcher, normal tools),
#    outside-in `docker inspect` checks, and the stand-in service's request log for that phase.
# 5. Phases: fresh, after `restart`, after `down`/`up` with the home volume kept.
# 6. Tears down, verifies nothing is left, scans every receipt for the canary, then redacts.
#
# Usage: run.sh <receipts-dir>
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
RECEIPTS="${1:?receipts dir}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$RECEIPTS/$STAMP"
export AGENT_PROJECT="ragent-conf-$(echo "$STAMP" | tr 'A-Z' 'a-z')"
mkdir -p "$OUT"

rand() { python3 -c 'import secrets;print(secrets.token_hex(24))'; }
CANARY="CONFORMANCE-CANARY-$(rand)"
TOKEN="agt_$(rand)"
export CONF_CANARY="$CANARY"
export CONF_HOST_PORT="${CONF_HOST_PORT:-18923}"
export AGENT_API_KEY="$(rand)$(rand)"
export EDGE_TOKEN_SHA256="$(printf '%s' "$TOKEN" | python3 -c 'import sys,hashlib;print(hashlib.sha256(sys.stdin.read().encode()).hexdigest())')"
# Placeholders for the base file; the test overlay replaces the bind mount with Docker-local volumes.
export AGENT_GATEWAY_DIR=/unused AGENT_EDGE_UID=65534 AGENT_EDGE_GID=65534
INGRESS_SOCKET=/gate-one/ingress.sock

# Synthetic host-only files stay beside receipts, never in an owner home or a Docker bind.
# The mount validator independently rejects host-home and root-directory binds. Removed on exit.
HOST_CANARY_DIR="$OUT/host-canary"
mkdir -p "$HOST_CANARY_DIR/.ssh"
printf 'synthetic host-home file %s\n' "$CANARY" > "$HOST_CANARY_DIR/canary.txt"
printf -- '-----BEGIN SYNTHETIC TEST KEY-----\n%s\n-----END SYNTHETIC TEST KEY-----\n' "$CANARY" > "$HOST_CANARY_DIR/.ssh/id_ed25519"
printf 'WIZARD_SERVICE_SECRET=%s\n' "$CANARY" > "$HOST_CANARY_DIR/controlplane-secrets.env"
HOST_PATHS=$(python3 -c 'import json,sys;h=sys.argv[1];print(json.dumps([h+"/canary.txt",h+"/.ssh/id_ed25519",h+"/controlplane-secrets.env","/tmp/host-home/canary.txt","/tmp/host-home/.ssh/id_ed25519","/tmp/control-plane/secrets.env"]))' "$HOST_CANARY_DIR")

DC=(docker compose -f "$HERE/compose.yml" -f "$HERE/conformance/compose.test.yml" -p "$AGENT_PROJECT")
cleanup() {
  "${DC[@]}" down -v --remove-orphans > /dev/null 2>&1 || true
  rm -rf "$HOST_CANARY_DIR"
  python3 "$HERE/conformance/redact.py" "$OUT" "$CANARY" "$TOKEN" "$AGENT_API_KEY" || true
}
trap cleanup EXIT

wait_ready() {
  for _ in $(seq 1 90); do
    code=$("${DC[@]}" exec -T fake-service python3 - "$INGRESS_SOCKET" --health < "$HERE/conformance/ingress_probe.py" 2>/dev/null || true)
    if [ "$code" = "200" ]; then echo "agent API healthy over ingress socket (200)"; return 0; fi
    sleep 2
  done
  echo "agent API not ready" >&2; return 1
}

phase() {
  local name="$1"
  wait_ready
  local since=$(( $(date +%s) - 5 ))
  echo "== phase $name"
  "${DC[@]}" exec -T -e CONF_CANARY_REV="$(printf '%s' "$CANARY" | rev)" -e CONF_TOKEN="$TOKEN" -e CONF_HOST_PATHS="$HOST_PATHS" \
      -e CONF_PHASE="$name" -e CONF_HOST_PORT="$CONF_HOST_PORT" \
      agent /opt/hermes/.venv/bin/python - < "$HERE/conformance/in_agent.py" > "$OUT/$name.json"
  python3 "$HERE/conformance/inspect_check.py" "$AGENT_PROJECT" "$INGRESS_SOCKET" "$AGENT_API_KEY" > "$OUT/$name-inspect.json"
  # The stand-in service's log lives in its tmpfs: capture it now, before restart/recreate wipes it.
  "${DC[@]}" exec -T fake-service cat /tmp/requests.jsonl > "$OUT/$name-service-requests.jsonl"
  "${DC[@]}" logs --no-color > "$OUT/$name-compose-logs.txt" 2>&1
  # Gate decisions made during this phase only: the summary requires the refusals to be attributable.
  "${DC[@]}" logs --no-color --no-log-prefix --since "$since" egress edge > "$OUT/$name-gate-logs.txt" 2>&1
  python3 "$HERE/conformance/summarize.py" phase "$OUT" "$name"
}

echo "project=$AGENT_PROJECT receipts=$OUT"
python3 "$HERE/conformance/inspect_check.py" --selftest > "$OUT/inspect-selftest.json" || true
python3 "$HERE/conformance/egress_selftest.py" > "$OUT/egress-selftest.json" || true
"${DC[@]}" build -q 2>&1 | tail -3
"${DC[@]}" up -d 2>&1 | tail -3
phase initial
"${DC[@]}" restart 2>&1 | tail -2
phase restart
"${DC[@]}" down 2>&1 | tail -1          # containers removed, home volume kept
"${DC[@]}" up -d 2>&1 | tail -2
phase recreate

# Teardown, verified.
"${DC[@]}" down -v --remove-orphans 2>&1 | tail -1
rm -rf "$HOST_CANARY_DIR"
python3 - "$AGENT_PROJECT" "$HOST_CANARY_DIR" > "$OUT/teardown.json" <<'PY'
import json, os, subprocess, sys
project, canary_dir = sys.argv[1:]
f = f"label=com.docker.compose.project={project}"
left = {kind: subprocess.check_output(["docker", *cmd, "-q", "--filter", f], text=True).split()
        for kind, cmd in (("containers", ["ps", "-a"]), ("volumes", ["volume", "ls"]), ("networks", ["network", "ls"]))}
left["host_canary_dir_exists"] = os.path.exists(canary_dir)
print(json.dumps({"clean": not any(left.values()), "left": left}))
PY
python3 "$HERE/conformance/summarize.py" final "$OUT" "$CANARY"
