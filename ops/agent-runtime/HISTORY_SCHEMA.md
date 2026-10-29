# Stopped-history admission

The locked September Hermes runtime creates history schema 30. It must not open a
newer history as a writable runtime merely because SQLite can read extra columns.
The importer now probes the **approved immutable image** in a fresh disposable,
networkless home and compares only the stopped source's schema marker. It never
opens the source with `SessionDB`, runs source migrations or changes the marker.

Both directory moves and portable archives refuse `history_schema_newer_than_runtime`
before source rename, config transformation, ownership transfer, agent start or
the stock import CLI. The restricted staging adapter delegates to the same check.
Existing unversioned/malformed stores fail closed. A missing store is a fresh home.
Nonempty WAL/rollback journals require the source's supported checkpoint/backup
procedure first; the checker does not ignore, delete, recover or checkpoint them.
The immutable read creates no SQLite sidecars. Archived profile histories stay
quarantined under the existing profile policy; they are not activated by this gate.

This is a safety floor, **not a compatibility certification** or a runtime promotion.
Passing a numeric comparison does not prove full history/backup/recovery semantics.
A refusal leaves a journal for the existing supported undo path. If an explicitly
authorized source service was stopped, use that undo path to restore its lifecycle;
a failed admission does not silently restart services or run forward migrations.
The image lock, upstream Hermes core, owner history, models and providers are unchanged.

## Why schema 31 is consequential

Upstream commit `751d8526e3507e8eb7e9e6e453e30019b6f97e29` adds
`messages.message_uid TEXT`, a one-time per-row random UUID backfill and propagation
through message reads, inserts, replacement and compaction clones. The old schema
30 runtime does not know that field. Its startup does not reject a higher marker or
lower it. Its writes omit the new column; replacement can lose durable identities
while leaving the schema marker at 31. Later v31 startup gates the backfill on
`current_version < 31`, so a marker already at 31 does not repair that history.
This is a source-proven semantic risk, not a claim that any owner DB was inspected
or that a lower fresh schema alone proves physical SQLite corruption.

`tests/history_schema_acceptance.py` is an explicitly admitted Forum-only real
Docker proof: exact pinned-image source hashes, same-version read/append/replace/
restart, a synthetic v31 column/backfill fixture, an unguarded-write negative and
actual importer move/archive refusal with synthetic byte/inode preservation and
undo. No model is contacted. The v31 fixture is constructed using the exact
upstream column/backfill delta; it is not presented as a full v31 runtime rehearsal.

Run focused unit contracts with `tests/test_history_schema.py` (also included in
`node scripts/test-hermes-import.mjs`). Mocked unit contracts are not Docker proof.
No live import, runtime upgrade or database downgrade is authorized by these tests.
A compatible stock-runtime promotion needs its own locked-image acceptance and,
if the image changes, new memory/backup/import proof against that exact image.
