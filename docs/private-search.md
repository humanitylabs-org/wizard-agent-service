# Private Tinfoil search (native MCP)

REUSE stock Hermes native HTTP MCP and the managed `TINFOIL_API_KEY` bearer handoff.
EXTEND `server/agents.mjs`'s Service-owned renderer; keep ordinary web/browser disabled.
NEW no Hermes-core or UI implementation.

For private Tinfoil agents the generated `tinfoil_search` server is
`http://agent-<id>-tinfoil:3302/mcp`. The companion runtime change supplies a
second official `ghcr.io/tinfoilsh/tinfoil-proxy:0.2.3`, pinned to enclave
`websearch.tinfoil.sh` and repository `tinfoilsh/confidential-websearch`. It
shares only the inference proxy's existing per-agent network namespace. It
has no host publication, new independent uplink, credential volume or provider
key environment. This is an attested search-route extension, **not** a claim
that a legacy agent has sealed outbound networking.

Both `X-Tinfoil-Tool-PII-Check` and `X-Tinfoil-Tool-Injection-Check` are the
literal string `true` on every native MCP request. Stock Hermes expands the
same `${TINFOIL_API_KEY}` used for inference; the Service never holds the key.
No ordinary web fallback is enabled. Sampling is disabled. The official proxy
verifies provenance, enclave measurements and the domain certificate and does
not provide a plaintext upstream fallback. PII filtering is best effort and
does not sanitize fetch URL contents.

Incognito copies the managed configuration into its RAM sibling and preserves
the same scoped network memberships. Its policy allows the search MCP tool;
it must not regenerate a direct-public search route.

## Verification

On a synthetic forum agent with the exact stock live image, the native tool
`mcp__tinfoil_search__search` returned a current news article with a cited URL.
Both official proxies reported `securityVerified: true` and five successful
verification steps. Websearch release: `v0.5.16`, digest
`1a56a78bc6d06417278495452c7b25b8944ef65dfc346868b2c780043e7840b2`.
A separate synthetic marker query returned three cited results with
`pii_checked: true`; marker and credential were absent from proxy stdout/stderr.
Synthetic containers/networks were removed. These are synthetic proofs, **not
live deployment or live Incognito acceptance**.

Run `node --test tests/private-search.node.mjs`. Runtime companion regressions:
`cd ops/agent-runtime && python3 -m unittest test_private_search test_agent_runtime test_incognito_runtime`.

## Coordinated rollout and rollback

Deploy the companion runtime before this renderer, only in a direct session
admitted for Agent Service lifecycle changes. Existing installed Runtipi
recipes acquire the search service through their final Service-managed owner
override; the renderer change alone is insufficient. Ensure no private run or
Incognito sibling is active before apply. Managed harness migration may apply
and restart the agent automatically on Service startup, so do not casually
restart the renderer ahead of that check. Record Docker StartedAt before/after.
Do not inspect private homes or normal transcript content.

The private agent's original uid/gid, home mount, inference route and app
grants remain unchanged. The runtime preserves existing JSON owner override
fields/appEnv and refuses unreviewed custom YAML or a conflicting search service.
Readback verifies the final owner override. This scope does not authorize a
network-seal migration.

Rollback: stop admission of new Incognito chats and wait until the agent is
idle; restore the prior renderer/runtime releases, regenerate only the managed
harness through the Service, and restore the captured pre-change Runtipi owner
override through its API. Restart the private agent once through its driver.
Remove only the new search container after it is no longer referenced. Never
restore/copy/delete a private home or revert owner data. Verify original
StartedAt change, health, original network membership and absence of the search
container. Live rollback is **prepared/documented, not exercised** here.
