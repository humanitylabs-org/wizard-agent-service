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
# Listener credential (wizard-os #386): the installed compose takes WIZARD_APP_CREDENTIAL, so WAM mints one.
tool update notifications --repo oscarhenrycollins/notifications --commit "$(printf 'd%.0s' {1..40})" --port 18810 --listener-auth
tool grant notifications notifications.list notifications.mark_read; snap listener-auth
# Card 2: the real Notifications screens' contract (inbox + mark). NOTIFICATIONS_WIZARD_MD = the app checkout's
# own wizard.md; without it, a copy of its browser_contract on a minimal manifest.
MD=${NOTIFICATIONS_WIZARD_MD:-}
if [ -z "$MD" ]; then
  MD="$T/wizard.md"
  printf -- '---\nid: notifications\nname: Notifications\ntype: service\nversion: 1.0.0\nprovides: [notifications]\nview: {path: /notifications/, port: 8080}\nbrowser_contract:\n  version: 1\n  isolation: opaque\n  operations: [notifications.inbox, notifications.mark]\n---\n' > "$MD"
fi
tool uninstall notifications   # start clean: no listener-auth compose left from the scenario above
tool install notifications --repo oscarhenrycollins/notifications --port 18810 --wizard-md "$MD"; snap card2-declared
tool grant notifications notifications.inbox; snap card2-inbox-only
tool grant notifications notifications.mark; snap card2-granted
tool revoke notifications notifications.mark; snap card2-revoked-mark
# Card 3 media (ADAPTER-SKETCH §6): the app's contract plus notifications.media, with a listener credential.
MEDIA_MD="$T/wizard-media.md"
sed 's/operations: \[notifications.inbox, notifications.mark\]/operations: [notifications.inbox, notifications.mark, notifications.media]/' "$MD" > "$MEDIA_MD"
grep -q 'notifications.media' "$MEDIA_MD"
tool install notifications --repo oscarhenrycollins/notifications --port 18810 --wizard-md "$MEDIA_MD" --listener-auth
tool grant notifications notifications.inbox notifications.mark notifications.media; snap media-granted
tool revoke notifications notifications.media; snap media-revoked
# Shell intents (wizard-os spec/browser-trust-shell-intents): the ChatGPT and Claude connection apps' own contracts
# (CHATGPT_WIZARD_MD / CLAUDE_WIZARD_MD = the app checkouts' wizard.md), each with a listener credential.
CG_MD=${CHATGPT_WIZARD_MD:-}; CL_MD=${CLAUDE_WIZARD_MD:-}
if [ -z "$CG_MD" ]; then
  CG_MD="$T/chatgpt.md"
  printf -- "---\nid: wizard-chatgpt\nname: ChatGPT\ntype: external\nversion: 1.0.0\nprovides: [ai-connection]\nview: {path: /, port: 8801}\nbrowser_contract:\n  version: 1\n  isolation: opaque\n  operations: [ai_accounts.inventory, ai_accounts.change, ai_accounts.progress, ai_accounts.step]\n  navigation:\n  - {id: signin, url: 'https://auth.openai.com/codex/device'}\n---\n" > "$CG_MD"
fi
if [ -z "$CL_MD" ]; then
  CL_MD="$T/claude.md"
  printf -- "---\nid: wizard-claude\nname: Claude\ntype: external\nversion: 1.0.0\nprovides: [claude-subscription]\nview: {path: /, port: 8799}\nbrowser_contract:\n  version: 1\n  isolation: opaque\n  operations: [ai_accounts.inventory, ai_accounts.change, ai_accounts.progress, ai_accounts.step, claude_code.status, claude_code.connect, claude_code.code, claude_code.cancel, claude_code.logout, claude_code.test]\n  navigation:\n  - {id: signin, url: 'https://claude.ai/oauth/authorize', query: [client_id, code, code_challenge, code_challenge_method, redirect_uri, response_type, scope, state]}\n---\n" > "$CL_MD"
fi
tool install wizard-chatgpt --repo oscarhenrycollins/chatgpt-connection --port 18820 --provides ai-connection --wizard-md "$CG_MD" --listener-auth
tool install wizard-claude --repo oscarhenrycollins/claude-connection --port 18821 --provides claude-subscription --wizard-md "$CL_MD" --listener-auth
tool grant wizard-chatgpt ai_accounts.inventory ai_accounts.change ai_accounts.progress ai_accounts.step
tool grant wizard-claude ai_accounts.inventory ai_accounts.change ai_accounts.progress ai_accounts.step claude_code.status claude_code.connect claude_code.code claude_code.cancel claude_code.logout claude_code.test; snap ai-granted
tool revoke wizard-chatgpt ai_accounts.change; snap ai-chatgpt-no-change
tool grant wizard-chatgpt ai_accounts.change
tool update wizard-chatgpt --repo oscarhenrycollins/chatgpt-connection --commit "$(printf 'e%.0s' {1..40})" --port 18820 --provides ai-connection --wizard-md "$CG_MD" --listener-auth; snap ai-chatgpt-updated
git -C "$WAM" rev-parse HEAD > "$OUT/WAM_COMMIT"
echo "wrote $(ls "$OUT"/*.json | wc -l) scenarios from WAM $(cat "$OUT/WAM_COMMIT")"
