# Synthetic expired-sign-in recovery

Owner contract: a dead Claude login fails normal chat visibly. It must never silently switch to ChatGPT, another model or another provider. Keep the saved request and its model lock; after a diagnosed sign-in is restored, resend once automatically on the same model. Undiagnosed errors keep normal Retry. Only the independent Troubleshooter repair conversation may use another connected repair engine.

## Reuse
- chat and transcript: REUSE WizCore Chats and WizLive
- retained send and Retry: REUSE WosOutbox and WosChatPower
- recovery app window: REUSE WosBoundView and WizLinks
- connection page appearance in this synthetic rig: REUSE WizardApp.theme.get / onChange via app-client.js

## Scope
`provider-signin-flow-preview.mjs` serves the named candidate Wizard shell, the actual Agent Service and a loopback proxy to an independently running real Troubleshooter. Its upstream fixture permits only synthetic Claude Opus admissions. Both ordinary and native model-locked chat streams are simulated, with explicit provider/model receipts. No provider API runs. The separate Troubleshooter uses synthetic Claude/Codex executables; its agent-reply probe targets the rig's fake loopback Hermes endpoint. The only sign-in mutation is a boolean marker inside the isolated state directory.

The stand-in `/wizard-claude/` page is labelled STAGING, never reads an account, and has a single Sign in action. Normal chat has zero model executions before this action; only the bounded automatic resend after sign-in records a simulated Opus execution. `/__preview/receipt` exposes these assertions. No real app upstream is proxied. Manual Troubleshooter actions, internal tools and guardian admission are not exposed by the preview front.

## Setup
Use committed detached clones outside temporary test roots. Set `PREVIEW_WEB` to the immutable shell web directory and `PREVIEW_STATE` to a dedicated directory under `wizard-stage`. Run:

```
node scripts/prepare-signin-flow-state.mjs "$PREVIEW_STATE"
PORT=9502 PREVIEW_TROUBLESHOOT_PORT=9505 node scripts/provider-signin-flow-preview.mjs
```

Run the actual Troubleshooter as a separate enabled service with its own loopback `PORT=9505`, `TROUBLESHOOT_STATE=$PREVIEW_STATE/troubleshooter`, and `TROUBLESHOOT_DEV_NO_AUTH=1` behind the owner-authenticated private staging gateway. Set **both processes'** HOME and WIZARD_OS_HOME to isolated homes, not owner homes. Set the following explicit Troubleshooter environment (never load a live EnvironmentFile):

- `HOME=$PREVIEW_STATE/home`, `HERMES_HOME=$PREVIEW_STATE/home`, `WIZARD_OS_HOME=$PREVIEW_STATE/os`
- `CLAUDE_CONFIG_DIR=$PREVIEW_STATE/claude`, `CLAUDE_BIN=$PREVIEW_STATE/bin/claude`
- `CODEX_HOME=$PREVIEW_STATE/codex`, `CODEX_BIN=$PREVIEW_STATE/bin/codex`
- `CLAUDE_AGENT_AUTH_FILE=$PREVIEW_STATE/empty-auth.json`, `CHATGPT_AUTH_FILE=$PREVIEW_STATE/empty-auth.json`
- `HERMES_ENV_FILE=$PREVIEW_STATE/absent.env`, `API_SERVER_KEY=synthetic-only-key`
- `WIZARD_APPS_FILE=$PREVIEW_STATE/apps.json`, `TS_SOCKET=$PREVIEW_STATE/absent.sock`
- `AGENT_PORT=9502`, `HERMES_PORT=9502`, `SHELL_PORT=9502`, `GATEWAY_PORT=9502`
- `DOCKER_BIN=/bin/false`, `TINFOIL_URL=http://127.0.0.1:9`, `TINFOIL_TOKEN_FILE=$PREVIEW_STATE/no-tinfoil`
- Empty AUTH_PORT, TAILSCALE_UNIT, GATEWAY_UNIT, SHELL_CONTAINER, AGENT_UNIT and HERMES_UNIT; use absent staging-only WAS_RELEASE_ROOT and WAS_DEPLOY_BIN.

ProtectSystem=strict plus ReadWritePaths restricted to the synthetic state protects the read-only real Troubleshooter checkout. The shell's box-wide workspace sync is disabled in this fixture: another tester's saved desk must not override the review deep link.

To reset the scenario, stop **both staging units**, remove only their exact synthetic state directory, recreate it with the preparation script, then start both and read back the HTTPS receipt (`signedIn:false`, empty admissions/modelRuns). Never remove or modify real Claude, Codex or Hermes authentication.

## Verification
On the Linux worker, run `qa/diagnosed-signin-flow.mjs` with PREVIEW_ORIGIN set to the real private staging origin, PLAYWRIGHT_MODULE pointing to its installed Playwright, QA_EVIDENCE to a durable evidence directory, and QA_SKIN=nebula or signal. Use a fresh synthetic backend for each scenario.

The runner uses a phone user agent and 393x852 touch viewport. It preserves phone Send-and-go, reopens the diagnosed card, checks no Retry or model switch, checks its explanation once and the matching Sign in list action, opens the focused repair screen, signs in synthetically and walks actual joint iframe/browser Back history. Confirmation waits for the automatic same-model resend; Back to chat shows its normal reply without another send action. It asserts zero HTTP 403s, zero page errors, one tab during the flow, exactly two admissions and one Claude Opus model execution. Seven screenshots per skin and machine-readable receipts are produced. A separate page then checks the undiagnosed screen and the Something else is wrong escape.

The Troubleshooter arrival request must not carry an empty trailing question mark: private identity rewrites can preserve it as `/verify?`. This is regression-tested in the Troubleshooter itself. Allow same-origin scripts in its CSP so the private staging marker can load. Do not weaken private gateway identity checks to make a demo pass.
