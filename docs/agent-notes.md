# Agent notebooks in Notes (owner session only, read-only)

Notes is a human view (James, 31 Oct 2026, v2): the owner sees the notebook of **every** agent in his registry,
standard, private and hidden alike. An agent's notebook is `agent.json` `notes_dir`, else the default `wiki` folder
under its home; a missing folder is an empty notebook. New agents appear with no per-agent setup.

Routes (owner principal only; agent credentials, the Service's internal token and anonymous callers get 403;
anything but GET/HEAD gets 405 `read_only`):

| Route | Answer |
| --- | --- |
| `GET /wizard/v1/agent-notes` | `{sources:[{id,label,privacy,appearance?}]}` |
| `GET /wizard/v1/agent-notes/<id>` | `{source:{id,label}, entries:[relative path], truncated}` |
| `GET /wizard/v1/agent-notes/<id>/read?path=<relative .md/.txt>` | `{source, path, text}` |
| `GET /wizard/v1/agent-notes/<id>/search?q=<words>` | `{source, notes:[{path,title,snippet}], truncated}` (title hits first, max 50) |

- A source is every registered agent. `privacy` is returned so Notes can mark private ones with a lock. Main
  Archimedes (the host Hermes profile, `hermes`) is not a source until it runs as its own registered container.
- Agent-to-agent stays sealed: `/wizard/internal/agents/{list,notes_list,notes_read}` and the `/wizard/mcp`
  `wizard_agents__*` tools keep refusing private and unshared agents; no agent credential reaches this route
  (`principals.mjs` agent scope plus the owner check here). The Notes container gets no agent paths or tokens.
- Paths go through the same gates as the `wizard_agents__notes_list` / `notes_read` tools (`stateList`/`stateText`
  in `agent-bridge.mjs`): no traversal, dotfiles, secret-looking names, symlinks, hardlinks or oversized files.
- Errors carry a check code only, never paths or file content. Every answer is `Cache-Control: no-store`.
- There is no write route. The Notes app's "Copy to my notes" writes a new note in the owner's own vault.

Tests: `tests/agent-notes-http.test.ts`.
