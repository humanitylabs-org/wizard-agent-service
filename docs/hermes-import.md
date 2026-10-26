# Bring your Hermes: owner CLI

## Restricted admission (supersedes the historical direct-container path)

The production `apply` now reserves its record and unique /28 pair through the
Service registry library (`isolation:restricted`, library-only deferred start).
The reservation has `runtime.admission:importing`: lifecycle starts fail closed.
The importer and runtime HTTP lifecycle share the same per-agent OS file lock.

Policy transformation runs in an **unregistered private staging home**. Journals,
originals, quarantines and staged credentials are never mounted into the agent.
The stopped tree is re-owned in place with a network-none, read-only-root helper
using only CHOWN/FOWNER/DAC_OVERRIDE. A uid-10000 helper verifies/populates the
sealed home; `RestrictedDriver` alone starts the actual agent. The agent is never
run as root or the host UID. HOME and HERMES_HOME are `/opt/data`.
Approved RW mounts may separately grant a positive `supplemental_groups` GID
that actually owns that group-writable mount. This does not change the agent UID,
primary GID or sealed-home ownership, or make any additional host path visible.
The importer never chmods a workspace or grants root's group.

The database is not copied: directory renames preserve its inode through staging,
admission and undo. Renaming a foreign-owned 0700 directory across parents needs
DAC_OVERRIDE; the importer temporarily parks its owner-owned enclosing directory
under the target and uses one constrained fixed-path rename inside **one** bind
mount. Separate bind mounts would return EXDEV even on the same disk. It never
chmods the sealed directory to make host access possible. Undo reverses placement
before re-owning the external staging home; the live target is never unsealed.
Fixed transfer names reconcile crashes around both rename boundaries.

All `credentials` entries start `approved:false`. Review each dotenv name, auth
provider/pool, inline config credential and credential file (including OAuth,
GitHub hosts, SSH keys, `credentials/`, `secrets/`). Unapproved entries are removed
before sealing. Dotenv parsing is structured, including multiline values; the
old `approved_env_names` list has no authority. Credential-directory replacements
must enumerate exact `approved_files`; never approve the host SSH/gh directories.
Token scope is an independent acceptance check, not inferred from filenames.

Imported agents have standard owner-visible history, **not** the confidential
private-history preset. App auto-grants are disabled durably; Privacy.com app IDs
are refused by policy. MCP remains denied unless separately implemented/reviewed.
Imported memory/plugin config remains the managed base. Owner model/tool changes
merge into that base on the next stopped sync rather than replacing the harness.

Only preloaded images are accepted. Restricted imports never build or pull on the
control plane. Preinstall/cache PyYAML and python-dotenv for lifecycle refreshes.
Do not use the old bridge-network/native-UID runbook below as an acceptance path.
GitHub HTTPS uses the existing main sidecar image and its public TLS/443 allowlist.
No new sidecar image is needed. No host TCP listener, firewall change, root command,
SSH proxy/key or Tailscale socket is part of this migration. Raw SSH belongs to the
separate Machines component and is intentionally unavailable on day one.

The scan offers `grants.heavy:false` plus a separate `grant_items` approval item.
Setting the grant true requires explicit owner approval of that item, covered by
the plan hash. Archimedes has James's approval dated 2026-10-22. The admitted
`agent.json` has `grants.heavy:true`; a trusted `wizard-agent-heavy` plugin calls
only `/wizard/v1/agent-heavy/{submit,status,cancel}` through edge using this agent's
MCP key and originating session. It never carries the host heavy token or SSH key.
The existing Service enforces agent/session binding, staged worker-root scoping,
rate limits and continuation revalidation. A receipt is not completion: require a
terminal completed receipt with exit code 0. Missing/offline relay is a failed gate,
never permission to fall back to host credentials or shell access.

The separately deployed Service must support owner-only `POST
/wizard/v1/agents/<id>/prepare-import`: it creates only the reserved importing
agent's Unix socket without starting a runtime or rewriting the imported harness.
`GET /wizard/v1/agent-options` reports `import_capabilities` for fail-before-copy
rehearsal preflight. Enable the existing `WIZARD_AGENT_HEAVY=on` and
`WIZARD_AGENT_HEAVY_SANDBOX=on` only in a separately authorized Service release;
this task does not restart or reconfigure it. If strict owner proof is configured,
set `WIZARD_IMPORT_OWNER_PROOF_FILE` only in the owner CLI environment; the proof
is used for owner-loopback admission requests, never copied into the plan/home
or printed. Health uses the agent's ingress Unix
socket; no TCP port is published.

