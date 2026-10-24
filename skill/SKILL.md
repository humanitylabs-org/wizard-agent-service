---
name: wizard-agent-service
description: How the agent reaches the apps installed on this Wizard OS box through the one Wizard gateway.
---

# Wizard Agent Service

The Agent Service sits between the Wizard shell and this agent. For the agent it provides one MCP
server, `wizard` (served at `/wizard/mcp`), which carries every installed app's tools.

- `wizard_apps` lists the apps installed on the box, what each one is for and its tools.
- Each app's tools appear as `<app>__<tool>` (dashes in the app id become underscores).
- Installing or removing an app changes this list without reconnecting the agent; call `wizard_apps`
  again when an app you expect is missing.

Chats, runs, approvals, voice and attachments started in the Wizard shell all pass through this
service and land in this agent's own sessions.

## Chats Spaces (owner-requested thread collections)

When the owner explicitly asks for a chat space/workspace/folder/category/project, load the shell's
`wizard-spaces` skill. Wizard UX ships it under `skills/wizard-spaces/`; install the whole directory
into this agent's native skills directory, including its Node helper script. List existing Spaces,
search accessible owner threads by title, subject and recent content, back-fill relevant real thread
ids and report the count and a few titles. Never invent Spaces on your own or retrieve private agent
history outside your grants. Subjects are metadata, not Focus tabs.

The helper `scripts/wizard-spaces.mjs` in that skill uses the existing owner-authorized
`GET/PUT /wizard/v1/ui-preferences` endpoint, sends only `spaces`, and verifies a final GET. It supports
list/create/rename/delete/add/remove. The service validates at most 50 collections, 500 unique thread
ids each. On a container/restricted install use its existing owner-authorized preferences transport;
never add a host TCP fallback or weaken authentication to reach it.

## My skin (the owner's own look)

Each box has one personal folder, **My skin**, at `Skins/My skin/` in the owner's Files:

```
Skins/My skin/
  skin.css   personal style, empty by default
  skin.js    optional hook module, off until the owner approves this version
```

The legacy `Skins/My skin.css` still works when the folder's `skin.css` is absent; do not force a migration. Wizard
loads it last, on top of whichever skin the owner picked, on phone and desktop. Wizard OS and skin
updates never touch it; an empty file (comments only) means the picked skin exactly as its author made it.

- When the owner asks to change how Wizard looks ("change my skin", "bigger text", "less purple"), edit
  only this folder (or the existing legacy CSS file) with the Files app tools. Never edit the built-in skins (Nebula, Grove, Tide, Ember,
  Signal, Dark, Light, Landscapes); their authors keep improving them through updates.
- `skin.css`: plain CSS, at most 64 KB. `@import`, other at-rules that load things, and URLs to other sites are
  dropped when served. Scope rules with `html[data-skin] …` (every skin) or `html[data-skin="nebula"] …`
  (skin ids: nebula, grove, tide, ember, signal, obsidian = Dark, obsidian-light = Light, landscapes).
- `skin.js`: an ES module (at most 64 KB), `export default function setup(api) { …; return teardown; }`.
  It uses the same safe hook API as skin packages: `env`, `route()`, `on('route'|'render', fn)`,
  `nav.back/openList/openThread/goDesk/deskCount`, `part`, `listen`, `frame`, `gesture.claim`, `toast`,
  `storage.get/set`. Use these hooks, not direct listeners, timers, network, storage, shell internals,
  HTML injection, eval or imports. Tracked hooks are cleaned up; three errors a minute unload the module
  and show a toast naming `Skins/My skin/skin.js`. This is trusted owner code, not a JavaScript sandbox.
- After **every script edit**, the owner must tap **Turn on** in Settings › Look for that exact SHA-256
  on this device. An edit switches it off until approved again. **Agents cannot approve it:** never set
  `wos.myskin.js.ok`, automate the confirmation, or claim it is enabled. Tell the owner where to tap.
  Turn off revokes this device's approval. CSS needs no approval.
- The owner reloads Wizard to see a change. Settings › Look shows "My skin" with Edit and Reset.
  If a rule ever makes Wizard unusable, `?myskin=off` on the Wizard URL skips the layer for that load.
- Service route: `GET /wizard/v1/my-skin` (the sanitised CSS; `?format=json` for status),
  `GET /wizard/v1/my-skin/script` (read-only JavaScript with SHA-256 header; JSON includes script status),
  owner-only same-origin `PUT` (`Content-Type: text/css`) and `DELETE` (reset to the empty template).
