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
