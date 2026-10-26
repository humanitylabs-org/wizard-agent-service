# Agent-local stock holographic memory

REUSE: Stock Hermes `plugins.memory` provider discovery, `MemoryManager`, `fact_store` / `fact_feedback`, SQLite-safe native backup/import, and the existing per-agent home volume.
EXTEND: `server/agents.mjs` managed harness generation and existing managed-harness upgrade; `ops/agent-runtime/hermes_import.py` import configuration wiring.
NEW: No runtime, database, memory service, core Hermes patch, or UI component. Only isolated regression/proof tests.

## Contract

Every new Service-managed Hermes container selects `memory.provider: holographic`,
explicitly enables `holographic`, and configures
`plugins.hermes-memory-store.db_path: "$HERMES_HOME/memory_store.db"`.
The pinned stock runtime already packages this provider; the derivative image
build checks availability. Nothing is downloaded into an agent at startup.

Facts are local SQLite data in the agent's own writable home (`/opt/data` for
restricted containers), not in the Service's state, an image layer, or a shared
volume. No embeddings API or model credentials are required. Built-in
`MEMORY.md` / `USER.md` and their size limits still work; auto-extraction stays
off by default. This applies to all generated harnesses, independent of persona,
privacy, or model provider. There is no Archimedes-specific code.

The existing managed-harness stamp upgrade will regenerate old Service-managed
configs when this change is eventually deployed; stopped agents stay stopped.
This PR does not deploy or restart any existing installation. Host profiles and
imported agents are excluded from that automatic rewrite as before.

## Import and backup

Wizard import defaults an *absent* memory provider to holographic. Explicit
alternative providers (including `builtin` / `none`) are preserved. A selected
holographic provider is explicitly enabled, including `memory` in an imported
API toolset allowlist so Hermes exposes its provider tools. Existing provider
settings and database bytes survive; own-source-home absolute database paths
and supported home placeholders become `$HERMES_HOME/<relative path>` so archive
imports do not silently point to the old machine. Paths outside the imported
home are refused rather than replaced with a new empty database. Bring such a
store inside the source Hermes home before importing. The transformation is
idempotent across portable staging and restricted admission.

Stock `hermes backup` snapshots `*.db` using SQLite backup, excludes stale WAL /
SHM companions, and includes `memory_store.db`. Wizard's existing portable
import carries that file in the home; no second fact-store export format or
Service database is introduced. Import undo restores the original config and
keeps the fact DB intact.

## Reproducible proof

Focused checks:

```sh
npx vitest run tests/holographic-memory.test.ts tests/managed-harness-upgrade.test.ts
node scripts/test-hermes-import.mjs
```

Opt-in Docker proof on an isolated Linux worker with the importer dependencies
installed (PyYAML and python-dotenv):

```sh
python3 tests/holographic_container_proof.py
```

The `Holographic memory` GitHub workflow runs this proof against the exact pinned
stock runtime digest. It creates two randomly named non-root, read-only-root,
network-disabled throwaway agent containers with dedicated home volumes. It
loads the generated config through stock agent memory initialization, verifies
provider tools were injected, adds a canary fact, recalls it, restarts only the
test container, and recalls/prefetches again. It then makes a native SQLite-safe
backup, verifies the archive includes the facts DB, restores into the second
home, applies real Wizard import wiring, and recalls/prefetches there. Both test
containers and volumes are deleted and cleanup is verified. No inference calls,
owner-home mounts, live Service/gateway restart, or deployment occurs.

It also repeats stock tool injection/add/recall/restart/prefetch for isolated
main-home, named host-profile and managed-container scopes; these are disposable
stock runtime scopes, not a claim of live Wizard transport coverage. The contract
is indexed in `qa/agent-parity/features.json`. All disposable homes and volumes
are removed, with cleanup verified.

This is a deterministic tool/prefetch integration proof, not a paid model-chat
quality evaluation. A fact lives in the durable provider DB, not necessarily in
always-loaded `MEMORY.md`.
