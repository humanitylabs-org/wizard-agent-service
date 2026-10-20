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

- Routing accepts both `agent` and `agent_id`, but refuses conflicting aliases. List/detail rows expose `agent_id` and `session_id`; the existing `agent` decoration remains compatible. Successful pinning stores JSON-tuple keys, so a colon in a session id cannot collide with another pair. A previously unlisted private id cannot be claimed by a different runtime: admission probes the other histories strictly before assigning it.
- Settings normalization checks runtime eligibility, not current liveness. A stopped but valid managed default stays selected and fails loudly; it does not silently select `hermes`. Unknown/deleted ids still normalize to `hermes`. If that fallback is recovery, ordinary admission fails closed rather than activating it.
- Service-owned JSON migrations are atomic and retain `<store>.pre-agent-pairs-v1.bak` with mode `0600`. SQLite backups use `VACUUM INTO` before the migration, including committed WAL pages. Reopen does not rewrite migrated JSON or overwrite backups. To roll back, stop the Service, restore each affected store from its backup (remove stale SQLite WAL/SHM siblings), and run the old revision. Upstream Hermes databases are not rewritten.
- Diagnostic JSONL receipt journals use the same backup/atomic-write policy. A malformed or truncated diagnostic journal is left byte-for-byte intact with a warning rather than making a previously running box unbootable; these logs never participate in admission or routing. Canonical history stores do not get that exception.
- Per-thread status backfills and subject corrections are migrated too, with pair-aware lookups. Raw session-id journals preserve a literal `direct:` or `operator:` inside an imported session id instead of confusing it with a side-store runtime prefix.
- The external-runtime run queue, heavy-worker continuation executor, locked-model bridge, title journal and helper/voice recovery evidence remain owned by the external runtime. Their old references acquire explicit `hermes` pairs; they are never rebound to a new default. Secondary runs are proxied to their own runtime, not inserted in this external-runtime queue. Non-main queue admissions are rejected, and imported histories never consume same-id main-runtime recovery evidence. This preserves executor/receipt trust boundaries rather than introducing an untested cross-runtime continuation engine.
- `PATCH /wizard/v1/agents/hermes` with `{ "role": "recovery" }` requires the owner and another eligible default. Existing explicit app bindings or reader/source grants must be removed first (409 `recovery_agent_bound` / `recovery_agent_granted`); promotion does not silently rewrite those records. Recovery has no effective app membership. `{ "role": "standard" }` restores ordinary main-agent behavior without changing the selected default.
- Recovery runs require an explicitly named agent and an owner principal. Pending ordinary queue jobs, automatic helper resumes, heavy-worker continuations, delivery, model-based routing and default selection cannot activate recovery. Historical main-only Continue endpoints refuse recovery activation; use an explicit owner chat/run instead. Anonymous and agent-key callers receive missing-agent responses, including for direct named-agent metadata paths.
- Compatibility acceptance is deliberately scoped to the fresh-box agent list, app bindings and new-chat request routing. History responses gain the pair fields required by section 2, and settings responses expose the normalized default setting.
- Proof lives in `tests/default-agent-recovery.test.ts`, `tests/thread-reference-migrations.test.ts`, and the principal/share/voice/background regression tests. The fresh-box snapshot is also runnable against an archived pre-S2c server via `WAS_S2C_BASELINE`, so it is not merely a new expected snapshot of changed behavior.
