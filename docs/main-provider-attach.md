# Main agent provider attach (issue 428)

Switch: `WIZARD_MAIN_PROVIDER_ATTACH=1` (Agent Service env, option `mainProviderAttach`). Off by default.

A provider sign-in (Claude, ChatGPT, Tinfoil and the other connector apps) is box-wide: the main Hermes lists
every connected provider in `GET /api/model/options`. With the switch on, that list is only the box's
**provider pool**. The main agent uses just the providers attached to it:

- `GET /wizard/hermes/api/model/options` (the main agent's chat picker) returns only attached provider rows, plus
  `wizard_attached_providers` (slugs) and `wizard_unattached_providers` (`{slug, name}` rows connected to the box
  but not attached), so a client can offer to attach one.
- `POST /wizard/hermes/api/sessions/<id>/model`, `POST /wizard/hermes/api/sessions` and `POST /wizard/hermes/v1/runs`
  naming an unattached `provider` answer `409 {"error":"provider_not_attached"}` and never reach Hermes.
- The first time the main Hermes reports a configured provider (the onboarding choice), that one provider is
  attached. Nothing connected later is attached on its own, even if a sign-in hook changes the Hermes default.
- `GET /wizard/v1/main-providers` (owner) returns `{attached, pool: [{slug, name, attached}]}`.
- `PUT /wizard/v1/main-providers {"attached": ["wizard-tinfoil", "openai-codex"]}` (owner only) is the explicit
  attach/detach. `custom:<slug>` and `<slug>` are the same provider.

State lives in `<agents dir>/.main-providers.json` (`wizard.main-providers/1`, mode 0600).

New agents are unchanged: the Agents builder still offers the pool (`GET /wizard/v1/agent-options`), and choosing a
provider while building an agent is that agent's explicit attach.

Not covered here: a model named without a `provider` uses whatever Hermes resolves it to, and the Hermes default
itself is set by the connector apps (wizard-app-store `adopt_as_agent_default`).
