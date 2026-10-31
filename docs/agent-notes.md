# Agent notebooks in Notes (owner-only, read-only)

An agent may declare an owner-visible notes folder in `agent.json` (`"notes_dir": "wiki"`). The Notes app shows
each such folder as a read-only source beside the owner's own notes ("My notes" stays the default).

Routes (owner principal only; agent credentials get 403; anything but GET/HEAD gets 405 `read_only`):

| Route | Answer |
| --- | --- |
| `GET /wizard/v1/agent-notes` | `{sources:[{id,label,privacy,appearance?}]}` |
| `GET /wizard/v1/agent-notes/<id>` | `{source:{id,label}, entries:[relative path], truncated}` |
| `GET /wizard/v1/agent-notes/<id>/read?path=<relative .md/.txt>` | `{source, path, text}` |
| `GET /wizard/v1/agent-notes/<id>/search?q=<words>` | `{source, notes:[{path,title,snippet}], truncated}` (title hits first, max 50) |

- A source is a `standard`-privacy, non-hidden, non-recovery agent with a non-empty `notes_dir`. Private agents,
  hidden agents, the recovery agent and agents without `notes_dir` answer exactly like a missing agent (404).
  No grant opens a private agent's notebook here: the privacy seal holds even for the owner's own apps.
- Paths go through the same gates as the `wizard_agents__notes_list` / `notes_read` tools (`stateList`/`stateText`
  in `agent-bridge.mjs`): no traversal, dotfiles, secret-looking names, symlinks, hardlinks or oversized files.
- Errors carry a check code only, never paths or file content. Every answer is `Cache-Control: no-store`.
- There is no write route. The Notes app's "Copy to my notes" writes a new note in the owner's own vault.

Tests: `tests/agent-notes-http.test.ts`.
