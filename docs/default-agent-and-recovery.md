# Default agent, agent-qualified history and the recovery agent (implemented)

Status: implemented for S2c, after "private agents are owner-only" (PR #48). It keeps today's default selection on every box until an owner changes a setting. This is a source change, not authorization to change a live default or deploy it.

## 1. The default agent is a setting

- `settings.json` → `agents.default_agent_id` (string). Missing or unknown = `hermes`, so every existing box behaves as today.
- Normalised by `normalizeSettings`: must name an existing agent whose runtime can start chats. A private agent may be the default; the setting itself is owner-only to change (`PUT /wizard/v1/settings` refuses a non-owner change of this key with 403 `owner_required`, check `agents.default_owner`).
- Everything that today means "the main agent" when nothing names an agent reads this value instead of `MAIN_AGENT_ID`:
  - a new chat with no `agent`, no pin and no model routing;
  - voice and orb starts;
  - automations and cron-to-chat posts that do not name an agent;
  - app bindings whose stored agent is "default" (`Binding.is_default: true`), and new installs.
- `Agent.is_default` is `agent.id === default_agent_id`. The main agent keeps `id: "hermes"`.
- Changing the default never moves a thread: existing threads stay pinned (section 2). A bound private agent that is down still fails loudly; the default is never a fallback for it.

## 2. History is keyed by agent

- Every thread reference the Service stores or returns is the pair `(agent_id, session_id)`: pins, seen/disposition state, delivery receipts, attachments and shares, queued runs and resume receipts.
- Storage: existing rows without an agent are read as `(hermes, session_id)`; new rows always carry the agent. A one-time, idempotent migration writes the explicit pair and keeps a backup of each store.
- An id that exists in two agents is two threads. A request that names only `session_id` resolves through the pin table; if more than one visible agent has that id and no pin decides, the Service answers 409 `{ error: "ambiguous_thread", check: "agent.ambiguous_thread" }` instead of guessing (private agents stay invisible: a non-owner sees the visible match or 404). The check/error split follows the existing Agent API error convention.
- The `mainHasSession` check and the "Unified Chats" model routing ask the agent in the pair, never "the main agent".
- Imports: a copy of another Hermes history (for example "Bring my Hermes") lands as a new agent with its own id. Its session ids keep their values; the agent half of the pair keeps them from colliding with or being routed to the live main agent.
- API: list rows and thread links carry `agent_id` beside `session_id` (already true for rows decorated with `agent`); clients send both. Old clients that send only the id keep working through the pin table.

## 3. The recovery agent

- The existing external main agent can be relabelled "<name> (system)" and marked `role: "recovery"` once another agent is the default.
- A recovery agent is owner-only: it opens, lists and runs only for the owner principal, exactly like a private agent, and is never a grant reader or source, a binding target, an app member or the default.
- It is never started or activated automatically: no automation, delivery or default routing reaches it. It shows in the Agents app with a clear "recovery" label for the owner.
- No agent principal can name, list or run it (same 404 as a missing agent).

## 4. Managed default, external non-default

- A managed (container) agent may be the default; the external `hermes` agent may be a non-default (standard or recovery) agent. The current rule that stored secondary agents must be `container` stays; only the "default" property moves.
- "Bring my Hermes" and an owner's own migration use the same seam: create the agent, import into it, flip `default_agent_id`, optionally mark the old main as recovery.

## Acceptance (for the implementing slice)

1. Fresh box: no setting → behaviour and API output identical to today (snapshot of `/wizard/v1/agents`, bindings, new-chat routing).
2. Setting the default to a managed agent routes new chats, voice, automations and default bindings there; existing threads stay where they were.
3. Two agents holding the same session id: both open correctly by pair; an id-only read answers 409 (or 404 for a hidden private one); no store mixes them.
4. Recovery agent: owner opens and runs it; anonymous, agent keys and model routing never reach it; it never starts on its own.
5. Migration of existing stores is idempotent and reversible from its backup.

## Implementation details and conservative boundaries

- Routing accepts both `agent` and `agent_id`, but refuses conflicting aliases. List/detail rows expose `agent_id` and `session_id`; the existing `agent` decoration remains compatible. Successful pinning stores JSON-tuple keys, so a colon in a session id cannot collide with another pair.
- Availability/anti-claim: `.threads.json` is a **positive authority index**, not a projection of side metadata. Each entry carries `runtime_verified`, `service_admission`, or `migrated_pin` provenance; only these grant the cross-history claim bypass. Schema-1 legacy pins migrate as trusted pins; pre-provenance schema-2 entries become `legacy_unverified` and must be runtime-reverified. Seen, disposition, dismissal, title, subject, recovery/worker/locked journals, queue/share/heavy rows and arbitrary nested pair-shaped objects never seed this index. Queue acceptance alone is not proof of runtime history. Runtime-authenticated lists/history and verified service-created/admitted sessions supply authority evidence.
- Settings and bootstrap omit `agents.default_agent_id` when the principal cannot see that target (no fake Hermes fallback). Every non-owner PUT strips that field **before any comparison, normalization or validation involving the supplied value**; hidden-equal, missing and Hermes guesses receive identical status/body. Other safe settings changes/round-trips preserve the stored default. Agent credentials still cannot write settings. Owner validation is unchanged.
- Settings normalization checks runtime eligibility, not current liveness. A stopped but valid managed default stays selected and fails loudly; it does not silently select `hermes`. Unknown/deleted ids still normalize to `hermes`. If that fallback is recovery, ordinary admission fails closed rather than activating it.
- Service-owned JSON migrations are atomic and retain `<store>.pre-agent-pairs-v1.bak` with mode `0600`. SQLite backups use `VACUUM INTO` before the migration, including committed WAL pages. Reopen does not rewrite migrated JSON or overwrite backups. To roll back, stop the Service, restore each affected store from its backup (remove stale SQLite WAL/SHM siblings), and run the old revision. Upstream Hermes databases are not rewritten.
- Diagnostic JSONL receipt journals use the same backup/atomic-write policy. A malformed or truncated diagnostic journal is left byte-for-byte intact with a warning rather than making a previously running box unbootable; these logs never participate in admission or routing. Canonical history stores do not get that exception.
- Per-thread status backfills and subject corrections are migrated too, with pair-aware lookups. Raw session-id journals preserve a literal `direct:` or `operator:` inside an imported session id instead of confusing it with a side-store runtime prefix.
- The external-runtime run queue, heavy-worker continuation executor, locked-model bridge, title journal and helper/voice recovery evidence remain owned by the external runtime. Their old references acquire explicit `hermes` pairs; they are never rebound to a new default. Secondary runs are proxied to their own runtime, not inserted in this external-runtime queue. Non-main queue admissions are rejected, and imported histories never consume same-id main-runtime recovery evidence. This preserves executor/receipt trust boundaries rather than introducing an untested cross-runtime continuation engine.
- `PATCH /wizard/v1/agents/hermes` with `{ "role": "recovery" }` requires the owner and another eligible default. Existing explicit app bindings or reader/source grants must be removed first (409 `recovery_agent_bound` / `recovery_agent_granted`); promotion does not silently rewrite those records. Recovery has no effective app membership. `{ "role": "standard" }` restores ordinary main-agent behavior without changing the selected default.
- Recovery runs require an explicitly named agent and an owner principal. Pending ordinary queue jobs, automatic helper resumes, heavy-worker continuations, delivery, model-based routing and default selection cannot activate recovery. Historical main-only Continue endpoints refuse recovery activation; use an explicit owner chat/run instead. Anonymous and agent-key callers receive missing-agent responses, including for direct named-agent metadata paths.
- Compatibility acceptance is deliberately scoped to the fresh-box agent list, app bindings and new-chat request routing. History responses gain the pair fields required by section 2, and settings responses expose the normalized default setting.
- Proof lives in `tests/default-agent-recovery.test.ts`, `tests/thread-reference-migrations.test.ts`, and the principal/share/voice/background regression tests. The fresh-box snapshot is also runnable against an archived pre-S2c server via `WAS_S2C_BASELINE`, so it is not merely a new expected snapshot of changed behavior.

## Migration transaction and inventory (round 1)

Each directory containing affected stores has `.agent-pairs-v1.inventory.json` (mode 0600). Format:

```json
{"schema":1,"stores":{"seen.json":{"store":"seen.json","kind":"json","disposition":"migrated","phase":"complete","backup":"seen.json.pre-agent-pairs-v1.bak","sha256":"<64 hex digits>","size":123,"source_generation":"<inode:size:mtimeNs:sha256>"},"new.sqlite":{"store":"new.sqlite","kind":"sqlite","disposition":"created","phase":"complete","source_generation":"absent"}}}
```

Paths in an inventory are basenames relative to that inventory, not machine-specific absolute paths. Existing stores get a validated rollback baseline even if their transformation is byte-identical; new stores are marked `created` so rollback removes them. `backed_up` means backup bytes and manifest are durable but source mutation/commit may have been interrupted. A validated existing baseline is **never replaced**, in either `backed_up` or `complete`. A `backed_up` retry validates it and compares the current source generation with the recorded generation. Unchanged sources resume automatically; changed ones are refused: **keep source, keep backup; operator chooses recovery baseline**. This includes an interruption after source replacement but before completion marking. Authority stores fail closed; optional projections preserve bytes and degrade with that recovery diagnostic. SQLite generations also include the WAL digest. Keep **all** inventories with their backups.

JSON migration holds an OS-owned SQLite `BEGIN EXCLUSIVE` lock in `<store>.agent-pairs.lock.sqlite` across read/transform/backup/validation/replacement. The lock database is only a coordination inode, never the source store. All cooperative JSON writers and inventory updates use it. SQLite releases the lock on normal close or SIGKILL; PID reuse and dead PID files cannot strand it, and live holders cannot be stolen. **Never unlink these lock database files** to recover a lock: a second inode could admit another writer. Legacy/non-cooperating edits before first backup trigger generation reread/retry; after a validated baseline they require the explicit operator decision above. Backup/source publication uses unique temp files, fsync, atomic rename and directory fsync. A bare/partial unvalidated backup may be recreated only from untouched legacy source, never qualified data. Failed backup validation never authorizes empty-store fallback.

SQLite migration takes `BEGIN IMMEDIATE` on the source across the whole transaction. A second read connection performs `VACUUM INTO` a unique temp file (including committed WAL pages), `integrity_check` validates it, then durable temp/rename and manifest publication precede **all** schema/data changes. Native concurrent SQL writers are blocked by SQLite itself, not just a cooperative filesystem lock. Schema changes commit atomically. No upstream Hermes DB is migrated.

### Complete affected-store inventory

Runtime inventory entries use the configured basename, so overridden names remain accurate. This is the logical inventory:

| Store/configuration | Key domain | Classification / rollback |
| --- | --- | --- |
| Registry `.threads.json` | JSON tuple `(agent, raw session)` | Routing authority; backup existing / remove created |
| Registry `.run-threads.json` | Run id -> explicit pair rows | Routing authority; backup existing / remove created |
| Registry `.session-catalog.json` | Agent id -> timestamped runtime session-id set + complete-census flag | History authority; backup existing / remove created |
| `threadSeenStatePath` | Runtime-prefixed session, then agent namespace | Read-state authority; backup/remove |
| `threadDispositionStatePath` | Runtime-prefixed session, then agent namespace | Organization authority; backup/remove |
| `dismissedFailureStatePath` | **Raw** session, then agent namespace | Failure-dismissal authority; backup/remove |
| `threadTitleStatePath` | **Raw** session, then agent namespace | Optional display projection; backup/remove |
| `threadStatusBackfillPath` | **Raw** session, then agent namespace | Optional display projection; backup/remove |
| `subjectsPath` | **Raw** session, then agent namespace | Optional display projection; backup/remove |
| `model-locked-admissions.json` beside run queue | Admission key; row carries raw pair | Routing/execution authority; backup/remove |
| `operatorWorkerStatePath` | Worker run; row carries operator raw pair | Execution authority; backup/remove |
| `voiceRecoveryManifestPath` | Receipt entries with explicit raw pairs | Recovery evidence authority; backup/remove |
| `runQueueStatePath` SQLite | Run id; raw pair columns | Execution authority; backup/remove |
| `heavyStatePath` SQLite | Heavy id; raw pair columns/data | Execution authority; backup/remove |
| `uploadStatePath` SQLite | Share id; stored recipient + raw session | Share/receipt authority; backup/remove |
| `interrupt-recovery.jsonl`, `stale-run-guard.jsonl` beside queue | Raw pair per diagnostic row | Optional diagnostic logs; backup/remove |

Agent configs, credentials, app-binding configs, app-catalog snapshots, settings and upstream histories are not rewritten by this pair migration and are not restored by its inventory. Back those up separately before an operational default switch. A store never created has no source bytes to restore; a created marker also makes its later creation rollback-safe.

Optional title/subject/status metadata that cannot be parsed or qualified stays byte-for-byte intact, logs `[agent-pairs] optional metadata unavailable`, and serves an empty/degraded projection. A title rename during that process cannot overwrite the corrupt source. Diagnostic JSONL is also preserved on parse failure. Authority stores (pins/catalogs, seen/dispositions/dismissals, queues and routing/recovery journals) fail closed with an explicit diagnostic. Recovery: stop every writer, preserve the damaged bytes, restore the whole validated store set, then restart the matching revision; never replace an authority file with `{}` to make startup pass.

## Offline rollback — restoration is mandatory

**Code-only rollback is unsupported.** In particular old pin lookup cannot read tuple keys, old seen normalization cannot read secondary namespaces, and old heavy positional inserts cannot write the new schema. Before rollback, stop the Service and every worker/editor using these stores. Preserve an operator-approved copy/export of any post-backup metadata first: restoring rewinds **all changes after each store's backup**, including pins, read marks, titles, dismissals, queued submissions, share receipts and continuation state. Created stores are removed entirely. External jobs already launched and upstream transcripts are not undone; reconcile them before restarting old workers to avoid re-driving work.

Run from the repository, passing **every directory** containing an inventory (e.g. the configured state directory and agent registry directory; include separately configured queue/upload/voice directories):

```sh
node scripts/restore-agent-pairs.mjs --service-stopped "$STATE_DIRECTORY" "$AGENTS_DIRECTORY"
```

The helper acquires the service lifetime leases and sorted, overlapping-set restore locks **non-blockingly**, then all inventoried writer locks. A listening Service holds `.agent-pairs.service-lease.sqlite` in every configured store directory from construction through close (same-process listeners retain a shared reference until the last closes). Restore cannot share it, even in the same process. A live service/restore/writer lease means **exit 2, no store mutation**; `--service-stopped` is still a required acknowledgement, not the safety mechanism. Crashed holders release locks automatically. Before any source write/delete, validate **every entry in every inventory**, including created stores: disposition, kind, phase, required fields, key/store equality, checksum/size/generation and safe basenames (no dot, dot-dot, separators, empty names or coordination/backup targets). Any invalid entry refuses the whole set without source mutation. Restore removes created stores and stale WAL/SHM siblings. No per-store partial-restore mode or code-only rollback is supported.

## Runtime session catalog (round 2)

The service persists `.session-catalog.json` (schema 1, owner-only bytes, inventoried like the pin/run journals). Every successful runtime-authenticated session listing/history read records positive session ids with a timestamp; paginated unfiltered listings (`include_children=true`, all pages validated) establish the complete-census flag. Positive sightings are retained across later censuses, avoiding a concurrent/new-row pagination race. Partial reads never prove absence. Catalogs are never serialized to non-owner APIs.

On successful managed-agent creation the service attempts a full census. It invalidates negative evidence at stop/start transitions: capture the latest full set **before the service stops** the runtime, and reread **after start before trusting negative evidence**. Failed refresh leaves negative evidence invalid, never an empty authoritative set. Later successful authenticated listings refresh the census. There is no crawl of agent homes or client-authored metadata.

For a client-chosen id, a healthy runtime is checked normally. An unavailable runtime is checked against its last valid catalog: present means the existing private/claim refusal; absent in a complete catalog permits the unchanged legacy creation behavior. The **only remaining availability coupling** is an unavailable runtime without a usable complete catalog (never successfully censused, or invalidated at start without a successful refresh): return the existing 503 `agent_unavailable` / `agent.history`, not permission to claim an unseen private id. A stopped runtime cannot create sessions. Server-minted no-id creation remains independent of unrelated runtime liveness. A stopped selected default still fails; no fallback to Hermes occurs.

## Portable rollback rehearsal

`tests/store-migration.test.ts` uses the actual archived `859c548` server modules, never a vendored approximation. Set `WAS_ROLLBACK_BASE_DIR` to a directory containing that revision's `server/` for archive/shallow checkouts; otherwise use `git archive 859c548 server` only if that object exists. Without either, the test skips with an explicit diagnostic. `REQUIRE_ROLLBACK_REHEARSAL=1` converts that omission to a failure. Quality CI uses the default shallow checkout, so release/full-suite workers must supply the base directory and require rehearsal. The fixture tests real migration, whole-set offline restore and old-module pin/seen/heavy operations.
