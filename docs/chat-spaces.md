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

## Authorization boundary / routed back-fill gap

The shipped UX `skills/wizard-spaces` helper uses the existing owner-authorized preferences route.
`create --agent ID` assigns ownership, `search SPACE_ID QUERY` searches only that agent's canonical
thread list, and `add SPACE_ID --agent ID THREAD_ID...` appends to that exact collection. Whole-array
owner edits do not provide compare-and-swap across clients; serialize manual collection edits.

Routed containers do not automatically inherit host-installed skills or an owner preferences grant.
Do not copy owner credentials into them, widen their network/permissions, or bypass preferences by
writing files. They may report a missing skill/403 when asked to fill a Space. Status-based filing is
service-owned and still works for those agents. Historical back-fill is fully supported for the main
agent, but adding scoped collection-write authority to restricted agents is separate work.

## Evidence

- `tests/thread-spaces.test.ts`: parser/schema, same-agent validation, idempotent membership.
- `tests/thread-spaces-http.test.ts`: real HTTP service, synthetic upstream only (no inference), run
  instructions and final-status membership; routed presentation privacy and namespace isolation.
- `tests/agents.test.ts`: hidden boolean validation, persistent GET readback and no runtime stop.
- Wizard UX `qa-chats-focus.cjs`: picker gestures, Back, labels, hidden agents, and fenced durable
  new-chat transport including both query and body agent routing.
