# Contributor guide for agents

Entry point is [AGENTS.md](../AGENTS.md); this page holds the commands. Checked against the code and workflows on 5 Nov 2026. If a command fails, fix this page in the same PR.

## What this repo is, and its neighbours

The back end Wizard front ends call at `/wizard/...`. It sits in front of a **stock Hermes** (reached only through Hermes's API server and a read-only `state.db`) and owns threads, durable runs and steers, files, read state, voice recovery and usage.
- **wizard-ux** is the active front end; it holds no agent state. The [README](../README.md#where-it-sits-in-wizard-os) also lists legacy Wizard Mobile, and its [open split items](../README.md#open-items-for-the-split) still describe a static-front-end deployment and unfinished cutover; this guide does not verify live deployment. Contract changes: service first, consumers second, each step backward compatible; keep old routes and fields working for all supported consumers, including legacy Mobile while supported, until none still depends on them.
- **wizard-app-manager** installs apps and cuts OS releases; this service exposes per-agent app grants it calls over loopback. **wizard-troubleshooter** is an independent repair page that must work when this service is down.
- Wizard behaviour goes here, in a Hermes plugin under `hermes-plugin/`, or in an app. Never patch Hermes.

## Layout

- `server/index.mjs` (env and startup), `server/service.mjs` (HTTP routes), `server/session-truth.mjs` (thread history), `server/run-queue.mjs` (durable runs), `server/locked-run-bridge.mjs` (exact selected model/provider).
- `hermes-plugin/`, `ops/agent-runtime/`: plugins and managed runtime. `ops/`: units and env examples. `skill/`: shipped skill.
- `tests/`: Vitest, `node --test` and Python tests. `qa/agent-parity/`: per-agent-kind chat parity inventory and gate. `scripts/run-fixture.mjs`: disposable fixture.
- [COMPONENTS.md](COMPONENTS.md): back-end inventory (the UI inventory is wizard-ux `docs/COMPONENTS.md`). Owning contracts: [chats-list-protocol.md](chats-list-protocol.md), [restricted-agent-runtime.md](restricted-agent-runtime.md), [hermes-import.md](hermes-import.md). Root `CUTOVER.md` is the owner-cutover safety gate for Hermes import (still referenced by those docs); it is not release guidance.

## Setup, tests, checks

Node >=22.5 (`node:sqlite`; CI uses 22) and Python 3 with an isolated venv for plugin and importer tests:

```sh
npm ci
python3 -m venv .import-venv
.import-venv/bin/pip install 'PyYAML>=6.0.2,<7' 'python-dotenv>=1.0,<2'
export WIZARD_IMPORT_PYTHON="$PWD/.import-venv/bin/python" PATH="$PWD/.import-venv/bin:$PATH"
npm test                                        # plugins, importer, vitest + node tests, agent-parity gate
node --test tests/locked-run-bridge.test.mjs
python3 -m unittest discover -s scripts/ci -p 'test_*.py' -v   # the "validate" job
npm run fixture                                 # fake Hermes + service on a random loopback port
```

There is no lint script; use `git diff --check`. `.github/workflows/quality.yml` is the full `test` job: it also fetches frozen revisions for fail-before/pass-after regression checks, a second venv (`fastapi==0.133.1 httpx==0.28.1`) for provider-account tests, and a fixture-boot check. Do not call a partial local run a CI pass. `npm run start:local` needs your own `.env.local` (from `ops/wizard-mobile.env.example`); never point tests at a real owner's state.

Required checks on `main` (branch protection on 5 Nov 2026; re-check with `gh api repos/humanitylabs-org/wizard-agent-service/branches/main/protection/required_status_checks`): **`test`**, **`gitleaks`**, **`validate`**. Read results on the exact PR head.
- `gitleaks` (`secret-scan.yml`): Gitleaks 8.30.1 with `.gitleaks.toml`: `gitleaks git . --config .gitleaks.toml --no-banner --redact --log-opts="$(EVENT=pull_request PR_BASE=<base sha> PR_HEAD=<head sha> sh scripts/secret-scan-range.sh)"`. PRs scan base..head only.
- `reuse-check.yml` runs the shared gate from wizard-ux on every PR, including docs-only and CI-only ones. The PR body needs the word `Reuse:` alone on its own line, then one bullet per capability, exactly `- <capability>: REUSE|EXTEND <entry point>` (or a `NEW` with a matching added row in wizard-ux's inventory). The entry point must be a name from wizard-ux's `docs/COMPONENTS.md` (for example `WizCore`); anything else fails. A docs-only PR still needs one bullet, for example `- documentation: REUSE WizCore (no code or UI change)`. Caller contract: [app-reuse-gate.md](https://github.com/humanitylabs-org/wizard-ux/blob/main/docs/app-reuse-gate.md). Read this repo's [COMPONENTS.md](COMPONENTS.md) before adding a capability.

## Rules for chat features and client-visible changes

- Every new or changed chat feature updates `qa/agent-parity/features.json` and a per-kind behavioural check (main, host-profile, container, restricted); see [qa/agent-parity/README.md](../qa/agent-parity/README.md). `npm run test:agent-parity` is part of `npm test`.
- Never read or exercise a real private agent for QA; use the fixture and synthetic threads. Real conversation content never goes into fixtures, tests or PR text.
- Keep the exact selected model/provider on admission and retry; never substitute silently. Keep owner and auth boundaries, thread custody and restricted routes fail-closed.
- Never drop an existing route or behaviour in a rewrite: compare with the code serving today and list what is kept. There is no `app-parity-gate` here; record your comparison instead of claiming a pass. App workflows and approved behaviour ship in the app/plugin source and release, never only in agent notes or an installed copy ([app-skill-guard.md](app-skill-guard.md)).
- This repo has no UI. Behaviour the UI depends on must keep wizard-ux's rules: a tap paints on the same frame and never waits for the backend, Back never exits, tapping outside a sheet closes it, Appearance v1 `--wz-*` tokens with live skin changes, fully opaque text panels. Browser checks run in a wizard-ux checkout (`tools/qa-origin.cjs`) pointed at the fixture. Fixture API tests alone are not browser or device proof.

## How a change reaches users

1. A PR merges to `main`. **Publish public image** (`publish-image.yml`) builds `ghcr.io/humanitylabs-org/wizard-agent-service` for both architectures by digest, attests provenance, writes write-once SHA tags and checks an anonymous pull. PRs only validate and build. Code: `scripts/ci/ghcr_image.py`. Confirm the run on `main` succeeded.
2. Boxes run plain `main` (Latest); Stable and `hotfix` follow the Team workflow in AGENTS.md. The executable OS channel gate (promotion record, 72 h soak, `fast_track`) is in `wizard-app-manager` (`releases/README.md`, `wam/updates.py`).
3. Publishing an image does not restart or update any service. Deployment needs a release owner, an immutable image or SHA, a rollback plan and a health check after.
