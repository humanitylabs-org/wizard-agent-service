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
npm test                       # 12 suites, 154 tests
npm run fixture                # deterministic fake Hermes + service on a random port
cp ops/wizard-mobile.env.example .env.local   # fill in, then:
npm run start:local
```

Requires Node 22.5 or later, because it uses the built-in `node:sqlite` module.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `WIZARD_HERMES_API_KEY` | required | Key for the Hermes API server |
| `HERMES_ORIGIN` | `http://127.0.0.1:8642` | Hermes API server |
| `WIZARD_HOST` / `WIZARD_PORT` | `127.0.0.1` / `8787` | Listener (loopback only) |
| `WIZARD_REQUIRE_CF_ACCESS` | `1` | Require Cloudflare Access JWTs; set `0` behind a Tailscale-only gateway |
| `WIZARD_STATIC_DIR` | `.ui-live` | Optional static front end to serve at `/wizard/` |
| `WIZARD_HERMES_STATE_PATH` | `~/.hermes/state.db` | Hermes session database (read-only) |
| `WIZARD_STT_ORIGIN` | `http://127.0.0.1:8864` | Voice-to-text |
| `WIZARD_INBOX_*` | see `ops/` | Wizard Files (uploads) |
| `WIZARD_*_STATE_PATH` | under `~/.hermes/state/wizard-mobile/` | Read state, dispositions, run queue, voice recovery |

Every variable is listed in `server/index.mjs`. `ops/` has a hardened systemd unit and an env template. Their `wizard-mobile` file names are kept for now so existing deployments keep matching them.

## Open items for the split

1. **Static front end.** The service can still serve a built front end (`WIZARD_STATIC_DIR`), which is how legacy Wizard Mobile is deployed today. Decide whether that stays as an option or whether front ends always run as their own Views.
2. **Helm reads.** `WIZARD_HELM_*` remain only for legacy thread-ID mapping. Helm is retired, so they can be removed.
3. **State paths and names.** `~/.hermes/state/wizard-mobile/` and the unit name should become `wizard-agent-service` with a one-time migration.
4. **API contract.** Write down the `/wizard/...` endpoints Wizard UX uses as the versioned contract (sessions, runs, steer, files, thread-seen, thread-dispositions, voice).
5. **Cutover.** Point the live service at this repo, then delete `server/` from `wizard-mobile` and make its front end depend on this service.
