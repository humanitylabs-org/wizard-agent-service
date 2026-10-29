# Which apps each agent may use (per-agent access)

Each agent instance has its own app lists, kept by this Service and enforced by the gateway (`/wizard/mcp`,
`server/agent-bridge.mjs`), wizard-os spec/AGENTS.md section 5 (#58):

| Agent | Where its lists live |
|---|---|
| The main agent (`hermes`) | `<wizard-os home>/agents/.main-agent.json`: `{"schema":1,"wizard_apps":[...],"agent_apps":[...]}`. Absent: every installed standard app. |
| Every other agent | `<wizard-os home>/agents/<id>/agent.json`, `permissions.wizard_apps` / `permissions.agent_apps` |

The owner changes them with `PATCH /wizard/v1/agents/<id>` (`{"permissions":{"wizard_apps":[...],"agent_apps":[...]}}`)
or `PUT /wizard/v1/apps/<app>/agents` (which agents can use one app). The App Manager's Connections page (Agents →
an agent → one switch per app, agent app and connector) and `wam agents access <agent> <app> on|off` use these routes.

## What the gateway does with them

- **Tool list.** `tools/list`, `initialize` instructions, `wizard_apps` and the pointer skills hold only the apps on the
  agent's lists. A change through the API sends `notifications/tools/list_changed` on the agent's open streams.
- **Calls.** Every `tools/call` reads the lists again (the main agent's file is re-read when its stamp changes), so a
  call to an app that was just turned off is refused at once, even if the agent still has the tool in an old list:
  `Oscar is not allowed to use Money. The owner can turn it on in Connections.` (the agent's label; the main agent's is
  `WIZARD_MAIN_AGENT_LABEL`, default `Hermes`). The call never reaches the app.
- **Private apps** (`privacy: private`) an agent may not use are still answered exactly like an app that is not
  installed, so a standard agent never learns that one is there (#59).

## Defaults

- A new **standard** agent starts with every installed standard app on (Miguel, 29 Oct 2026); private apps still need a
  tick. A client that sends `wizard_apps` or `agent_apps` when it creates the agent picks the apps itself.
- A new **private** agent starts with the box's private apps only (#59).
- An app installed later joins the main agent (and private apps join private agents); other agents keep their lists.
