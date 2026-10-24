# Mac launch source reconciliation

Trunk intent: retain approved main behavior, privacy boundaries and current contracts.
Mac/live intent: retain protected Mac recovery, app lifecycle, maintenance and live owner UX.

- `ops/agent-runtime/agent_runtime.py` hunk 0: disjoint-intent — Keep Claude login and managed state mounts.
- `ops/agent-runtime/agent_runtime.py` hunk 1: disjoint-intent — Keep ImportDriver/restricted routing and maintenance parameter.
- `ops/agent-runtime/agent_runtime.py` hunk 2: disjoint-intent — Keep all runtime actions and maintenance routes.
- `ops/agent-runtime/agent_runtime.py` hunk 3: disjoint-intent — Keep both CLI options.
- `ops/agent-runtime/agent_runtime.py` hunk 4: disjoint-intent — Initialize both drivers and maintenance.
- `server/agent-bridge.mjs` hunk 0: disjoint-intent — Keep builtins plus lifecycle budgets.
- `server/agent-bridge.mjs` hunk 1: superseded — Mac list includes install/search guidance.
- `server/agents-http.mjs` hunk 0: disjoint-intent — Main projectAgentHistory supersedes old file-only projection; retains retry and media privacy.
- `server/fixture.mjs` hunk 0: superseded — Keep neutral trunk fixture identity.
- `tests/thread-history-marker-projection.test.ts` hunk 0: superseded — Keep trunk neutral fixtures and additional recovery case.
- `tests/thread-history-marker-projection.test.ts` hunk 1: superseded — Keep trunk neutral fixtures and additional recovery case.
- `tests/thread-history-marker-projection.test.ts` hunk 2: superseded — Keep trunk neutral fixtures and additional recovery case.
- `server/index.mjs` hunk 0: disjoint-intent — Keep current tailnet ingress plus isolated app listener.
- `server/index.mjs` hunk 1: disjoint-intent — Bind independent tailnet and isolated apps listeners.
- `server/service.mjs` hunk 0: disjoint-intent — Union gateway and app lifecycle imports.
- `server/service.mjs` hunk 1: disjoint-intent — Union principal/runtime imports with maintenance/control boundary.
- `server/service.mjs` hunk 2: disjoint-intent — Main projectAgentHistory already handles file markers and scoped media.
- `server/service.mjs` hunk 3: disjoint-intent — Apply maintenance fence plus qualified recovery admission.
- `server/service.mjs` hunk 4: disjoint-intent — Apply maintenance fence plus qualified recovery admission.
- `server/service.mjs` hunk 5: disjoint-intent — Keep strict principals and private side stores plus isolated app routes; use renamed base verifier.
- `server/service.mjs` hunk 6: disjoint-intent — Principal scope first; #96 browser boundary and maintenance before phone/setup; dedicated tailnet identity retained.
- `server/service.mjs` hunk 7: disjoint-intent — Keep gateway-only restriction and Mac local-owner boundary.
- `server/service.mjs` hunk 8: disjoint-intent — Keep heavy stop/steer bookkeeping plus scoped shared-file admission.

No live deployment, image publish, release or guest rebuild is authorized by this source reconciliation.
