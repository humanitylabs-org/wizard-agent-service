# Agent-bound heavy-work relay (S2d slice 1)

This is an **opt-in host relay**, not a worker credential inside an agent. The existing Hermes host plugin continues to use `POST /wizard/internal/heavy/{submit,status,cancel}` with the Service's heavy bearer. Its receipts and idempotency identities remain unchanged.

## Owner provisioning

1. Provision the existing Service heavy lane (`WIZARD_HEAVY_STATE_PATH`, `WIZARD_HEAVY_TOKEN`, the host RPC/SSH transport and run queue) as before. Keep the worker SSH key and host heavy token exclusively on the Service/host.
2. Set **`WIZARD_AGENT_HEAVY=on`** on the Service. Any other value, including unset, disables the new route (404).
3. In the **Service-owned** `<agents-dir>/<agent_id>/agent.json`, set an explicit boolean grant:

   ```json
   { "grants": { "heavy": true } }
   ```

   This is an additive field in the existing schema-1 document, not a replacement document. Only the owner/operator provisions it in the host registry; it is not a permission the agent can set through tools or the Agents API. Do not place this authority document in the agent's writable home. Removing the grant revokes new submissions and continuations; the next queue tick cancels outstanding work rather than submitting it.
4. Set **`WIZARD_HEAVY_ROOT`** to the absolute POSIX staging root on the worker (the agent route deliberately does not fall back to `WIZARD_WORK_ROOT`). Stage each agent's source below `<WIZARD_HEAVY_ROOT>/agents/<agent_id>/`. Staging/upload automation is outside this slice.
5. Provision the updated restricted-agent edge image containing `sidecars/edge.py` from this revision. Its allowlist forwards only the four exact POST routes below; it still checks the agent's own token hash and strips owner identity headers. This change does not deploy or restart any runtime.

Only a **restricted**, non-Hermes, standard-privacy agent with the grant qualifies. Private agents and the recovery role are always refused, even with a forged/stale grant. Eligibility is rechecked for submission, worker dispatch and continuation. Disabling the global flag also fences/cancels outstanding agent work on the next tick. The authenticated owner can still inspect/cancel existing jobs after removing a grant or disabling the global agent path.

## Restricted plugin/client contract

Use the edge sidecar origin already assigned to the restricted agent: **`http://edge:8923`**. Call:

- `POST /wizard/v1/agent-heavy/submit`
- `POST /wizard/v1/agent-heavy/status`
- `POST /wizard/v1/agent-heavy/cancel`
- `POST /wizard/v1/agent-heavy/artifacts` (returns the job receipt/artifact metadata, not arbitrary file bytes)

Authenticate with **the agent's own gateway key**, as for `/wizard/mcp`. Do **not** configure the host `WIZARD_HEAVY_TOKEN`, a Thales SSH key or the worker RPC token inside an agent. The existing loopback-only host plugin is unchanged; an agent adapter must call these new routes using the edge origin and gateway key, not relax the host plugin's origin validation or call the internal host endpoint.

Submit body:

```json
{
  "session_id": "current-agent-session",
  "key": "compile-1",
  "spec": {
    "cwd": "/worker-staging/agents/example/project",
    "argv": ["npm", "run", "build"],
    "timeout_seconds": 900,
    "lane": "light"
  }
}
```

`/worker-staging` above is an example configured heavy root, not a default. `agent_id` is unnecessary: the authenticated agent principal on `WIZARD_AGENT_PORT` supplies it. If present, it must match. An agent key on the host listener, the host bearer on the agent listener, owner proof through an edge, and host-heavy requests from an agent are refused.

Status/cancel/artifacts bodies contain `session_id` and `job_id`. Foreign sessions and foreign/missing job ids return 404. Receipts, including artifact metadata, are scoped to the same `(agent_id, session_id)` pair. On the **owner listener**, an authenticated owner may inspect/cancel any job using the new status/cancel/artifacts routes and `job_id`; owner submission through this route is not supported. A heavy bearer alone is not owner authority.

## Limits and continuation safety

- At most **two nonterminal jobs per agent**, counting cancellation-pending jobs (429). Same-key retries replay before the cap check. Identity is unique per `(agent_id, session_id, origin run, key)`; imported identical session ids on different agents do not collide.
- `cwd` must be an absolute normalized POSIX path inside that agent's staging root. Traversal/dot segments, foreign roots, prefix siblings, backslashes, percent/shell-style expansions and control bytes are rejected (400). Extra spec fields are refused.
- `argv` and timeout use the existing worker contract: 1–100 nonempty arguments, bounded argument lengths; integer timeout 1–86400 seconds. Lanes are `heavy` (default) or `light`; light is capped at 900 seconds, matching the host plugin. The adapter supplies timeout defaults (3600 heavy / 900 light); the wire spec requires an explicit timeout.
- Session ownership is checked by an authenticated read of **that agent's runtime**, not global pins. A Service-observed running agent run and immutable observed model/provider route are required. The host Hermes run queue is not repurposed as an agent executor.
- Completion uses the durable outbox's stable `wizard-heavy-<job_id>` idempotency key and a persisted, frozen wire body. It waits for the original run to become terminal, checks the latest human-request watermark and latest non-heavy run, then posts only to the submitting agent's runtime and original session. Ambiguous admission retries preserve that body and key across restart. New user instructions, Stop/Steer, grant revocation and recovery/private reclassification fence automatic continuation. Host history is never a fallback.
- **This is not a worker sandbox.** The grant authorizes arbitrary worker commands as the configured worker account. String-level cwd confinement cannot inspect remote symlinks or prevent an argv from reading another path. Keep staging owner-managed, free of symlink aliases/escapes, and grant only trusted agents. OS-level worker confinement and artifact transfer require separate work before offering this to untrusted agents.

## Evidence boundary

`tests/agent-heavy-relay.test.ts` exercises the real principal resolver/registry, queue persistence, fake worker/runtime transport, edge allowlist, and real Service listeners on ephemeral fixture ports. Existing focused heavy/principal/agent tests remain the compatibility gate. No live Service endpoint, worker SSH, container deployment, restart or production history is required for these tests. The full suite and real restricted-container/Thales acceptance remain separate release gates.
