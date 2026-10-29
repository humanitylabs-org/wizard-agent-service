# Reply style belongs to each agent

Every owner and every agent uses Own. Summary and Concise are retired. Wizard contributes product facts and protocol, never a reply template or work style.

Two independent layers reach an agent:

1. **Wizard OS context** (product-owned): what Wizard is, Markdown/links/MEDIA/My skin rendering, files, installed apps and jobs, screen context, background-result delivery, the supervisor phrase and the `WIZARD_STATUS_V1` protocol. Detaching an alongside agent removes this layer.
2. **The agent's own persona** (owner-owned): `SOUL.md` in its Hermes home, or the equivalent for another harness. Wizard never copies or overrides it. Lasting “reply like this from now on” requests belong there; different agents can have different voices across attach, detach and other surfaces.

Fresh installs deterministically read Own. Startup no longer makes or persists a randomized Summary/Concise assignment. Existing settings bytes and historical experiment counters remain untouched on startup. Older shells may still PUT `response_style: summary | concise | own`, but GET always returns `own` and these values never change run instructions. Owner authorization and input validation remain enforced.

The shared contract was introduced in wizard-os `spec/RESPONSE_STYLE.md`; this retirement follows [Agent Service #231](https://github.com/humanitylabs-org/wizard-agent-service/pull/231) by @oscarhenrycollins for Miguel and the companion Wizard UX picker removal.

The parity fixture admits fresh and legacy-setting turns through main, host-profile, container and restricted routes and inspects actual upstream instructions for Wizard facts, the persona pointer and status protocol, with no reply-style rules. This proves prompt delivery, not model compliance.

A persona for new Wizard-native boxes remains a product decision for Miguel and James; this change does not seed a house style. Existing owners keep their own persona, including any report-format instructions they chose. Scheduled reporter notifications retain their explicit task-specific short-format contract.
