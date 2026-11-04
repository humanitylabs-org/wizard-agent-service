# Host-shared Hermes import regression evidence

The move importer separates host application/runtime paths from the stopped
agent tree before credentials, quarantine, wiring or restricted admission.

- Fixed host-shared roots: `data/apps`, `bin`, `hermes-agent`, `venvs`, `tools`,
  `node`, `installs`, `runtime`, `vendor`, `lsp`.
- `host_shared_paths` is an optional list of existing relative paths in the
  reviewed plan. For example, `scripts` or a specific `state/<host-service>`.
  Re-approve after editing: the existing approval hash covers this field.
- Canonical agent state, SQLite sidecars, secrets, profiles and broad `state`
  or `data` selections cannot be exempted. Symlink aliases and shared file
  hardlinks are rejected for owner additions. Nested/duplicate selections are
  collapsed so an inode is moved only once.
- Same-filesystem renames preserve host inodes and writable descriptors.
  Write-ahead device/inode receipts bracket each rename; undo reconciles
  either location, including death after rename but before journal completion.
  Only import-created empty host parents are removed. Unexpected siblings or
  replacement inodes cause a refusal, not recursive deletion.
- Both `/proc` and lease-fallback writer checks exclude only selected subtrees;
  agent-state writers still refuse admission. Restricted metadata collection
  also skips host-shared trees, so undo cannot chmod/reown live host app files.
- Host-shared paths are absent from the agent home, quarantine and mounts.
  Existing mount validation rejects explicitly requesting these source paths.

## Counterfactual

Before editing production code, the five new `test_host_shared_*` tests were
run against upstream `3d86b7eee0dccce00d2b82e9d1cab699a1a6ede1`.
The process exited **1** (5 tests, 22 failures and 3 errors including subtests):

| Regression | Old behavior |
| --- | --- |
| `test_host_shared_move_keeps_host_inodes_and_bytes` | Host `data/apps` disappears |
| `test_host_shared_absent_from_sealed_home_and_mounts` | Paths go into quarantine / owner additions remain in home |
| `test_host_shared_writer_allowed_but_state_db_writer_refused` | Host app/script/state writers raise `source_has_writers` |
| `test_host_shared_undo_crash_between_renames_exact_tree` | No host-shared rename occurs, so crash injection is never reached |
| `test_host_shared_invalid_paths_rejected` | Invalid selections are accepted |

The tests were then strengthened to cover every journal write boundary,
reverse-rename crash windows, explicit mount denial, prefix-sibling writers,
memories/sessions/skills/cron writers, the lease fallback, and restricted
admission's metadata scope. The exact-tree checks compare each directory/file
inode and all fixture file bytes, including the original home inode. Paused
cron wiring now preserves its inode like config and `.env`; its bytes and
paused behavior are unchanged and the original is already journal-backed.

## Lightweight verification (no Docker or live service operations)

```sh
# Supply PyYAML and python-dotenv in the test interpreter, e.g.:
uv run --no-project --with 'PyYAML>=6.0.2,<7' --with 'python-dotenv>=1,<2' \
  python3 -m unittest tests.test_hermes_import tests.test_restricted_import -v
node scripts/test-hermes-import.mjs
```

All fixtures use temporary owner homes; no real-home apply/take-over, service
stop/start, live database copy or private-agent reads are needed. These tests
prove source behavior, not authorization or readiness for a live cutover.
A read-only host manifest must still identify services referencing protected
agent state; those cannot be made safe by host-sharing their state files.
