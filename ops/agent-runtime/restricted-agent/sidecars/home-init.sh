#!/bin/sh
# One-shot home preparation for the restricted agent (runs as root with only CHOWN/FOWNER/DAC_OVERRIDE,
# no network). It does the part of the image's s6 bootstrap that needs root, so the agent itself never
# runs as root: give the home to uid/gid 10000 and seed a minimal config on first start.
set -eu
HOME_DIR=/opt/data
AGENT_UID=10000
AGENT_GID=10000

mkdir -p "$HOME_DIR/work" "$HOME_DIR/logs" "$HOME_DIR/skills"
if [ ! -f "$HOME_DIR/config.yaml" ]; then
  cat > "$HOME_DIR/config.yaml" <<'YAML'
# Seeded by restricted-agent home-init. The Agent Service manages this file after provisioning.
terminal:
  backend: local
  cwd: /opt/data/work
skills:
  external_dirs:
    - /opt/wizard-skills
YAML
fi
# Only re-own what is not already the agent's, so restarts stay cheap on large homes.
find "$HOME_DIR" \( ! -uid "$AGENT_UID" -o ! -gid "$AGENT_GID" \) -exec chown -h "$AGENT_UID:$AGENT_GID" {} +
chmod 700 "$HOME_DIR"
echo "home-init: ok"
