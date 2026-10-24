# Agent-scoped Spaces

REUSE: authenticated gateway caller identity and built-in tool dispatch; existing ui-preferences storage/validation and synchronous atomic replacement; current per-agent session pagination and archived-sessions reader.
EXTEND: Spaces filing module/run note, gateway built-ins, agent gateway provisioning (including no-app private agents); extract the existing per-agent session loader rather than adding a history reader.
NEW: scoped tool adapter and isolation tests; no new UI component, preferences-write grant, content reader or cross-agent authority.

Acceptance: metadata-only own-thread search including archives; own Space list/create/add/remove/delete; unknown and foreign targets indistinguishable; checked ownership before synchronous read/modify/write; no lost concurrent membership edits; main CLI defaults to hermes. Synthetic private isolation tests only. Deploy a separate integration branch from the release currently serving, using the guarded deploy helper; real philosopher gateway calls without inference and exact main Space membership comparison; private live tool listing only.
