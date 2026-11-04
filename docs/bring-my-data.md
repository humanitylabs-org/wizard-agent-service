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

Not yet: an onboarding/Setup screen for this (wizard-ux follow-up), ChatGPT/Claude conversations
as Hermes sessions for `session_search`, and Hermes holographic fact-store rows.
