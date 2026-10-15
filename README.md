# Wizard Agent Service

The back end that Wizard front ends talk to. It runs on the Wizard's host, sits in front of Hermes Agent, and owns everything a Wizard client needs beyond the raw agent:

- **Threads**: session listing, history and paging, built from Hermes's own session database (`session-truth.mjs`)
- **Runs and steers**: a durable run queue with a cap on concurrent threads, steering a live run, and approval decisions (`run-queue.mjs`)
- **Files**: uploads, attachments and agent-made artifacts, with private-path projection so host paths never reach the client
- **Read state**: thread-seen, dismissed failures, and thread dispositions (deferred, archived)
- **Voice**: transcription passthrough and recovery receipts for voice notes interrupted mid-send
- **AI usage**: per-thread model and cost readout
- **Access**: loopback-only listener, plus optional Cloudflare Access JWT verification

## Where it sits in Wizard OS

```
Wizard UX (wizard-ux)         legacy Wizard Mobile (wizard-mobile)
        │  /wizard/...                 │  /wizard/...
        └──────────────┬───────────────┘
                       ▼
            Wizard Agent Service  (this repo)
                       │  Hermes API server + read-only state.db
                       ▼
                 Hermes Agent
```

**Wizard OS** is the whole system. The **Wizard Agent Service** is one Service in it. **Wizard UX** is the active View (front end). **Legacy Wizard Mobile** is the previous View, kept as a porting reference.

## Origin

This code was extracted from `humanitylabs-org/wizard-mobile` (`server/`, branch `james/stable` at `ed8407b`), with its git history preserved. The `server/` copy in `wizard-mobile` stays in place until front ends are switched over, so nothing deployed changes because this repo exists.

## Run

```bash
npm ci
npm test                       # Service Vitest suites
node --test tests/locked-run-bridge.test.mjs  # native locked-route regressions (node:test)
npm run fixture                # deterministic fake Hermes + service on a random port
cp ops/wizard-mobile.env.example .env.local   # fill in, then:
npm run start:local
```

Requires Node 22.5 or later, because it uses the built-in `node:sqlite` module.

### Configuration

Tailscale source inclusion is not activation. Read [the activation and immutable-release gates](docs/tailscale-activation.md) before setting auth environment variables; the current Serve → nginx → Service identity provenance remains unproven.

| Variable | Default | Purpose |
|---|---|---|
| `WIZARD_HERMES_API_KEY` | required | Key for the Hermes API server |
| `HERMES_ORIGIN` | `http://127.0.0.1:8642` | Hermes API server |
| `WIZARD_HOST` / `WIZARD_PORT` | `127.0.0.1` / `8787` | Listener (loopback only) |
| `WIZARD_AUTH_MODE` | see right | `tailscale` (Tailscale Serve identity, the Wizard OS default), `cloudflare` (Access JWTs) or `none` (box-only, behind a gateway that checks identity). Unset: `tailscale` when `WIZARD_TAILNET_ORIGIN` is set, else from `WIZARD_REQUIRE_CF_ACCESS` |
| `WIZARD_TAILNET_ORIGIN` / `WIZARD_TAILNET_LOGIN` | — | Tailscale mode: the exact `https://<box>.<tailnet>.ts.net[:port]` origin Serve publishes, and the owner's Tailscale login (comma list allowed). Only requests from the Serve proxy (loopback, or the container gateway in a Wizard OS container) are trusted; never use Funnel |
| `WIZARD_REQUIRE_CF_ACCESS` | `1` | Older switch: `0` means no access check (same as `WIZARD_AUTH_MODE=none`) |
| `WIZARD_STATIC_DIR` | `.ui-live` | Optional static front end to serve at `/wizard/` |
| `WIZARD_HERMES_STATE_PATH` | unset | Optional explicit Hermes session database (read-only); never inferred from the host home |
| `WIZARD_STT_ORIGIN` | `http://127.0.0.1:8864` | Voice-to-text |
| `WIZARD_INBOX_*` | see `ops/` | Wizard Files (uploads) |
| `WIZARD_UPLOAD_RESERVE_BYTES` | `5368709120` (5 GiB) | Resumable uploads (`/wizard/v1/uploads`, `/wizard/v1/shares`) are refused with 507 when a file would leave less free disk than this |
| `WIZARD_UPLOAD_MAX_BYTES` | `0` (disk-bound only) | Optional per-file cap for resumable uploads |
| `WIZARD_UPLOAD_STATE_PATH` / `WIZARD_UPLOAD_STAGING_DIR` | under `~/.hermes/state/wizard-mobile/` | Upload/share records; staging for the Wizard Inbox backend (a Wizard OS box stages in `<media>/.wizard-uploads`) |
| `WIZARD_*_STATE_PATH` | under `~/.hermes/state/wizard-mobile/` | Read state, dispositions, run queue, voice recovery |

