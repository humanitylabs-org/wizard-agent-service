# Disposable private chat: main-based port, not activation approval

Source port: live `89c73e5` plus fixture repair `bb3de2a`, on shared main `aba3efa`. The private-search renderer is deliberately a separate PR. No live source, agent homes, transcripts or model calls were inspected or exercised here.

Reuse: extend the existing owner principal, agent runtime helper, stock Hermes image and secret-safe `proxyToAgent`; no forked runtime or alternate durable chat catalog. Temporary run/session IDs remain in the dedicated API and cannot fall through to ordinary history routes. The helper copies eligible state into a RAM sibling, checks swap/mount boundaries before seeding, disables durable orchestration/platform listeners, leases/cleans up the sibling and drops Docker logs.

## Static privacy review: REVISE / keep draft

- `INCOGNITO_INSTRUCTIONS` asks for confirmation before external writes, but the plugin policy blocks durable orchestration only. It does not mechanically enforce confirmation for Files/Calendar/other app writes or shell/HTTP tools. Do not call that prompt a security boundary. Add receipt-bound owner approval at the mutation boundary, or narrow the advertised behavior and tool capabilities after policy review.
- `_discover` filters by helper-owner label only when configured. Production currently permits no owner label; an unscoped startup sweep may remove another helper instance's temporary siblings. Require a stable helper identity before multi-instance acceptance.
- `incognito_available` advertises availability from the presence of helper methods, while the runtime refuses a distinct restricted driver. Test and reconcile capability discovery with the actual installed driver; do not silently substitute a normal runtime.
- Home export uses `os.walk`/`lstat` followed by `tar` pathname reopening. A mutable source home is not a pinned immutable manifest. Prove source-link/replacement and extraction confinement using synthetic race fixtures before claiming the RAM copy cannot read outside the selected source.
- RAM mount and no-swap checks are source contracts, not current runtime evidence. Forum Docker execution must prove tmpfs/no-swap, log suppression, lease expiry/close, restart orphan cleanup and zero durable Service/history/catalog writes with synthetic canaries. Include failure during seed and all cancellation/shutdown paths.
- Private fallback policy must be verified on the actual generated configuration and every enabled tool transport, not inferred from a model label. The seed intentionally preserves MCP/plugins/configuration. No current live-private-agent acceptance is claimed.

## Verification lane

CI explicitly executes `tests/incognito.node.mjs`, `ops/agent-runtime/test_incognito_runtime.py` and the normal regression suite. These are synthetic/fake-helper proofs, not an end-to-end confidential transport, deletion or deployment proof. Forum stock-Hermes/Docker/privacy probes remain required. Neither CI success nor this PR authorizes promotion or a live restart.

## Compatibility

Ordinary chats retain existing defaults and source fields except the explicit `incognito_available` capability. Existing stopped-default/legacy fixtures retain their declared comparison exclusions. No package/release version is transplanted from the live stack. This capability is not removed from the retained live baseline while the draft is reviewed; there is no cutover authorization.
