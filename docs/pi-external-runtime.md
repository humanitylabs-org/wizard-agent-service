# Pi phase-one external runtime

REUSE: Agent Service's routed sessions/runs/models/SSE contract, per-run Wizard instructions and existing chat UI.
EXTEND: file-provisioned agent registry with the honest `harness: pi`, `runtime.kind: external` pair.
NEW: none in the shared UI. The separately packaged Pi SDK adapter owns its runtime and disk state.

## Admission

File provisioning only; the create/update/lifecycle APIs cannot turn a managed Hermes agent into an external process.
For schema-1 records, Pi must be standard (not private) and external, and the local integer port must be 1024–65535.
The external origin is always `http://127.0.0.1:<port>`, even in container-network mode. No supplied URL is used.
Store a dedicated adapter bearer in the agent's existing `runtime.key` file. Health probes include this bearer.

The Pi process runs on Forum, while the existing Agent Service runs on the VPS. An owner-user SSH systemd service
forwards VPS loopback 18659 to Forum loopback 18659, and Forum loopback 18811 back to the installed VPS ChatGPT
connection app on 18801. No public port, new paid provider, new login, or Hermes core change is required.

## Ownership boundaries

The Service never starts/stops/applies/upgrades an external process, writes it a Hermes home, exposes a local home
for its files, or writes assistant-only deliveries through the Hermes driver. These operations return
`external_agent_read_only`. App-sync and managed harness migration skip the external runtime.
The adapter advertises `run_steer: false`, `run_approval_response: false`, no skills/memory API, no tool progress,
no audio, and no delegation. Stop and streamed text are supported. Native Pi JSONL and adapter metadata persist
on Forum under `~/wizard-local/pi-agent/data`. There are no app, file, history-sharing or private-data grants.

## Release gate

This is a feature, not a fix. Do not deploy it directly onto the owner's live Agent Service.
Run the exact candidate in an isolated canary first, retain real through-Service acceptance evidence, then use
the normal staging release path before any owner-live promotion. The new Pi container can run additively on
Forum while the existing owner Agent Service remains unchanged. A config-only registration on the current
live release is NOT sufficient: its parser rejects `harness: pi`. Do not disguise Pi as a Hermes profile/import.

Regression test: `node --test tests/external-pi.node.mjs`; also run the existing profile, agents, privacy/principal,
app-binding and routed-chat suites. No new frontend view is introduced; verify the reused agent selector/chat
on the staging shell, including disabled steer/approval controls, before declaring owner access ready.
