# Restricted agent runtime

Off unless the box sets `WIZARD_AGENT_ISOLATION=restricted`, `WIZARD_AGENT_PORT` and `WIZARD_OWNER_PROOF_FILE`.
Agents created while it is on run in `ops/agent-runtime/restricted-agent/` (vendored unchanged from
wizard-app-store, digests in `SOURCE.txt`). Agents created before keep their runtime.

## Agent home contract

| | |
|---|---|
| Host path | `$WIZARD_OS_HOME/agents/<id>/home` (default `~/.wizard-os/agents/<id>/home`) |
| Container path | `/opt/data` (`HOME` and `HERMES_HOME` in the agent container) |
| Owner | uid:gid `10000:10000`, directory mode `0700`; the host user cannot read or write it |
| Managed files | `.env` and `config.yaml`, written by the Service to `agents/<id>/managed/` and copied in before every start |

The home belongs to the agent's container user. The host never writes into it directly:

- The runtime driver (`RestrictedDriver.sync_home`) copies the managed files in using a one-shot container. That
  container has no network, a read-only root, and only the CHOWN, FOWNER and DAC_OVERRIDE capabilities. Nothing
  in the home is trusted: each file is written into a fresh `mktemp -d` directory and renamed over its target, so
  a planted symlink or FIFO is replaced rather than followed or opened. The runtime's own `home-init` then
  re-owns anything that is not `10000:10000`. Lifecycle actions lock per agent, so one stuck agent never
  holds up the others.
- Anything else that must land in the home runs inside the agent container as its own user, for example an import:
  `docker exec -u 10000:10000 <agent container> hermes import <archive>`. Files written this way stay owned correctly.
  The runtime's `home-init` repairs ownership on the next start if something lands as another uid.
- Shares (files sent to an agent from the phone) answer `409 agent_unavailable` for restricted agents until
  in-container placement exists.

## Model providers

The restricted runtime has no Tinfoil attestation sidecar yet. Creating a restricted agent on Tinfoil, or moving
one onto it, answers `409 restricted_provider_unsupported`; the runtime driver refuses it as well. Private agents
need a confidential provider, so until that sidecar exists they stay on the existing runtime or use the local
model.

## Networks and ports

- Each agent gets a /28 uplink from `10.250.0.0/16` and a /28 sandbox from `10.251.0.0/16`. Index 0
  (`10.250.0.0/28`, `10.251.0.0/28`) is reserved for conformance runs, so the first agent gets `.16/28`. The pair
  is chosen as the lowest index free among registered agents and stored in `agent.json`. It is never shown in the
  public agent shape.
- The agent reaches the Service only through its edge sidecar, which connects to the agent-only listener
  `WIZARD_AGENT_PORT` (default 8929; 8924 is often taken by wizard-link) at the uplink gateway address.
- On that listener, an agent key is accepted only from that agent's own uplink /28. Only `/wizard/mcp` and
  `GET /wizard/v1/agent-context` are served. A restricted agent's key is refused (`403 principal.agent_network`) on
  every other listener.
- Host firewall: `ops/agent-runtime/agent-firewall.sh` and `wizard-agent-firewall.service`. Install them as root.
  A refresh builds the new chains and hooks them in before the old ones go, so the guard never drops. Stopping
  the unit leaves the rules in place; removal is `wizard-agent-firewall remove`. The functional test is
  `test_agent_firewall.sh`, which runs in a privileged throwaway container and includes a check that nothing
  slips through during refreshes.
