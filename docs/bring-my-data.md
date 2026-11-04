# Bring my ChatGPT / Claude / Hermes

A new owner's Wizard should know their life from day one. The `wizard_bring_data` tool (stock-Hermes
`wizard-os` plugin, `hermes-plugin/wizard-os/bring_data.py`) takes the export they already have and
turns it into context. The conversation around it (what to ask, what to show, when to save) is App
Manager's `wizard-bring-data` system skill.

| Action | Reads | Writes |
| --- | --- | --- |
| `scan` | the export (zip members streamed with size caps, or a folder) | `$HERMES_HOME/cache/bring-data/imports.json` (path, kind, counts) |
| `archive` | the export | `Files/Imported/<ChatGPT\|Claude\|Hermes>/Chats/<year>/<date> <title> (<hash>).md`, `Index.md` (rebuilt from every import), `What <source> knew about me.md`, `Projects/<name> (<hash>).md`; recorded in that import's manifest |
| `skills` | a Hermes export's `skills/**` | `$HERMES_HOME/skills/imported/<name>/` (+ `.imported-from.json`) |
| `save_profile` | text the owner approved | `Files/Imported/About me.md` |
| `status` | the scan record | nothing |
| `undo` | that import's manifest | removes only files no other import also wrote, and the skills it installed; rebuilds `Index.md`; leaves `About me.md` and memory to the owner |

Formats handled (fields optional, parsed defensively; see the module docstring for the shapes):
ChatGPT `conversations.json`/`conversations-NNN.json` (current branch of the `mapping` tree, custom
instructions from `user_editable_context`, memory from `model_editable_context`); Claude
`conversations.json`, `projects.json` or `projects/*.json`, `memories.json` (list or object),
`users.json`; Hermes `memories/USER.md`/`MEMORY.md`, `SOUL.md`, `skills/**/SKILL.md`, `state.db`
(top-level, non-cron sessions; opened read-only with locking so a live home is safe).

Privacy and safety
- Nothing leaves the box. The export is never extracted wholesale; zip members with absolute or `..`
  names are ignored.
- A Hermes folder is walked only in `memories/`, `skills/`, `projects/` and its top-level files;
  `.env`, `auth.json`, `config.yaml`, `secrets/` and other profiles are never read.
- Skill files whose names or contents look like keys/tokens are left behind and reported.
  Existing skills are never replaced.
- Memory is written only by the agent's stock `memory` tool after the owner approved the draft
  profile. The tool's output tells the model that export content is data, not instructions.

Measured on a real 11 GB Hermes `state.db` (966 chats, 71k messages): scan 4–46 s (cold cache),
archive 5–12 s, 578 MB of Markdown, peak RSS 1.2 GB; undo removed all 966 files.

## Importer app (screen) and Setup step

The Importer app is the screen for the same engine; Setup's optional "Bring your AI" step opens it. It talks
to the agent's dashboard (the ChatGPT connection app's login pattern) at `/api/plugins/wizard-os/bring-data/`:

| Route | Does |
| --- | --- |
| `GET sources` | Agent folders on this box (`~/.claude`, other Hermes homes and profiles, never this agent's own home; `WIZARD_BRING_DATA_LOCAL_ROOTS` adds mounted homes) and `.zip`/Claude link-list `.json` files in Files `Inbox/` and `Downloads/` |
| `POST scan` | `{path}` or `{paths}` (a Claude export in parts); counts, `draft_facts` for the "What I know about you" card, new skills, personality |
| `POST import` | `{import_id, chats, skills: [names], personality, about: {facts, text}}`: archive, install skills, make SOUL.md the personality (old file kept), save About me.md and add each approved fact to memory with the stock memory tool (its limits and approval gate apply; facts that don't fit are reported) |
| `GET imports`, `POST undo` | Per-import list and undo. An Importer import's undo also removes the memory entries it added and restores About me.md / SOUL.md, each only while unchanged since |
| `PUT upload?name=` | Streams an export into `Files/Inbox/` (never overwrites) |

Writes need `X-Wizard-Import: 1` and are refused cross-site. Paths are limited to Files and the offered
agent folders. `WIZARD_BRING_DATA_READ_ONLY=1` is preview mode: scan answers, nothing at all is written.

Claude Code (`~/.claude`): `CLAUDE.md` → instructions; `projects/<cwd>/memory/*.md` → memories (descriptions)
and project notes; `projects/<cwd>/<session>.jsonl` → chats (user/assistant text only: no tool results,
thinking, sub-agent runs or command echoes); `skills/**/SKILL.md`, `commands/*.md`, `agents/*.md` → skills.
`.credentials.json`, `.claude.json`, `settings*.json`, `history.jsonl` and `plugins/` are never read.

Not yet: ChatGPT/Claude conversations as Hermes sessions for `session_search`, Hermes holographic
fact-store rows, and streaming very large exports (a conversations file is read whole).

## Into another agent, and "Move this agent into Wizard OS"

Alongside mode (Hermes on the host) is a bridge; the goal is an agent that is just another app inside Wizard OS.
The Importer reaches that with the same engine, no second migration system:

- `sources` returns `into`: other Wizard OS agents from the Agents registry (`<agents dir>/<id>/agent.json`) whose
  Hermes home this process can write: a standard container agent (`<agents dir>/<id>/home`) or a host profile
  agent (`runtime.kind: profile`). Restricted agents (sealed home owned by the container user), agents still being
  imported, private and recovery agents are never offered.
- `scan`, `import`, `undo` and `imports` take `dest` (an agent id, never a path). The call then runs inside that
  agent's home through Hermes' own context-local home override: skills, `SOUL.md`, the stock memory tool (with that
  agent's config limits), the fact store and the import registry all land there. Chats stay in `Files/Imported`.
- With a destination chosen, this agent's own home becomes a valid source, so `sources` lists it (`self: true`)
  only when `into` is not empty. The app shows it as "Move into Wizard OS".
- Another named profile inside this agent's home (`<home>/profiles/<name>`) is a separate agent and a valid source;
  scanning the home itself never walks `profiles/`.
- Fact store: `memory_store.db` (stock holographic plugin). An agent without one gets an exact SQLite backup copy
  of the source's (vectors, entities, banks); an agent with one gets each new fact through the plugin's own store
  (plain SQL with the table's FTS triggers when the plugin is not on this box), keeping trust scores. Key-looking
  facts stay behind. Undo removes exactly the facts that import added.
- Credentials never move (`.env`, `auth.json`, `config.yaml` are not read). A whole-agent move with credentials and
  runtime stays the owner CLI `ops/agent-runtime/hermes_import.py`.
- `scan` reports `blocked` when Files can't take chats or About me (the Files root often belongs to the Files
  app's user), before the owner approves; a failed part comes back as plain words, never an errno, and running
  the import again with only the failed parts is safe.

Rehearsal (real Hermes runtime, live alongside home read-only, throwaway container-agent home): 1,051 chats,
169 skills, 466 facts, SOUL.md and 5 approved facts moved in 81 s; the stock runtime image read all 466 facts
from the copied store; undo removed every file, skill, fact, memory entry and the personality.