Every variable is listed in `server/index.mjs`. `ops/` has a hardened systemd unit and an env template. Their `wizard-mobile` file names are kept for now so existing deployments keep matching them.

## Open items for the split

1. **Static front end.** The service can still serve a built front end (`WIZARD_STATIC_DIR`), which is how legacy Wizard Mobile is deployed today. Decide whether that stays as an option or whether front ends always run as their own Views.
2. **Helm reads.** `WIZARD_HELM_*` remain only for legacy thread-ID mapping. Helm is retired, so they can be removed.
3. **State paths and names.** `~/.hermes/state/wizard-mobile/` and the unit name should become `wizard-agent-service` with a one-time migration.
4. **API contract.** Write down the `/wizard/...` endpoints Wizard UX uses as the versioned contract (sessions, runs, steer, files, thread-seen, thread-dispositions, voice).
5. **Cutover.** Point the live service at this repo, then delete `server/` from `wizard-mobile` and make its front end depend on this service.

## Thread subjects (`server/thread-subjects.mjs`)

Ready's *By subject* order groups threads by the `subject` in each reply's hidden status line. Every run is told what a subject is (a product, sustained project or life area; never a single feature, meeting or one-off). An install can pin its own short list in `~/.wizard-os/subjects.json` (override: `WIZARD_SUBJECTS_PATH`): `subjects` (name + one-line about, sent to every run), `aliases` (older or stray names folded into a listed one when the session list is served) and `threads` (a one-off correction for one thread, applied only while the agent's subject is still `from`). The file is re-read on change; no file means subjects pass through as written.

## Stock Hermes and Wizard OS settings (branch `feature/stock-hermes`)

- **Works with unmodified Hermes.** `WIZARD_JOINED_DELEGATION=prefer|require|off` (default `require` keeps today's strict behaviour; new installs use `prefer`). With `prefer`, the service uses joined delegation and Markdown rendering when Hermes advertises them in `/v1/capabilities`, and sends a plain run otherwise.
- **Delegation follow-through.** Stock Hermes finishes `delegate_task` work after the run and saves the result into the thread for the next turn. When Hermes does not join delegated work, the service starts that next turn itself (once per result). The native model-locked lane is detached even when regular runs join, so its threads remain eligible. `WIZARD_FOLLOW_THROUGH=off` disables all automatic continuations on secondary/preview instances.
- **Optional live recovery adapter.** An explicit `WIZARD_HERMES_STATE_PATH` enables recovery of dropped/pending helper receipts, shared delegation-identity deduplication, owner gates, lease checks, and persisted selector locks. Without that mount, the portable HTTP finder remains available and never opens a host state database; dropped receipts absent from the HTTP transcript cannot be recovered. A no-state locked continuation retains the last admitted send's exact model/provider. Existing clients without an explicit send-time lock inherit selector locks only when the state adapter is configured.
- **Locked sends fail closed.** Locked admission uses Hermes's native session chat stream and verifies the selected runtime acknowledgement, with no fallback endpoint/provider. A stock agent lacking that native locked-route contract rejects locked sends; normal unlocked stock-agent runs retain their existing API path.
- **Wizard OS settings.** `GET /wizard/v1/bootstrap` returns `~/.wizard-os/settings.json` (owner, agent name, clock, voice vocabulary) and what this box can do; `GET /wizard/v1/apps` merges `apps.json` with the owner's `launcher.json`. Spec: `wizard-os/spec/SETTINGS_AND_BOOTSTRAP.md`.
- **Optional orb router.** `POST /wizard/v1/route` when `WIZARD_ROUTER_URL` + `WIZARD_ROUTER_MODEL` point at any OpenAI-compatible chat endpoint.
- **Serves Wizard UX.** `WIZARD_UX_DIR=/path/to/wizard-ux/web` (+ `WIZARD_UX_PREFIX`, default `wizard-os-home`) serves the UX from the same origin as the API: one service, one address.
- **Voice is honest.** `voice` in bootstrap is true only while the transcription service answers its health check.

Tested 9 Oct 2026 on a fresh Ubuntu 24.04 VM with upstream Hermes `0670ba4524`: UX boots neutral, send → reply, thread listed, delegated work completes through follow-through (`tests/` 166 passing).
