#!/usr/bin/env bash
# Full verification entrypoint for a disposable remote Docker host. No host bind mounts are needed.
# Stream source into a Docker-managed volume: works with checkouts outside Colima's default HOME share.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:?usage: verify_socket_gateway.sh receipts-dir}"
mkdir -p "$OUT"
NAME="was-socket-tests-$$"
cleanup() {
  docker rm -f "$NAME" > /dev/null 2>&1 || true
  docker volume rm "$NAME" > /dev/null 2>&1 || true
}
trap cleanup EXIT
cd "$ROOT"
docker volume create "$NAME" > /dev/null
docker create --name "$NAME" -v "$NAME:/work" -w /work \
  -e TMPDIR=/scratch -e HERMES_HOME=/scratch/hermes -e WIZARD_OS_HOME=/scratch/os \
  node:22-alpine sh -lc 'set -eu; apk add --no-cache python3 bash; mkdir -p /scratch/hermes /scratch/os; npm ci --ignore-scripts --no-audit --no-fund; npm test; python3 ops/agent-runtime/test_agent_runtime.py' > "$OUT/unit-container.txt"
tar --exclude=.git --exclude=node_modules --exclude=__pycache__ --exclude='.env*' -cf - . | docker cp - "$NAME:/work"
docker start -a "$NAME" > "$OUT/full-suite.log" 2>&1
[ "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")" = 0 ] || { printf 'unit container failed; see full-suite.log\n' >&2; exit 1; }
cleanup
trap - EXIT
bash ops/agent-runtime/test_agent_sockets.sh "$OUT/socket-isolation"
bash ops/agent-runtime/restricted-agent/conformance/run.sh "$OUT/dispatcher-conformance"
printf 'full suite + socket isolation + dispatcher conformance passed\n'
