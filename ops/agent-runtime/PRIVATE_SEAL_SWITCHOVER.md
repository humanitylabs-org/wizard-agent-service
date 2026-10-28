# Private agent sealed-network switch-over / rollback — ROUND 9B

## Status: STAGED ONLY; NO LIVE SWITCH IS ADMITTED

The synthetic source-generated package and real Incognito/search work on forum.
This is **not** a completed migration of the installed Runtipi recipe. The
runtime deliberately returns `private_sealed_recipe_not_admitted` for an
installed sealed `apply` or `start`, before provider-key provisioning or any
lifecycle call. Do not remove that refusal to run this plan.

No live private agent or its containers were touched during round 9B. No live
home, conversations, Messenger data or recordings were accessed. Hermes core
and image remain stock.

## Recorded serving baseline (recheck immediately before approval)

- Runtime: `9f6855f4ed16806d89e6ee4b04deb9a2bdcb4e55`, serving release pointer
  `~/.local/share/wizard-agent-runtime/current`.
- Agent Service: `48e275c6bcac8cb2b6ce24a02621ffed2224c612`, serving release pointer
  `~/.local/share/wizard-mobile-server/current`.
- Runtipi URN: `agent-private:wizardapps`; project containers have the
  `agent-private_wizardapps` prefix. Resolve exact IDs with Compose labels,
  never a broad container-name substring.
- Source image: stock `ghcr.io/humanitylabs-org/hermes-agent:v2026.9.24-wizard2`.
- Preserve the two live round9A attested routes and native MCP check headers.

This branch descends from the exact runtime baseline, not current shared main.
If either live pointer moved, stop; compose a new candidate from each new exact
serving baseline and rerun the synthetic proof. Do not roll back another
thread's release.

## Required work before scheduling any interruption

1. Implement and rehearse the **installed recipe** final network replacement.
   A normal Compose JSON `networks` field merges with the recipe's shared
   Runtipi network; it does not remove it. Use a final owner override with
   tested `!override`/equivalent replace semantics. Prove install, stop/start,
   Runtipi restart and catalogue refresh retain only the internal agent seal.
   Read/write overrides through Runtipi's API, not root-owned files.
2. Resolve the **provider-key-location** contract. Round9A puts the bearer in
   stock Hermes configuration/environment; the old provider/client six-check
   contract excludes it from Hermes. Network-only/Compose-only changes cannot
   remove an existing bearer from the private home. No operator may inspect or
   edit that home. An approved, non-printing Service-owned credential migration
   or explicit revised acceptance contract is necessary. Do not claim six/six.
3. Prove the exact **relay ciphertext/EHBP capture** requirement on this official
   proxy topology. Its wire EHBP is inside TLS; attestation and source audit
   are not packet/header capture. Never disable TLS verification for this test.
4. Prove **app grants and Mizel** using synthetic scoped services. The candidate
   permits no generic host/Service network route from Hermes, so legacy HTTP
   MCP/app routes cannot be assumed to survive. Preserve existing Unix socket
   mounts and scoped binding/identity. Add a capability-scoped Unix/fixed
   bridge only if its refusal tests prevent generic HTTP or arbitrary egress;
   any extra route needs explicit acceptance. Never test with owner's content.
5. Finish stopped-provider terminal-failure and data-volume/log scanner proof.
   A bounded run that remains retrying is a partial result, not a failed model
   run; cancel it explicitly and show successful recovery separately.
6. Re-run full product suites, six checks, literal `curl https://example.com`
   refusal inside both persistent and Incognito agents, and HTTPS preview
   start/send/search/Close at exact final heads. Keep the preview available.
7. Produce immutable candidate and rollback overrides, a source manifest,
   credential-safe backups, and cutover/rollback dry-run scripts. The current
   draft does **not** contain an executable live switch script; inventing one
   before those artifacts exist would defeat the refusal in (1).

## Exact future switch-over sequence (after all above pass)

Only the admitted parent/owner runs this; this subagent did not execute it.
Operate on URN `agent-private:wizardapps` only. No `docker compose down -v`, no
home moves, no copy/restore of private data, no log reads or container exec.

1. Obtain the restart approval and a private-agent idle **reservation**, not
   merely one observation. Hold new private runs/Incognito starts through the
   existing Service lifecycle control; existing run count and Incognito count
   must both be zero. Other agents/recording services continue running.
2. Freeze current release pointers and approved override revision. Abort on
   drift. Stage the admitted runtime release, official proxy/edge images and
   candidate override **before** downtime. Validate chosen non-overlapping /28
   networks under the reserved pools `10.246.0.0/16` and `10.247.0.0/16` against
   Docker metadata. Do not reuse the preview's subnet pair.
