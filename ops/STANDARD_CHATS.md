# Read-only standard-chat transport

`permissions.read_standard_chats` is private-only and explicitly revocable. It does not enable the general app MCP gateway or install shared history/memory mounts.

For containers that already have a correctly scoped app-gateway transport, the managed `standard_chats` MCP URL derives from that gateway's origin. For a legacy container deployment with no app gateway, set **`WIZARD_STANDARD_CHATS_URL`** on the Agent Service to an independently reachable canonical `/wizard/standard-chats/mcp` URL. Enabling the permission without either transport is refused before persistence. `WIZARD_AGENT_BRIDGE=off` may remain off.

`ops/standard-chats-relay.py` supplies an optional narrow legacy transport. Run it on the host with:

- `WIZARD_STANDARD_RELAY_BIND`: a configured private container-bridge address (default loopback, never a public/all-address listener).
- `WIZARD_STANDARD_RELAY_PORT`: its dedicated port, default 18986.
- `WIZARD_STANDARD_RELAY_UPSTREAM`: the Agent Service's loopback HTTP origin, default `http://127.0.0.1:8923`.

The relay forwards only POST on the exact read-only MCP path. It retains the agent bearer but rejects owner, browser-origin and proxy-identity headers; it has no keys, owner API, general app route or history store. The Agent Service still authorizes the agent and permission for every call. Inputs/outputs/timeouts are bounded; redirects are not followed. Configure service resource limits. Do not point the general `WIZARD_AGENT_GATEWAY_URL` at this read-only relay.

Restricted agents continue using their isolated edge, never this legacy host transport. The edge allowlist now includes only POST for the read-only route; rebuild/publish the normal pinned edge image before adopting it there. This change does not claim a new restricted-runtime container/image conformance run.

## Activation and undo

1. Prepare the relay, its narrow private bind and the Service environment. Prove the relay using disposable local fixtures first: `python3 tests/test_standard_chats_relay.py`.
2. Deploy the Agent Service only through its ordinary lifecycle/approval gate. Merely staging a relay or environment file does not deploy it.
3. While the private runtime is idle, enable the permission through the owner Agents API/UI. Read back the exact agent, verify its managed MCP configuration, and refresh only that private runtime if needed. Never share or mount the standard writable database.
4. In hidden owner-created test chats (hide and verify before each first message), seed a standard-only answer and ask the private model to retrieve it through the MCP. Verify only those own test outputs/tool usage. Delete both own probes, recheck isolation counts, and never open real private threads.
5. Undo by revoking the permission and reading back false. Disable/remove the narrow relay/environment only if no other private agent depends on it. Reverting a transport does not justify restarting the main agent outside its lifecycle gate.