The scanner reports `ssh`/`scp`/`rsync` references to Thales in skills, cron and
scripts as `needs Machines/heavy job`, with file/line references and no command or
secret values. Cron execution outputs are not treated as prompt/script definitions.
Field-name filtering and credential-path classification stay linear per line,
including long script literals. These dependencies do not become mounts or automatic grants.
Review cron disposition separately: bounded staged builds can become heavy jobs;
host reachability, recovery and maintenance stay on the recovery host until the
Machines design is authorized.

The owner may approve an existing GitHub OAuth `hosts.yml` as a **single file**
credential grant, with its actual scopes and rationale recorded in `owner_approvals`
and covered by the plan approval hash. Do not silently scope-expand or copy all
of `.config/gh`. Use an agent-owned gitconfig with an empty credential-helper reset
then `!gh auth git-credential` for `https://github.com`. This preserves existing
GitHub authority only when the owner explicitly approves it; it changes no Private
agent authority. Verify `gh auth status` and private `git fetch --dry-run` as uid
10000, not just public HTTPS or `command -v`.

Status: implementation/acceptance preview, **not approved for a live cutover**. No UI or remote-agent link is introduced. The scheduler is deliberately untouched: only `paused` and `take-over` (Hermes owns its own cron) exist.

## Portable-tree admission safety

Reuse:
- REUSE the owner CLI, approval digest, stopped-writer census, staging journal, restricted admission lock and constrained ownership helper.
- EXTEND credential inventory to every retained `config.yaml`/`config.yml`, JSON/TOML equivalent and suffixed backup at any depth; extend the helper with fd-relative tree operations and a bounded resume command.
- NEW: none at the capability level; `import_tree.py` is the importer's shared internal implementation, not a second importer or runtime authority.

### Inline credentials: names-only refusal, not silent credential loss

`scan` inventories inline credential **key names** in old nested configs as well
as the active root config. `summary.inline_credentials_blocking` is an owner-facing
list of paths and keys; no values or parser source lines enter reports. Literal
`${ENV_NAME}` references are not inline credentials. Retained configs containing
inline credentials refuse `apply` before reservation/move, even if their old
`config-field` entry was approved. This deliberately chooses refusal over guessing
how an arbitrary legacy field maps to a secret store. Move those values to the
agent's approved secret store/dotenv/auth entry, replace the config value with a
supported reference, then rescan and approve. Forbidden host authority must be
removed, not moved into an agent's secret store. Newly discovered retained inline
fields also refuse during the final staged credential inventory. Invalid config
parsing returns only a symbolic error. This is structured config coverage, not a
claim to detect secrets in arbitrary prose, scripts or binary files.

### Hardlinks

Before modifying files or transferring ownership, the stopped moved tree detaches
multi-link regular files using private, fsynced sibling copies and atomic replace.
It never locates or follows the inode's other names. External aliases retain their
bytes, mode and ownership; links and linked directories are never traversed.
Single-link databases retain their inode. An interrupted detachment leaves the
original name complete; ordinary undo remains available. Undo restores original
bytes and metadata, **not hardlink topology**. Private copies can increase disk
use by the size of the linked files; copy failure leaves the journal recoverable.
The ownership helper independently refuses any remaining shared inode.

### Profiles are archives, not extra active agents

`scan --profiles archive` is the default and is covered by the approval digest.
It archives **all** `profiles/*` together with top-level historical bundles named
`profiles-*` or `profiles_*` in the owner-only, unmounted quarantine. These originals
may contain inline credentials, but never enter the admitted home, registry or
managed config. `summary.profiles_archived` names the archived roots. Empty/log-only
profile shells are archived too. Undo restores them. `--profiles refuse` instead
rejects a source containing profile roots; automatic activation/import-as-agents
is intentionally unsupported. Profile multiplexing remains disabled in both modes.

### Ownership count and interrupted sealing

`summary.ownership_source_dry_run` counts **all source entries**, including the root,
directories, files and symlink entries (not their targets), before quarantine.
It reports entries, mismatching uid/gid entries and hardlinked files without
changing ownership. This is not the portable-file count. The final seal counts
only the retained staged tree, using one constrained helper process with a
30-minute budget, fd-relative no-follow stat/chown, and no per-file subprocesses
or full-tree progress list. Entries already owned by uid/gid 10000 are skipped;
ownership metadata is the durable per-entry checkpoint after interruption.

