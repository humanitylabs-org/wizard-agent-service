#!/usr/bin/env bash
# Regenerate the WAM-written apps.json scenarios used by tests/browser-adapters-wam.test.ts.
# Uses the REAL App Manager registry writer and browser-grants CLI (wizard-app-manager
# tools/browser_admission_fixture.py), never a hand-written projection. Synthetic data only.
#   tests/fixtures/browser-trust/wam/generate.sh <wizard-app-manager checkout>
set -euo pipefail
WAM=${1:?wizard-app-manager checkout}
OUT=$(cd "$(dirname "$0")" && pwd)
PY=${PYTHON:-python3}
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
tool() { "$PY" "$WAM/tools/browser_admission_fixture.py" "$T/box" "$@" >/dev/null; }
snap() { cp "$T/box/home/apps.json" "$OUT/$1.json"; }
tool install notifications --repo oscarhenrycollins/notifications --port 18810; snap declared
tool grant notifications notifications.list notifications.mark_read; snap granted
tool revoke notifications notifications.mark_read; snap revoked-mark
tool grant notifications notifications.mark_read
tool update notifications --repo oscarhenrycollins/notifications --commit "$(printf 'd%.0s' {1..40})" --port 18810; snap updated
tool update notifications --repo humanitylabs-org/notifications --commit "$(printf 'd%.0s' {1..40})" --port 18810; snap source-changed
tool update notifications --repo oscarhenrycollins/notifications --commit "$(printf 'd%.0s' {1..40})" --port 18810 --provides notification-archive; snap provider-changed
tool update notifications --repo oscarhenrycollins/notifications --commit "$(printf 'd%.0s' {1..40})" --port 18810; snap restored
tool uninstall notifications; snap uninstalled
tool install notifications --repo oscarhenrycollins/notifications --port 18810; snap reinstalled
# Duplicate publishers of `profiles`: one installed from Oscar's repo, granted, then switched to the org repo.
tool install profiles --repo oscarhenrycollins/profiles --provides profiles --port 18811
tool grant profiles state.local; snap profiles-oscar
tool update profiles --repo humanitylabs-org/profiles --provides profiles --port 18811; snap profiles-org
git -C "$WAM" rev-parse HEAD > "$OUT/WAM_COMMIT"
echo "wrote $(ls "$OUT"/*.json | wc -l) scenarios from WAM $(cat "$OUT/WAM_COMMIT")"
