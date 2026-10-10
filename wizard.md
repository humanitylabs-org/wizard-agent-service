---
wizard: 0.2
id: wizard-shell
name: Wizard
type: view
category: interface
version: 0.1.0
summary: "The Wizard shell: chats, launcher, voice and apps on top of Hermes Agent."
icon: icon.png
license: MIT
source: https://github.com/humanitylabs-org/wizard-agent-service
runtime:
  kind: runtipi
  config: runtipi/config.json
  compose: runtipi/docker-compose.yml
view:
  path: /wizard-ux/
  port: 8787
system: true
provides:
- shell
uses:
- hermes-agent
- transcriber
- files
needs:
- mic
- notifications
- files
health: /wizard/health
---

# Wizard (the shell)

The system front end of a Wizard box ([wizard-os spec/SHELL.md](https://github.com/humanitylabs-org/wizard-os/blob/main/spec/SHELL.md)): chats with your agent, the launcher and dock, voice, notifications, and the other apps' screens.

One container holds two things:
- **Wizard Agent Service** (this repo): sits in front of the `hermes-agent` app's API (`http://hermes-agent-engine:8642`), owns threads, runs, approvals, files and voice, and tells the agent which apps are installed.
- **Wizard UX** ([wizard-ux](https://github.com/humanitylabs-org/wizard-ux)): static web files served at `/wizard-ux/`.

## What it reads and writes

- Hermes's session history (`hermes-agent` app data), **read-only**, so chats started anywhere show up here.
- `media/` (the box's user-files folder, the same one the Files app shows): attachments you send land in `media/Inbox/<date>/`.
- Its own state in its app-data folder: settings, launcher, thread state.
- Voice goes to the `transcriber` app. No cloud speech service.

## Owner setup

- Install `hermes-agent` first and set its model provider.
- `HERMES_API_KEY`: the same API key as the `hermes-agent` app (in its settings).
- Optional: `WIZARD_ROUTER_URL` / `WIZARD_ROUTER_MODEL` / `WIZARD_ROUTER_KEY` turn on the fast orb command router. Without them, every orb request goes to the agent.

Reach it over Tailscale or a Cloudflare Tunnel. Its port is published on the box's loopback only.
