# Default agent, agent-qualified history and the recovery agent (contract, proposed)

Status: proposed contract for the slice after "private agents are owner-only" (PR #48). Nothing here is implemented yet. It keeps today's behaviour on every box until an owner changes a setting.

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
- An id that exists in two agents is two threads. A request that names only `session_id` resolves through the pin table; if more than one agent has that id and no pin decides, the Service answers 409 `agent.ambiguous_thread` instead of guessing (private agents stay invisible: a non-owner sees the visible match or 404).
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
