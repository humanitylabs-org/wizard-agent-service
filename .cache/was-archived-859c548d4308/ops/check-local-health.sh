#!/usr/bin/env bash
set -euo pipefail

port="${WIZARD_PORT:-8787}"
response="$(curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:${port}/wizard/health")"
case "$response" in
  *'"status":"ok"'*'"upstream_reachable":'*) printf '%s\n' "$response" ;;
  *) printf '%s\n' "Unexpected Wizard health response." >&2; exit 1 ;;
esac
