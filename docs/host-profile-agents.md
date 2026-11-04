# Host Hermes profile agents

A pre-existing host Hermes profile can be offered in Wizard's Agents registry without creating another container. Provision `<agentsDir>/<id>/agent.json` with the ordinary schema-1 identity, model and permissions metadata and:

```json
"runtime": { "kind": "profile", "profile": "quick" }
```

Both the registry id and profile name must match `^[a-z][a-z0-9-]{0,30}$`. The profile name may differ from the agent id. Store that profile's own `API_SERVER_KEY` in `<agentsDir>/<id>/runtime.key` (mode 0600). Never use the main gateway key for profile traffic.

The service uses its configured main Hermes **origin**, plus `/p/<profile>`, independently of the container network mode. Health is checked at `/p/<profile>/health`, with the profile credential. All existing non-main-agent session, run, SSE, steer and stop proxy paths retain this prefix and the profile key. Thread pins and agent badges are unchanged.

Profiles share the already-running host gateway lifecycle. Start/stop and PATCH return `409 profile_agent_read_only`; they never call the container driver. Internal driver-backed recap deliveries also return that error. POST `/wizard/v1/agents` remains container-only and rejects a profile runtime. Model/tool/permission metadata must describe the already-configured profile; this feature does not rewrite its Hermes configuration or enforce a container boundary. Automatic app synchronization leaves these file-provisioned records unchanged. Configure profile capabilities in Hermes itself.

## Verification

```sh
npx vitest run tests/profile-agents.test.ts tests/agents.test.ts tests/agents-sealed-apps.test.ts tests/agent-principals.test.ts tests/unified-chats-routing.test.ts tests/app-bindings.test.ts tests/share-agents.test.ts
```

Use synthetic registries for automated tests. For live acceptance, create an explicitly Quick-targeted session through `/wizard/hermes/api/sessions`, admit `/wizard/hermes/v1/runs`, then consume its `/events` stream. Verify the session exists in the profile's state.db and not the main state.db, and that the agent-scoped sessions list decorates it with the expected badge. No host gateway or run-keeper restart is needed.
