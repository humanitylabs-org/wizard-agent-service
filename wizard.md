---
wizard: 0.2
id: wizard-agent-service
name: Wizard Agent Service
type: service
category: system
version: 0.3.0-candidate.20261012
summary: "The Wizard API: chats, runs, approvals, voice and the one app gateway. Shells install separately."
icon: icon.png
license: MIT
source: https://github.com/humanitylabs-org/wizard-agent-service
runtime:
  kind: runtipi
  config: runtipi/config.json
  compose: runtipi/docker-compose.yml
system: true
provides:
- agent-service
uses:
- hermes-agent
- transcriber
- files
skill: skill/SKILL.md
health: /wizard/health
mcp:
  path: /wizard/mcp
  port: 8787
---

# Wizard Agent Service

The headless half of the Wizard shell ([wizard-os DECISIONS #36](https://github.com/humanitylabs-org/wizard-os/blob/main/docs/DECISIONS.md)):
it fills the `agent-service` spot and serves the `/wizard/...` API that every shell talks to.
The Wizard shell itself ([wizard-ux](https://github.com/humanitylabs-org/wizard-ux)) is a separate view app
in the `shell` spot; either can be updated or replaced without touching the other.

- Sits in front of the agent's API (`hermes-agent`, or the box's own Hermes in alongside mode).
- Owns threads, runs, approvals, files and voice; its state lives in its own app-data folder, so a shell
  update never touches it.
- Serves the one `wizard` MCP gateway (`/wizard/mcp`) that carries every installed app's tools.
- Voice goes to the `transcriber` app. No cloud speech service.

Reach it through the shell. Its port is published on the box's loopback only.