```sh
# Only for a journal interrupted at prepared/sealed, before placement:
wizard agent import hermes resume "$IMPORT_JOURNAL" --dry-run
wizard agent import hermes resume "$IMPORT_JOURNAL"
```

The dry run does not seal, publish or start anything. Resume continues the existing
reserved import from ownership sealing through health verification, under the
same owner and lifecycle locks. It refuses admitted/running homes or other crash
windows: use `undo` for those, then reapply. Completed counts are stored in the
owner-only journal. The helper still has no network, imported code, live runtime
mount, host home or host service namespace. Full-home timing remains an acceptance
measurement, not a promise based on synthetic tests.

The owner launcher dependency fix is tracked separately in PR #155 (python-dotenv
alongside PyYAML). Until that lands, use `WIZARD_IMPORT_PYTHON` with both packages
or run the module with the isolated uv dependencies used by the test runner.

## Commands

From this checkout, add `ops/agent-runtime` to PATH or call its `wizard` executable directly. It uses an isolated uv interpreter with PyYAML; the host runtime helper also needs uv, or `WIZARD_IMPORT_PYTHON` naming an interpreter with PyYAML.

```sh
wizard agent import hermes scan "$HERMES_HOME" --owner-home "$HOME" --out "$IMPORT_PLAN"
# Review the JSON, select individual dependencies/actions, choose network,
# gateway_url, port, image, and move:true for a same-home import.
wizard agent import hermes approve "$IMPORT_PLAN"
wizard agent import hermes apply "$IMPORT_PLAN" --id "$IMPORT_AGENT_ID" --wizard-home "$WIZARD_OS_HOME"
wizard agent import hermes undo "$IMPORT_JOURNAL"
```

`scan` also accepts a stock Hermes backup ZIP. The original archive remains caller-owned; only the importer's filtered transport archive is destroyed automatically. Transfer credentials over the trusted host–box channel, never Files. Delete the caller's archive after verified import/undo. Source and source configuration are read-only until an explicitly approved **move** apply. A plan never contains credential values. `approve` binds all route, mode, image, mount, plugin and environment choices by a digest; changing any choice invalidates approval. Approval is an owner CLI action, not a security boundary against the owner editing their own file.

Same-machine apply renames the directory on the same filesystem and leaves a non-symlink `WIZARD-IMPORTED.json` pointer. No state.db copy is made. It refuses a changing config, cross-filesystem rename, existing target/container, occupied port, source overlap, unapproved mounts, or live writable descriptors. On Linux, unreadable same-UID `/proc` entries fall back to per-file kernel read-lease checks, not a privileged shell. This is a writer census, not a kernel-wide future-writer fence: stop/disable every declared source launcher before takeover.

Cross-machine apply validates **every** ZIP member before extracting anything (absolute/parent/Windows paths, duplicates, links, special files, encryption and size/member limits). It strips per-machine data and uses the pinned image's **stock `hermes import --force`** in a networkless, unprivileged helper with a synthetic native home. The native-home marker prevents stock import's gateway-revival path from touching a host gateway. No Hermes runtime source is patched.

## Reviewable plan

