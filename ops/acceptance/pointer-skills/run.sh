#!/usr/bin/env bash
# Pointer-skill acceptance on a fresh disposable KVM VM (Linux/amd64 build host). See README.md.
#
#   MODEL_KEY_FILE=<0600 file with the model API key> ops/acceptance/pointer-skills/run.sh <work dir> <wam source dir>
#
# The candidate Agent Service source is this checkout. Env: MODEL (default deepseek-v4-1-flash), BASE_URL (default
# Tinfoil's OpenAI-compatible endpoint), TRIALS (default 3), HERMES_IMAGE / PY_IMAGE (pinned by digest),
# KEEP_VM=1 to leave the VM. Writes <work>/runs/<UTC stamp>/{results.json,RECEIPT.md,run.log,evidence/}.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "$HERE/../../.." && pwd)
WORK=$(mkdir -p "${1:?work dir}" && cd "$1" && pwd)
WAM=$(cd "${2:?wam source dir}" && pwd)
KEY=${MODEL_KEY_FILE:?MODEL_KEY_FILE}
MODEL=${MODEL:-deepseek-v4-1-flash}
BASE_URL=${BASE_URL:-https://inference.tinfoil.sh/v1}
TRIALS=${TRIALS:-3}
# Hermes v2026.9.24, the upstream release pinned in wizard-os releases (hermes.image.digest).
HERMES_IMAGE=${HERMES_IMAGE:-docker.io/nousresearch/hermes-agent@sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7}
PY_IMAGE=${PY_IMAGE:-python@sha256:1b668429b3511ab407d8e00648891631b0b1a4d7e15e3ca70f38ab5b91ad4ab4}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RUN=$WORK/runs/$STAMP
VM=ps-$(echo "$STAMP" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9' | tail -c 10)
export LIMA_HOME=$WORK/lima
mkdir -p "$RUN/harness" "$LIMA_HOME"
cp "$HERE"/{check.py,fake_app.py} "$RUN/harness/"
cp -r "$HERE/app-skill" "$RUN/harness/"
exec > >(tee -a "$RUN/run.log") 2>&1
echo "run $STAMP vm $VM host $(hostname) candidate $(git -C "$SRC" rev-parse HEAD) wam $(git -C "$WAM" rev-parse HEAD 2>/dev/null || echo '?')"

cat > "$RUN/harness/lima.yaml" <<YAML
vmType: qemu
arch: x86_64
cpus: 4
memory: 8GiB
disk: 30GiB
images:
  - location: https://cloud-images.ubuntu.com/releases/noble/release/ubuntu-24.04-server-cloudimg-amd64.img
    arch: x86_64
mounts:
  - location: "$RUN"
    writable: true
  - location: "$SRC"
    writable: false
  - location: "$WAM"
    writable: false
containerd:
  system: false
  user: false
provision:
  - mode: system
    script: |
      set -eux
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y docker.io docker-buildx python3-yaml sqlite3 curl
      systemctl enable --now docker
YAML
limactl create --tty=false --name "$VM" "$RUN/harness/lima.yaml"
cleanup() { [ "${KEEP_VM:-0}" = 1 ] || { limactl stop -f "$VM" >/dev/null 2>&1; limactl delete -f "$VM" >/dev/null 2>&1; }; }
trap cleanup EXIT
limactl start --tty=false --timeout 20m "$VM"
vm() { limactl shell --workdir / "$VM" sudo "$@"; }
vm sh -c 'until docker info >/dev/null 2>&1; do sleep 2; done; docker version --format "docker {{.Server.Version}}"; uname -a'

set +e
vm python3 "$RUN/harness/check.py" --was-src "$SRC" --wam-src "$WAM" --hermes-image "$HERMES_IMAGE" --py-image "$PY_IMAGE" \
  --model "$MODEL" --base-url "$BASE_URL" --trials "$TRIALS" --out "$RUN" < "$KEY"
rc=$?
set -e
python3 - "$RUN" "$VM" "$(hostname)" "$(git -C "$SRC" rev-parse HEAD)" <<'PY'
import json, sys, pathlib
run, vm, host, sha = sys.argv[1:]
p = pathlib.Path(run, "results.json")
r = json.loads(p.read_text()) if p.exists() else {"checks": []}
ok = bool(r["checks"]) and all(c["pass"] for c in r["checks"])
lines = [f"# Pointer-skill acceptance — {'PASS' if ok else 'FAIL'}", "",
         f"- Agent Service candidate: `{sha}` (built in the VM, image {r.get('was_image_id', '?')})",
         f"- Hermes: `{r.get('hermes_image')}` ({r.get('hermes_version')}), stock",
         f"- Model: `{r.get('model')}`; prompt: \"{r.get('prompt')}\"",
         f"- Fresh KVM VM `{vm}` on `{host}`, {r.get('started')} → {r.get('finished')}", ""]
for c in r["checks"]:
    lines.append(f"- {'PASS' if c['pass'] else 'FAIL'} — {c['check']}: {c['detail']}")
lines.append("")
for t in r.get("trials", []):
    lines.append(f"## {t.get('phase')} {t.get('trial', '')}".rstrip())
    lines.append(f"- tool calls: {[c.get('name') for c in t.get('tool_calls', [])]}")
    lines.append(f"- reply: {t.get('final_reply', '')[:600]!r}")
    lines.append("")
pathlib.Path(run, "RECEIPT.md").write_text("\n".join(lines) + "\n")
print("\n".join(lines))
PY
exit $rc
