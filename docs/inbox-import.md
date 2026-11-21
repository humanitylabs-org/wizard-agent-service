# Importing old Wizard Uploads files (issue 423)

A box that moves from the old Wizard Uploads service (wizard-inbox, port 8941) to the built-in file store
(`WIZARD_MEDIA_ROOT` set, `WIZARD_INBOX_INTERNAL_TOKEN` unset) would otherwise lose every attachment in its
older chats: those chats name `drop_<32 hex>` ids, and the built-in store only knew its own `wf_` ids.

Two parts, both off until someone uses them:

1. **The import** (`server/inbox-import.mjs`, one time, safe to run again). It opens the old service's
   `inbox.sqlite3` read-only and, for each row in `drops`, hard-links the blob into
   `<media root>/Inbox/<date>/<name>` (no extra disk; a copy only where the filesystem cannot link, such as
   another disk). The record keeps the original id, name, type, size, sha256, date and `duplicate_of`, plus
   `imported_from: "wizard-inbox"`. The old blob folder is left in place, so the agent's old `trusted_path`s
   keep working. It reports `imported`, `already_present`, `missing`, `size_mismatch`, `invalid`, `linked`,
   `copied` and `copied_bytes`, and the first 50 problems by id. `--dry-run` reports the same counts and
   writes nothing. A second run adds nothing; a run that stopped half way reuses the links it made.
2. **The switch** `WIZARD_MEDIA_LEGACY_IDS=1` (option `mediaLegacyIds`, default off). With it on, the
   built-in store serves the imported `drop_` ids: `/wizard/files/<id>/content` (range requests included)
   and attachment resends. With it off nothing changes: `drop_` ids are refused as before.

## Running it

Run it where the old data folder and the media folder are on the same disk (usually the host), with the
paths as seen there:

```sh
node server/inbox-import.mjs --inbox-dir ~/.hermes/data/apps/wizard-inbox \
  --media-root <runtipi>/media --index ~/.hermes/state/wizard-mobile/media-files.json --dry-run
# check the counts, then run again without --dry-run
```

Options: `--inbox-db <file>` or `--inbox-dir <dir>` (default `$WIZARD_INBOX_DB_PATH`, else
`$HERMES_HOME/data/apps/wizard-inbox/inbox.sqlite3`), `--blob-root <dir>` (default: the database's folder;
blobs outside it are refused), `--media-root` (default `$WIZARD_MEDIA_ROOT`), `--index` (default
`$WIZARD_MEDIA_INDEX_PATH`, else `$HERMES_HOME/state/wizard-mobile/media-files.json`). The file is also in
the Service image, so `docker exec <service> node server/inbox-import.mjs ...` works when both folders are
mounted there.

Then set `WIZARD_MEDIA_LEGACY_IDS=1` for the Service and restart it. The index is appended in batches of
500 in one write each and never drops records already listed. Run it while the box is quiet: an upload saved in the same instant as a batch write could be missed from the list.
