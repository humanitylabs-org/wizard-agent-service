# Machines

The owner gives an agent a computer. v1 builds the one level Archimedes needs to run on Wizard OS: **agent-owned**.

## Levels

| Level | What the agent gets | Status |
|---|---|---|
| **Agent-owned** | Full shell on a computer the owner dedicates to that agent (Thales, the Minisforum). Installs, builds, emulators, services. | **v1, shipped** |
| Shared desktop | Control inside the owner's own session on a computer they use (Omarchy). | Later |
| Worker | Named jobs under a limited account; results fetched back. | Later (heavy relay already covers sandboxed jobs) |
| Status | Online, platform, disk. | Later |

Every level shares these rules: the agent never holds the owner's logins or the machine key; one agent's machine is never reachable from another agent; revoke ends open sessions; the owner sees a metadata activity log; an offline machine never falls back to another route.

## How agent-owned works

- **Owner registry** at `~/.wizard-os/machines` (0700): machine id, label, host, port, user, optional owner-set ProxyCommand, pinned host key, and the agents it belongs to. The SSH key is generated there and never leaves the host.
- **Relay** (`wizard-machines.service`, owner uid): one Unix socket per granted agent at `sockets/<agent>/machines.sock`, next to the `machine` client.
- **Container**: the agent runtime mounts only that agent's directory read-only at `/run/wizard-machines`, and only for a restricted standard agent whose Service-owned `agent.json` has `grants.machines: true`.
- **Client**: `machine thales -- <cmd>` streams stdin/stdout/stderr and the exit code. `machine --ssh` is ssh-compatible, so `rsync -e 'machine --ssh'` and `GIT_SSH_COMMAND='machine --ssh'` work.
- **SSH**: `-F /dev/null`, pinned host key, BatchMode, no agent/X11/port forwarding, no ControlMaster, scrubbed environment.
- **Revoke**: `machines.py revoke <machine> <agent>`. Open sessions are killed within 2 s, and the socket disappears. Processes the agent already started on the remote machine keep running, because the machine is the agent's.
- **Audit**: `audit.jsonl` records start/end/denied, agent, machine, exit code and byte counts. It never records commands or output.

## Owner steps

```sh
machines.py add thales --label Thales --host <addr> --user <account> --known-hosts-from ~/.ssh/known_hosts
# authorize the printed public key on the machine
machines.py check thales
machines.py grant thales <agent>
# agent.json: "grants": {"machines": true}; then apply the agent
```

Settings UI, the other levels and macOS-hosted Wizard placement come later.