3. Read Runtipi `GET /user-config/agent-private:wizardapps` into a mode-0600
   rollback file (never stdout); retain the exact `dockerCompose` and `appEnv`
   bytes. Record only selected metadata: source image ID, source container ID,
   `StartedAt`, `/opt/data` mount source/target/type/RW, network names and
   loopback published port. Do not inspect `.Config.Env` or any files.
4. Deploy the admitted helper source using the normal parent-owned guarded
   release path; no Service restart is required if its renderer is unchanged.
   If the final credential/scoped-bridge work changes Service, stage and admit
   its separately composed release too; include its restart in the estimate.
5. Begin the downtime timer. Runtipi API:
   `POST /app-lifecycle/agent-private:wizardapps/stop` with explicit `{}`.
   Require stopped status. Do not stop unrelated sidecars/services manually.
6. Runtipi API `PUT /user-config/agent-private:wizardapps` with explicit
   `{dockerCompose: <admitted final replacing override>, appEnv: <exact saved
   appEnv>}`. Read it back through the API and compare parsed tagged Compose
   semantics plus unchanged appEnv. Reject any unexpected mount, generic
   network, host alias, raw socket/capability or published plaintext proxy.
7. Runtipi API `POST /app-lifecycle/agent-private:wizardapps/start`, explicit
   `{}`. Bound readiness/attestation to 120 seconds from this request; do not
   inherit the helper's general 600-second wait. On failure use rollback now.
8. Verify metadata-only: same source image and opaque `/opt/data` mount, agent
   has exactly its internal inhibited-bridge seal, proxies have no uplink,
   only the edge has external access, plain proxy listeners bind only the
   seal, ingress is loopback-published on the original port. Verify public
   attestation documents from the Service-owned transport and expected pinned
   inference/search repositories, certificate and measurement steps.
9. Release the hold only after owner-authorized Incognito acceptance: start,
   date-only websearch response assertion (no transcript printing), Close,
   exact sibling/edge metadata gone. Perform only metadata/status checks for
   live app grants/Mizel; no owner app content inspection. End downtime timer.
10. Retain the old override/images and preview until owner acceptance. Delete
    only resources proven owned by this switch; no global Docker pruning.

## Exact rollback sequence

Run on failed start/attestation/network invariant, failed synthetic admission,
or owner rollback request. Data remains in place throughout.

1. Keep the private-agent run hold active; close only switch-owned Incognito
   sessions via the Service feature endpoint, never by reading RAM/home files.
2. Runtipi `POST /app-lifecycle/agent-private:wizardapps/stop`, explicit `{}`.
3. Restore **exact saved bytes** via `PUT /user-config/agent-private:wizardapps`
   with `{dockerCompose: <saved>, appEnv: <saved>}`; read back and compare.
4. Repoint runtime to the **saved prior serving release**, only if this switch
   changed it and no unrelated release drift occurred. Use the guarded parent
   lifecycle path. Restore Service only if this switch changed it; never
   bypass another job's lifecycle guard. Baseline known at round9B is above.
5. Runtipi `POST /app-lifecycle/agent-private:wizardapps/start`, explicit `{}`.
   Require running metadata, unchanged opaque home mount and prior networks,
   both round9A proxy containers present, source HTTP reachability and fresh
   `StartedAt`. Restore only the previous metadata policy flag if one changed;
   do not edit/rewrite the private home or model/app data.
6. Authorised date-only Incognito search assertion, Close and exact owned
   sibling cleanup; then release the hold. Preserve failed metadata evidence
   without collecting private logs or transcripts.

## Expected downtime (estimate, not a measured live guarantee)

- Successful private-only network/Compose change: **90–180 seconds**, mostly
  stock gateway startup plus two cold attestation verifications. Other agents
  and independent recording services should remain up.
- Rollback after a failed start: **60–120 additional seconds**. A hard
  120-second start/attestation cutoff plus rollback gives an approximate
  **3–4 minute** failed-attempt interruption; queue/wait for an idle reservation
  is outside the downtime estimate. Use the actual measured installed-recipe
  cold start to replace these estimates before approval.
- No live downtime occurred during round9B. The synthetic idle-source fixture
  does not measure full persistent stock dispatch startup. A future Service
  credential/scoped-bridge restart could affect other agents and invalidates
  this private-only estimate; get a new estimate/approval in that case.

## Preview operations

Link: `https://wizard.tailc0f369.ts.net:9471/wizard-os-home/?agent=synthetic&shell=phone`.
Dedicated local units: `wizard-private-seal-r9-backend.service` (SSH-supplied
synthetic provider credential and forum backend) and
`wizard-private-seal-r9-shell.service` (no live upstream). The backend has an
explicit remote stop hook; stopping only its SSH tunnel is not cleanup.
Forum project `r9bpreview`, Incognito owner `r9b-preview`; standalone rehearsal
project `r9bseal`, owner `r9b-synthetic`. Never operate on the live project.
