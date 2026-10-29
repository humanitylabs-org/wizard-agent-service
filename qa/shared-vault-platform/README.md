# Shared Vault combined staging runner

This is disposable Forum-only fixture QA, not an installer or a production auth proxy.
Run only via the parent's durable Forum job; never against real provider credentials,
existing private homes, or production. `dependencies.json` pins the app source.

## Socket bootstrap repair

The failed combined run used an output below a full source SHA. Its agent gateway
path was **117 bytes**. `server/agent-sockets.mjs` intentionally rejects paths over
103 bytes with `agent_socket_path_too_long`; the fixture then exited before its
owner listener opened. Waiting for the socket file hid that exception after Docker
cleanup. This was a fixture path defect, not an incompatible runtime source seam.

Keep source checkouts revision-specific, but choose a **fresh short real output
path**, such as `/srv/work/svr-<revision-prefix>-<nonce>`. No symlink aliases. The
runner preflights the owner listener, app sockets, and runtime gateway/ingress
paths before building images or creating resources. The Service still awaits
`agentSocketsReady` before listening. Readiness now notices Service/proxy exit
instead of waiting out a missing socket.

On failure, `failure-diagnostics.json` is written **before** container teardown. It
contains only each fixture container's State and last 60 log lines (at most 8 KiB
characters per field), available owner-proxy stderr, and the last four sanitized
command failures. Each diagnostic command is bounded to 64 KiB/8 seconds. Known
fixture authority, handles, bearer credentials, synthetic fixture secrets and
private keys are removed before persistence. No inspect Config/environment or
private-home dump is collected. The report is mode 0600; cleanup and remnant
checks still run. Keep the output directory private because its other fixture
files intentionally hold disposable authority.

## Fast regressions

`npm run test:shared-vault-platform` runs without Docker/browser/provider:

- The exact exported staging Service bootstrap reproduces the rejected 117-byte
  gateway path through the real registry and socket gateway.
- A short disposable root creates both agent sockets before the owner listener,
  checks uid and private directory/socket modes, checks anonymous refusals, and
  repeats after a real Service shutdown/restart.
- Runner tests cover pre-build path refusal, byte lengths, immediate process-exit
  detection, bounded real subprocess stderr/timeout capture, and redaction.
- Existing owner-route and app-socket runtime-security contracts remain mandatory.

These checks do **not** replace combined Docker/installed-runtime acceptance. The
packaged private-browser fixture's positive workflow is useful synthetic evidence,
but is not a real provider or a real installed owner's useful login/task workflow.
Provider consent, WAM install lifecycle, useful real installed workflow and
production activation remain explicitly unaccepted.
