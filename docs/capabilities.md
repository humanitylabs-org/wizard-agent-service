# Capability registry and install guard (issue 463)

On for everyone. James said yes at show-and-tell, so the `wizard/capability-registry` switch and the
`WIZARD_CAPABILITY_REGISTRY` env knob were removed; a value the old switch left in the Look file is ignored.

## Why

Every discovery path an agent had (the kernel, the `wizard-job-*` pointer skills, `wizard_apps`) was built from
apps.json, so the Agent Service's own built-ins (`wizard_transcribe`, `wizard_remind`, `wizard_schedule`, ...) and host
services such as the Wizard Voice Service were invisible. Asked "can you transcribe audio?", a standard agent found no
tool, pip-installed faster-whisper and a speech model into its own home, and told the owner the box had no
transcription.

## What it does

`server/capabilities.mjs` builds one registry per agent at call time, from exactly what the gateway serves that agent:

| Source | Records | Status |
|---|---|---|
| Gateway built-ins served to the agent | transcription (`wizard_transcribe`, provider `host-service` Wizard Voice Service), reminders, scheduling, follow-ups, new threads, spaces, devices, tips | `ready`; transcription reads `unavailable` while the voice service's health is not ready |
| Apps the agent may use | one record per `provides` job, tool `<app>__*`, docs `wizard-job-<job>` | `ready`, or `unavailable` while the app isn't running |
| Non-private installed apps the agent may not use | the same, with `ask`: "Ask the owner to allow <App> for <Agent> in Connections" | `not-granted` |

Private agents keep the seal: no transcription (the shared voice service keeps owner buffers) and no not-granted
names. Built-in records carry `words` and `equivalents`, the package, model and repo names the guard treats as a
second copy (`whisper`, `faster-whisper`, `vosk`, `Systran/faster-whisper-*` mean transcription).

- **`wizard_capabilities`** (gateway tool). With no arguments it returns the index. With `job` (a job name or the owner's
  words) it returns the tool, inputs, an example, limits and how to call it. When nothing matches, the answer says so
  plainly and the gap is recorded (ask words + agent id, never content; newest 200 kept in
  `<wizard-os home>/capabilities.json`). `format: json` returns the registry as data for the guard.
- **Kernel.** The hand-written line "Prefer Wizard tools to installing software; never install speech models." and
  the `wizard_apps` line become one generated line, `Built in: <jobs>. For "what can you do?" and before installing
  software or downloading a model, call wizard_capabilities.`. The job list is capped so the fixed kernel stays within
  1300 characters. Twins: `renderKernel` (server/agent-bridge.mjs) and `render_kernel` (hermes-plugin/wizard-os/kernel.py),
  kept byte-identical by tests/capabilities.test.ts. The main agent's plugin gets the job list from its own gateway.
- **Routed agents** (host-profile, container, restricted) get no kernel, so their run note carries the same index line.
- **Install guard** (`capability_guard.py`, the same file in `hermes-plugin/wizard-os` and
  `hermes-plugin/wizard-supervisor-tools`, which every managed agent already loads; a stock `pre_tool_call` hook, no
  Hermes change). It reads the registry through the agent's own `wizard` gateway and key. It refuses `terminal` and
  `execute_code` calls that install (pip, uv, pipx, poetry, conda, npm, yarn, pnpm, bun, apt, brew, cargo, gem), download
  a model (Hugging Face CLI or URL, `git clone` of a model repo, `ollama pull`) or load a known duplicate, and only when
  the name matches a capability the box has. The refusal names the tool to use (for `not-granted`, the ask for the
  owner; for `unavailable`, "tell the owner"). Everything else runs, and so does everything while the gateway can't be
  reached or has no registry (an older Agent Service).
- **Owner route** `GET /wizard/v1/capabilities`: what the main agent finds, the gaps, and the agents whose guard is off.
  `PATCH {"agent": "<id>", "guard": false|true}` turns the guard off or back on for one agent. It is gated like the
  other owner settings routes (404 only when the Service runs without the agent bridge).

`wizard_apps` is unchanged. Shells and harnesses that call it keep working.

## Tests

- `tests/capabilities.test.ts`: kernel twins, registry rules, the Python guard (refuses faster-whisper with a pointer to
  `wizard_transcribe` and lets pandas through), and the two guard copies staying identical.
- Parity check `capability-registry` (`qa/agent-parity`): every agent kind through its own gateway transport, with a stored
  off value of the old switch in the Look file (it changes nothing).
