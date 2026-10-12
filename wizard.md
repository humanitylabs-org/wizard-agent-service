---
wizard: 0.2
id: wizard-agent-service
name: Wizard Agent Service
type: service
category: system
version: 0.3.0-candidate.20261012
summary: "Headless Wizard API and durable run/approval state; shells install separately."
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
health: /wizard/health
mcp:
  path: /wizard/mcp
  port: 8787
---

# Wizard Agent Service
Owns the unchanged /wizard/... API, runs, approvals, voice, attachments and one app-tool gateway.
The separate Wizard Shell is a view app. Hermes stays on the host in alongside mode.
The state volume belongs to this service; shell updates never mount or replace it.
The loopback published port is 8797; containers reach wizard-agent-service:8787.
History fallback is opt-in; the default has no host Hermes home mount.
This candidate disables automatic follow-through until the release owner selects the sole writer.
