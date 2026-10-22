# Machines — source-only preview

Proposal: [wizard-os #158](https://github.com/humanitylabs-org/wizard-os/pull/158), `spec/MACHINES.md`.
**Not deployed, not a sandbox, not wired into sealed-agent gateways or Settings.**

This is a usable owner CLI + per-agent Unix daemon + forced-command SSH receiver,
not an app installer or replacement for the durable heavy-job scheduler. Nothing
runs unless explicitly invoked. It does not read `~/.hermes` or `~/.ssh`.

## What works

- Owner-only atomic machine registry and expiring per-agent capability/preset grants.
- One agent-bound OS principal per registration; duplicate exact host/port/user refused.
  DNS aliases are not physical-machine identity: the owner must not enroll aliases of
  the same account for different agents. Multi-principal physical-machine grouping is deferred.
- Agent-bound Unix socket, Linux kernel `SO_PEERCRED`, private socket directory, eight
  clients, one active operation per daemon, fixed SSH destination, strict host-key pin.
- `status`, named `run`, bounded `fetch-file`; no shell, user argv/env/cwd or source staging.
- Personal machines default-deny; explicit **status only** at relay and target policy.
- Target enrollment creates a fresh Linux user, root-owned home/forced key/policy,
  user-owned private workspace, no supplementary groups, password `*` (no usable
  password), no sudo. Does not alter sshd, firewall, owner permissions or services.
- Grant generation/expiry rechecked during execution and before release; local SSH
  killed and all results suppressed on revoke. **The remote child can continue.**
- Metadata-only `audit.jsonl` for admitted/completed/denied operations, private mode,
  file lock/fsync. No contents, raw SSH errors, target addresses or key paths in responses.
  Eight MiB cap fails admission closed; owner archival/rotation is manual in preview.

Linux stdlib Python 3.10+ and OpenSSH are required. Relay is Linux-only and refuses
root runtime. Target receiver is POSIX but only Linux enrollment is implemented and
proved. macOS bootstrap and on-Mac acceptance are **not shipped**. A macOS-hosted
Wizard must place relay/sockets inside its daemon-local Linux environment; a
cross-VM shared host socket is not a supported transport.

## Trust boundary — read before trying

Run presets execute repository-controlled code with the **entire limited UID's
permissions**. Named presets, cwd, `restrict`, timeouts and process ceilings do not
create a sandbox. World-readable files, processes, network/LAN, persistence and
resource exhaustion remain concerns. Use dedicated workers/disposable VMs, never an
owner login. No keychain, admin/docker groups, Full Disk Access or signing keys.

The relay and key-owning host service are trusted. This preview supports **same host-UID
relay and trusted edge only**: private socket directory 0700 and socket 0600 intentionally
refuse another UID even if `--peer-uid` is mis-set. Same-UID peer credentials alone
cannot distinguish containers: mount **only that agent's socket directory** in its
trusted edge. Never mount registry/keys or sibling sockets. Agents have no registry,
grants or enrollment mutation tool. Owner APIs, Settings UI and gateway/MCP integration
remain a release gate; this CLI does not claim that integration has shipped.

## Disposable proof (safe preview default)

```sh
npm ci
npx vitest run tests/machines.test.ts
python3 ops/machines/run-container-proof.py
```

The Docker proof creates/removes **one disposable container**, no host mounts, host
network, published ports, Docker socket or privileged mode. It installs OpenSSH/Python
inside the container, disconnects external networking, creates fixture users and keys
there, and runs the non-root relay → real SSH → limited user. Private fixture keys never
leave the container. Tests status → run produces a file → fetch exact bytes, other-agent
refusal, foreign peer UID, target-policy mismatch, symlink escape, host-key mismatch,
output ceiling, and mid-job revoke. Container is removed even on failure. A small Debian
package install is required; no image is built, published or deployed. CI runs the proof
in its disposable Linux runner. `container-proof.py` refuses non-container execution.

Normal `npm test` includes twelve stdlib regression tests (registry/grants/schema, real
Unix peer creds/caps, file attacks, subprocess bounds, in-flight revoke, fail-closed audit)
through `tests/machines.test.ts`, with isolated HOME/HERMES_HOME/WIZARD_OS_HOME/TMPDIR.
Use a **short** TMPDIR beneath your approved scratch root for the whole pre-existing
suite: deeply nested paths exceed the Linux Unix-socket limit and break unrelated tests.

## Owner CLI — real-target activation is NOT part of this preview

The following is a reviewable manual path for a later explicitly authorized test on a
dedicated disposable worker. Do not run enrollment on a personal laptop or existing
build machine merely to QA this PR. Use absolute, private **component** paths; never the
owner SSH directory. The relay user must own keys/config and parent dirs must be private.

1. Create a dedicated ed25519 key (no shared owner key) under the component's credential
   directory. Public key only goes into a target bootstrap bundle. Keep the private key
   and explicit `known_hosts` file mode 0600. Confirm host fingerprint out of band.
2. Review the scripts and a literal preset catalog such as:

   ```json
   {"check":{"argv":["/usr/bin/python3","-c","print('worker check')"],"timeout":5}}
   ```

   Personal status-only catalog must be `{}`. No caller-supplied preset parameters.
3. On the **target only**, owner administrator runs:

   ```sh
   python3 enroll-linux.py --agent example --user wizard-agent \
     --public-key ./machine.pub --privacy worker --presets ./reviewed-presets.json \
     --confirm-create-limited-user
   ```

   This command requires target root; the Wizard host/agent never receives it. Existing
   usernames or partial enrollments are refused. No automatic destructive rollback:
   inspect partial state and manually recover it as target owner. SSH availability and
   any tailnet ACL setup are separate owner actions, not changes this script makes.
4. As the unprivileged Wizard component user, create a mode-0600 machine file:

   ```json
   {"label":"Build worker","agent":"example","privacy":"worker",
    "host":"worker.example.invalid","port":22,"user":"wizard-agent",
    "identity":"/srv/wizard-machines/credentials/worker-ed25519",
    "known_hosts":"/srv/wizard-machines/credentials/known_hosts"}
   ```

5. Register and explicitly grant (max 24 hours in this preview):

   ```sh
   python3 ops/machines/machines.py register --root /srv/wizard-machines/private \
     --machine worker --config ./machine.json
   python3 ops/machines/machines.py grant --root /srv/wizard-machines/private \
     --machine worker --agent example --caps status run fetch-file --presets check --seconds 3600
   python3 ops/machines/machines.py serve --root /srv/wizard-machines/private \
     --agent example --socket /srv/wizard-machines/sockets/example/relay.sock --peer-uid 1000
   ```

   `--peer-uid` is the observed trusted edge's host-kernel UID, **not** blindly the sealed
   container's internal UID. The listener permanently binds `example`; tool payloads cannot
   name another agent. Do not expose these owner commands to a sealed agent. Private socket
   directory must be separate from credentials/private and mounted into only that edge.
6. From that edge/caller, explicit bounded operations:

   ```sh
   python3 ops/machines/machines.py call --socket /srv/wizard-machines/sockets/example/relay.sock --json '{"op":"list"}'
   python3 ops/machines/machines.py call --socket /srv/wizard-machines/sockets/example/relay.sock --json '{"op":"status","machine":"worker"}'
   python3 ops/machines/machines.py call --socket /srv/wizard-machines/sockets/example/relay.sock --json '{"op":"run","machine":"worker","preset":"check"}'
   python3 ops/machines/machines.py call --socket /srv/wizard-machines/sockets/example/relay.sock --json '{"op":"fetch-file","machine":"worker","path":"result.txt"}'
   ```

   `fetch-file` returns base64 bytes, `untrusted: true`; the example check does not generate
   `result.txt` (the disposable build fixture does). Do not auto-inject fetched bytes into
   another agent/context. `list` gives the current generation; requests may include that
   generation to reject stale UI/tool selections. Output/file cap 256 KiB, request 8 KiB,
   run preset max 120 s, SSH envelope max 512 KiB, connection read idle 5 s. No retry scheduler.
7. Owner revokes and reviews private metadata audit:

   ```sh
   python3 ops/machines/machines.py revoke --root /srv/wizard-machines/private --machine worker
   ```

   No results are released after observed revocation. Local process/SSH termination is
   not proof of remote termination; records return `revoked_remote_unknown`. Remove the
   target forced key to invalidate a copied private key, separately from local revoke.
   Account/workspace deletion is a separate destructive owner action; never automatic.

## Deliberate omissions / merge gates

No production auto-start, GUI, HTTP owner API, source staging, shell, Mac enrollment,
service restart, heavy-relay migration or target cleanup. No live machine is registered.
Audit is local metadata, not tamper-proof; raw artifacts are per-agent response data,
not a global log. Before real sealed-agent use: prove the actual gateway mount/identity,
MCP/tool discovery and owner grant UI; run macOS/worker acceptance; review backups/keys,
audit retention, disconnect/restart recovery and multi-principal enrollment. Existing
raw SSH callers are legacy and unchanged, not silently made safe by this module.
