# Disposable private-provider rig

This directory changes no production service code. It prepares a fresh Ubuntu 24.04 / Docker / stock Runtipi 4.10.2 box, installs the App Manager's frozen main source through its documented installer, and starts the Agent Service's frozen main source plus its host runtime helper (`--driver runtipi --home-mount alongside`). The restricted-agent firewall and agent-only listener are installed; the default runtime remains the Runtipi driver. No provider credentials or default apps are copied. Integration supplies the candidate provider apps and client image.

## Worker admission

Stage on the Mac's external work volume (never its internal disk):

- `stage/service.tar`: `git archive` of this pushed branch (service code unchanged from its main base).
- `stage/wam.tar`: `git archive` of a frozen App Manager main commit.
- `stage/guest-setup.py`: this directory's script.
- `stage/runtipi-setup.sh`: `https://setup.runtipi.io`, downloaded and hashed before admission.
- `stage/source-manifest.json`: `service_main`, `service_rig_commit`, `wam_main`, and `sha256` mapping each of the four files above to its hash.
- `worker.py`: this directory's worker, at the rig root.
- `checks/`: copy of this directory's checks, at the rig root.

Submit a **heavy** job with cwd = rig root, argv = `[/opt/homebrew/bin/python3, <rig root>/worker.py, --rig-root, <rig root>]`, timeout 7200. The durable worker owns the shared `worker.lock`; do not execute this command over a foreground SSH session, self-acquire a second lock, or launch a background child. Subagents prepare and return this exact job specification to their parent for admission. `--validate` is read-only and safe before admission.

The worker reuses the exact Ubuntu base and configuration pattern from the previous agents-mvp rig, not its mutable guest disk (which might contain secrets). It copies that cached base to the rig's external-volume cache, checks the pinned SHA256, creates VM `pp-rig` in `<rig root>/lima`, and mounts **only** the staging directory, read-only. It does not modify or boot any existing VM.

Readiness is **not** implied by staging or by a queue receipt. After actual execution, require `<rig root>/evidence/ready.json`, successful forwarded health reads, and all six `DRY_RUN` lines in `evidence/provision.log`. The full service suite and locked-run-bridge test also run inside the new guest before readiness. A failure leaves logs and the VM for diagnosis; it will not silently overwrite that VM on retry.

## Reach and reset

On the Mac:

```sh
export LIMA_HOME="<rig root>/lima"
limactl shell --workdir /home/rig pp-rig
```

Loopback forwards on the Mac: Agent Service `18787`, App Manager `17790`, runtime helper `17795`, Runtipi `18480`. No public or Tailscale binding. For another host, use SSH `-L` through the Mac. The generated `<rig root>/lima/pp-rig/ssh.config` also supports ordinary SSH.

The worker stops **only this VM**, APFS-clones its raw disk and EFI into `<rig root>/baseline/`, then reboots and checks health. This clean baseline predates any candidate app or provider key. Reset is the same admitted heavy job plus `--reset`: stop this VM, replace only its own disk/EFI using APFS clones from the manifest, restart, verify health. This is intentionally destructive only to this disposable rig's post-baseline state. Never delete/rewrite another lane's VMs. VM baseline/reset must be proven by execution; these instructions are not runtime evidence.

Guest source paths: `/opt/pp-rig/src/{service,wam}`. Units: `pp-agent-service`, `pp-agent-runtime`, `wizard-agent-firewall`; WAM also installs its user API service. State: `/home/rig/.wizard-os`; Runtipi: `/home/rig/runtipi`. Owner proof is generated mode 0600 in `.wizard-os/agent-runtime/owner-proof` and used as `x-wizard-owner-proof`; runtime token is a different file in that directory. Do not print either. Installing a service candidate means replacing `/opt/pp-rig/src/service` with a pushed frozen candidate archive, keeping its path, then restarting its two units; never do that on the live owner's box.

## Six probes

