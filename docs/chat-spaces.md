# Agent-owned Chats Spaces

`ui-preferences.spaces` is an owner-managed array (50 collections, 500 thread IDs each). A Space may
include `agent`, an exact agent id; old collections without it belong to `hermes`. Nothing migrates
or removes old membership. Names are owner data, not instructions. Main and routed run notes include
only the selected agent's names and ids, up to 30.

The final hidden `WIZARD_STATUS_V1` JSON may contain optional `space` alongside `state`, `ask`,
`subject`, `title` and `app_id`. Only emit an existing Space id when the thread clearly belongs there;
omit when uncertain and never invent a Space. Malformed, unknown and foreign-agent ids are ignored.
The service appends membership synchronously via the existing read/merge/atomic-rename preference
writer; repeated results are idempotent and never remove other memberships. Full collections are
left unchanged. Final statuses are consumed on completed durable-queue lookups, direct run reads,
and canonical session-list projection (covering CLI-originated threads). There is no historical
whole-history sweep. An idle CLI-originated result is filed when its session is next projected.

The shell has All plus visible agent tabs, not separate Space tabs. The active agent tab opens its
picker; a Space selection retains the agent colour and replaces the label. New Space creates the
collection with its agent id, then uses the ordinary durable new-chat send path to ask that agent to
populate the existing id. The fill thread joins it. Existing-thread replies retain their own route.

`agent.json.hidden` is an optional boolean, owner-PATCHable via `/wizard/v1/agents/<id>`. It affects
shell discovery, not runtime authority or lifecycle. GET still includes hidden agents for Settings /
Agents administration. Hiding never stops work or revokes an existing app binding.

## Agent-scoped built-in tools

Every authenticated agent gets `spaces_list`, `spaces_create(name)`,
`spaces_add(space_id, thread_ids)`, `spaces_remove(space_id, thread_ids)`,
`spaces_delete(space_id)` and `spaces_search_threads(query, offset, limit)` on the existing wizard
MCP gateway, with no app ticking. Agents use the MCP-prefixed names shown by their harness. Private
no-app agents also receive the gateway config, but their app permissions remain unchanged. New
routed run notes explain the tools even when the agent has no Spaces. The gateway derives identity
from the caller's own credential; an `agent` argument is rejected, never trusted.

List returns only own `id,name,count`. Create forces the caller's agent id and reuses a same-name
collection. Missing and foreign collections return the same error. Membership updates check each
canonical thread against the caller's own runtime, then fresh-read/modify/atomic-rename synchronously
(no await between read and write). Concurrent calls and status filing cannot overwrite one another.
Repeated add/remove has no additional effect. Delete removes the collection, never its threads.

Search reuses the existing per-agent session pagination/visibility and archived-sessions reader,
not a new history reader. Results contain only own IDs, titles, subjects where present, and archive
flags; no message text. Empty query lists candidates. Page while `has_more`. The tool increases the
shared reader's default archive-100 limit to a bounded 100000 and fails closed at that bound instead
of claiming an exhaustive result. Unknown threads or unavailable runtimes never authorize edits.

The main agent retains its owner-authorized `wizard-spaces` CLI. Its default list/search/edit/output
scope is `hermes`; explicit `--agent` is an owner-operator option, not a container capability. Routed
containers receive neither owner preferences-write authority nor host credentials. Existing whole-array
owner shell/CLI writes still lack cross-client compare-and-swap; serialize those manual edits.

### Residual privacy/storage boundary

Space names, ownership and membership IDs still live in owner-readable box-wide ui-preferences.
The owner shell/preferences API can see them; Space creation is not an encrypted storage boundary.
Private thread titles/content are not put in preferences or exposed to another agent by these tools.
The existing 50-Space box-wide capacity is unchanged. Live private verification is tool listing only;
private isolation is exercised with synthetic fixtures.

## Evidence

- `tests/thread-spaces.test.ts`: parser/schema, same-agent validation, idempotent membership.
- `tests/thread-spaces-http.test.ts`: real HTTP service, synthetic upstream only (no inference), run
  instructions and final-status membership; routed presentation privacy and namespace isolation.
- `tests/agents.test.ts`: hidden boolean validation, persistent GET readback and no runtime stop.
- Wizard UX `qa-chats-focus.cjs`: picker gestures, Back, labels, hidden agents, and fenced durable
  new-chat transport including both query and body agent routing.
