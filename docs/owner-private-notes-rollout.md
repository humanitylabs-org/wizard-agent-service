# Private notebooks: staged owner-only rollout

Private agent notebooks still belong in the owner's human Notes view; this is not permission for one agent to read another's private memory.

`WIZARD_OWNER_PRIVATE_NOTES` is **off unless exactly `1`**. Unset/`0` hides private and hidden agents from `/wizard/v1/agent-notes` and answers 404 for their list/read/search/HEAD routes. Standard visible notebooks and existing path gates remain. Do not set `1` on the current main/live-based service: network ownership is not shell possession and app scripts share that identity.

This is a containment switch, not the browser trust boundary. It does not close chat, run, Settings, Store or alternative owner file routes. Enable private notebook display only with the separately reviewed browser boundary: shell-only credential on every owner read/mutation; opaque sandboxed app frames; a scoped Notes broker or trusted shell view; no generic app fetch proxy; hostile-page browser tests and native main-frame isolation proven; coordinated release approved. The boundary draft additionally refuses startup if private notebook opt-in is requested without the boundary.

No live configuration change, deploy or merge is authorized by this PR. Synthetic tests demonstrate the change; application compatibility and release installation remain separate gates.
