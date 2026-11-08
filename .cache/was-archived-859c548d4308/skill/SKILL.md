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

## My skin (the owner's own look)

Each box has one personal stylesheet, **My skin**, at `Skins/My skin.css` in the owner's Files. Wizard
loads it last, on top of whichever skin the owner picked, on phone and desktop. Wizard OS and skin
updates never touch it; an empty file (comments only) means the picked skin exactly as its author made it.

- When the owner asks to change how Wizard looks ("change my skin", "bigger text", "less purple"), edit
  only this file with the Files app tools. Never edit the built-in skins (Nebula, Grove, Tide, Ember,
  Signal, Dark, Light, Landscapes); their authors keep improving them through updates.
- Plain CSS only, at most 64 KB. `@import`, other at-rules that load things, and URLs to other sites are
  dropped when served. Scope rules with `html[data-skin] …` (every skin) or `html[data-skin="nebula"] …`
  (skin ids: nebula, grove, tide, ember, signal, obsidian = Dark, obsidian-light = Light, landscapes).
- The owner reloads Wizard to see a change. Settings › Look shows "My skin" with Edit and Reset.
  If a rule ever makes Wizard unusable, `?myskin=off` on the Wizard URL skips the layer for that load.
- Service route: `GET /wizard/v1/my-skin` (the sanitised CSS; `?format=json` for status),
  owner-only same-origin `PUT` (`Content-Type: text/css`) and `DELETE` (reset to the empty template).