Run **inside this VM**, under sudo, from `/opt/pp-rig/checks`. Every wrapper accepts `--agent pp-test-<id> --provider-app wizard-tinfoil|wizard-local-model`. All require `/etc/pp-rig`'s exact marker. `--dry-run` checks installed prerequisites and Docker only; it does **not** claim a privacy check passed. The provisioning job executes all six dry runs on the clean box.

| Script | Additional inputs and assertion |
|---|---|
| `01-relay.sh` | `--codeword PRIVPROBE-... --trigger /path/to/request-adapter`: captures the exact internal `wizard-relay-<app>` bridge; reassembles both directions of every TCP stream with tshark; requires `Ehbp-Encapsulated-Key`, no codeword, and zero capture drops. Tinfoil only; local intentionally has no EHBP. |
| `02-hermes.sh` | Blocks HTTPS and direct-IP internet probes from Hermes, while requiring client `/healthz` success. `--hermes-container` overrides the default `agent-<id>`. |
| `03-client.sh` | Requires exactly two internal networks (agent + provider relay), relay health success, blocked DNS-name/direct-IP internet, cloud metadata and host-helper probes. Add repeated `--deny-url` for other box services/lateral fixtures. This is topology plus representative egress evidence, not an exhaustive formal firewall proof. |
| `04-key-location.sh` | `--key-sha256 <64 lowercase hex> --provider-data <actual provider data>`: compares candidate-secret hashes across all Wizard state, Runtipi compose/user-config, extra `--scan-root`s, **all** container inspections, and provider data. Requires a positive provider-data match and zero forbidden matches. No key is accepted or printed. Ordinary plaintext/env/JSON/YAML values are supported; encoded/encrypted secrets require a format-specific extension rather than claiming a pass. |
| `05-stop-provider.sh` | `--trigger /path/to/request-adapter` and optional repeated `--provider-container`: requires baseline success, stops selected provider containers, requires **verified terminal visible failure**, restores containers in `finally`, requires recovery. Specify every provider-owned serving container for multi-service apps. |
| `06-codeword.sh` | `--codeword PRIVPROBE-... --provider-data <actual provider data>`: scans selected provider Docker logs, rotated raw log files, and all provider data, with no matching content printed. Use repeated `--provider-container` and `--provider-data` for a model-server sidecar or additional data mounts. |

Provider selection defaults to exact `com.docker.compose.service=<provider id>` label, not a substring. Explicit `--provider-container` may be repeated. Provider data must be passed explicitly unless an app-specific writable mount can be identified safely. Missing containers, scan roots, tools, capture traffic/header, or positive key match are errors, never passes. Probe tool/HTTP/TLS errors cannot masquerade as a network seal.

### Request adapter contract

Integration supplies a real executable adapter for the actual candidate API (the rig does not invent or fake its result): exit **0** only after the agent's completed answer has been checked; exit **42** only after a terminal provider-unavailable error has been verified and is visible through the user-facing API; any other exit is an inconclusive/failing probe. An HTTP 202 admission, generic curl error, timeout or parsing failure is **not** exit 42. The stop check refuses a failing baseline, always restarts the selected containers, and checks recovery. Trigger stdout/stderr are withheld, so adapters must persist sanitized diagnosis separately when necessary. The relay trigger must exercise a fresh request/connection, not a cached answer.

Capture pcaps are mode 0600 because they include the provider's relay bearer token despite encrypted payloads. Keep them in private evidence only. The live provider key must be injected over stdin by integration; never add it to a stage archive, command line, host file or this repository. Fingerprint-only scanning is deliberate.

## Lightweight checks

```sh
python3 ops/private-provider-rig/test_checks.py
python3 -m py_compile ops/private-provider-rig/{worker,guest-setup}.py
```

The unittest fixture values are explicitly synthetic. These tests cover candidate hash extraction, chunk-boundary matches, missing roots/symlink escape, false network-seal positives, baseline failure and provider restoration on an incorrect failure result. They do not replace the clean-VM dry runs or live provider acceptance.