- Each outside reference records file/line, kind (`folder`, `credential`, `tool`, `host-service`, `unknown`) and a proposal. Nothing outside the agent home is carried just because it was found. False-positive example paths remain unknown rather than silently mounted.
- Select a dependency with `approved:true` and an explicit `action`: `mount ro`, `mount rw`, `carry secret`, `available in image`, or `leave behind`. Missing tools must be added to a remotely built image, not mounted from the host.
- Credential copies are private, read-only mounts at their original logical owner-home paths. Optional `credential_source` selects a separately staged, scoped credential instead of copying the owner's broader directory; it is approval-bound, must be inside the owner home and outside sealed/imported state, and is accepted only for `kind:credential` + `carry secret`. Broad credential directories should be replaced with narrowly scoped material (in particular a build-host SSH key/config, not the owner's entire SSH authority). Do not grant a key that can SSH back into the Wizard host.
- `credentials` grants each named item individually, with no provider defaults. `approved_env_names` is deprecated and ignored. Host Wizard/terminal/Docker authority is always removed. Plaintext rollback originals remain outside every agent mount.
- `outside_tools` maps to `agent.disabled_toolsets` and the registry's permissions. No fallback model route is inherited. Toolset permissions are not a replacement for mount/network isolation.
- `approved_plugins` / `approved_mcp` opt into reviewed executable extensions. Other plugins, hooks, named-profile gateways, machine-local binaries/caches, and old Wizard plugins are quarantined, not executed. Named profiles are preserved for undo but not booted as additional active copies.
- `wizard_assets` accepts digest-pinned, path-checked ZIP envelopes for replacement Wizard plugins and system skills (`kind`, `name`, `archive`, `sha256`; use a harmless root `config.yaml` envelope and put asset files at the root). The MCP `wizard` gateway, per-agent token, local terminal, API host/port/key and disabled platform settings always override imported values. A deployment must supply its approved Wizard asset packages; the importer does not trust the source home's old copies.
- Owner home, Wizard home and their ancestors/aliases, another agent, system namespaces and host service sockets cannot be mounted. Nested `.wizard-os` trees and symlinks into the sealed root are refused. Only the agent's own home is a default bind. No host PID namespace, Docker socket, host shell backend or Runtipi install authority is provided. The image's inherited `/opt/data` VOLUME is suppressed for path-preserving imports so it cannot leave an anonymous orphan.

`paused` disables messaging platforms and their dotenv discovery credentials, hooks, curator, profile multiplexing and every cron job (`enabled:false`, `state:paused`, no next run). Original credentials/jobs survive in the journal's unmounted originals. `take-over` requires `move:true`, explicit source service names and `--allow-source-stop`; only after stopped writers are checked does it keep Hermes's own jobs and messaging active. It never imports schedules into Wizard's scheduler.

## Lifecycle, rollback and default selection

The registered record uses existing `runtime.kind:container`, a separate API key and app-gateway key, and an imported-format marker. Agent Service continues to proxy history/runs normally. Its imported harness guard avoids replacing imported configuration with a fresh agent's config; the host helper's ImportDriver supports start/stop/apply with a merge of only Wizard-owned fields. Updating a model/permissions must go through the registry, not directly into the container. The importer keeps memory/provider settings, identity, auth and history on lifecycle restarts. No live Service or host helper was restarted to install this branch during acceptance.

Imported containers do not use compose generation seals. Offline `inspect/census` returns an explicit unavailable result rather than incorrectly treating absence in a compose lookup as proof that a running import has stopped. Agent-private data remains sealed; there is no new generic privileged agent tool.

Undo stops only a container whose import labels match the journal, restores original managed-file bytes/modes and quarantined paths, reverses the directory rename, restores routing if a separate cutover was journalled, and resumes only source units recorded active before apply. A conflicting pointer or concurrent routing edit fails closed. Private credential copies, transport ZIP, runtime keys, imported agent record and temporary data are removed; a non-secret receipt moves outside the registry. Existing owner-owned source ZIPs are not deleted. Directory/record cleanup is verified by a live agent-list readback. Historical Service canary pins/run receipts are separate service-owned projections; do not rewrite its cached global indexes offline.

`route-default JOURNAL --acknowledge-cutover` is a separate **owner cutover** action. It is never called by apply/rehearsal. It snapshots settings and the old main record, sets `agents.default_agent_id`, and marks the old main agent `role:recovery`. It never provisions recovery implicitly: the owner must prepare and verify the independent host runtime with [`recovery-home prepare` and `probe`](hermes-recovery.md) before moving the source. That guide covers the separate code/venv, same-provider sign-in, loopback port, Service environment and owner-only registration. See [CUTOVER.md](../CUTOVER.md).

## Verification

`npm test` starts with the importer's isolated Python regression suite. It has no Docker, source-home, account or host-service access. The two explicit integration entrypoints are `tests/hermes_import_canary.py --confirm-live-canary` (stock archive, existing Service, real access-only model grant) and `tests/hermes_import_rehearsal.py --confirm-reduced-rehearsal` (portable subset of a live home, bounded recent-session DB, no cutover). Both require explicit environment paths and remove their own test data. The canary verifies CREATE → PATCH hidden → GET `hidden===true` before sending any input. Refresh grants are never used by the fresh-home inference canary.

A successful reduced rehearsal is **not** evidence that an impossible full-home copy happened, that an older image matches the source schema, that `gh` exists, or that SSH credentials were approved. Those remain separate acceptance gates. Build the derived pinned-source image on a remote durable worker; do not build it on the Wizard control plane.
