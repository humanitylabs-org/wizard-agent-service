# Agents working on wizard-agent-service

The Wizard Agent Service is the back end that every Wizard front end talks to. It sits in front of a stock Hermes Agent and owns threads, runs and steers, files, read state, voice recovery and AI usage. It reaches Hermes only through Hermes's API server and a read-only `state.db`. Read the team rules below before you start.

## Machine-specific configuration

Machine-specific paths and hosts come from env vars: `WIZARD_WORK_ROOT`,
`WIZARD_HEAVY_ROOT`, `WIZARD_BUILD_HOST`, `WIZARD_ORIGIN`, `QA_PLAYWRIGHT`,
`HERMES_HOME`, `ANDROID_HOME` / `ANDROID_SDK_ROOT`. Never commit personal paths
or tailnet hostnames; `tests/portable-paths.test.ts` in `npm test` enforces this.
Historical evidence/receipt paths are explicitly exempt, not executable examples.

## This repo

- **Setup:** requires Node 22.5 or later (the service uses the built-in `node:sqlite`). Run `npm ci` first.
- **Checks:**
  - `npm test` must pass.
  - So must `node --test tests/locked-run-bridge.test.mjs`.
  - PRs need the `test`, `gitleaks` and `validate` checks green.
- **Local fixture:** `npm run fixture` starts a deterministic fake Hermes and the service on a random port. Use it for anything that would otherwise write to a real agent.
- **API contract:** the `/wizard/...` API is defined in wizard-os `spec/AGENT_SERVICE_API.md`.
  - **Additive changes** (a new optional field or a new route) can land here directly. Update the spec in the same round of PRs.
  - **Removing or renaming anything** a client reads needs a `spec/` PR first. Keep the old shape working until the UX PR that stops using it has merged.
- **Hermes stays stock.** If a feature seems to need a Hermes change, build it here or as a Hermes plugin under `hermes-plugin/`.
- **Publishing:** merging to `main` triggers the **publish-image** workflow, which publishes the public image. Confirm the run succeeded. Live boxes run `main`.
- **Real conversation content** never goes into fixtures, tests or PR text. Use synthetic threads.

<!-- wizard-os-team-rules v4 (24 Oct 2026). Same text in every Wizard OS repo; the canonical copy is humanitylabs-org/wizard-os AGENTS.md. Change it there first, then copy the block to every repo in one round of PRs. -->
## Wizard OS team rules (identical in every repo)

Wizard OS is built by James, Jan and Miguel together with their agents. Archimedes commits as `defleur-agents` and Oscar as `oscarhenrycollins`. Every repo belongs to Wizard OS as a whole, and no repo belongs to one person. Make the change that is best for the whole system, and build on each other's work.

### Branches

- **`main` is the trunk in every repo.** It is what runs live and what releases are built from. `main` changes only through a merged pull request. Nobody pushes, force-pushes or rewrites `main` directly.
- **Start every change from a fresh `main`:**
  ```sh
  git fetch origin
  git switch -c fix/short-purpose origin/main
  ```
- **Name branches by purpose.** Use one of these prefixes:
  - `feature/`: new behaviour.
  - `fix/`: a bug fix.
  - `docs/`: documentation only.
  - `spec/`: a contract or decision change, in wizard-os.
  - `release/`: a version bump or release snapshot.
  - `integration/`: combines several branches for testing together.
  - `evidence/`: test evidence only.

  Write the rest in lowercase words joined by hyphens. A date suffix like `-20261019` is fine. People's names stay out of branch names.
- **Push after every commit:** `git push -u origin <branch>`. Work that exists only on your machine is invisible to the rest of the team.
- **One branch per change.** Leave other people's branches as they are. To build on someone's branch, branch from it and open your own PR.
- **Old branches are history.** Only `main` and the open PRs are current.

### Pull requests

- **Say what kind of change it is.** Every PR gets exactly one tier, shown both as a label and as the start of its title. This lets anyone triage a list of PRs at a glance.

  | Tier | Label | Title starts with | Means |
  |---|---|---|---|
  | Bug fix | `tier: recommended fix` | `Recommended fix:` | Something is broken and this makes it work. It must land. |
  | Improvement | `tier: strong suggestion` | `Strong suggestion:` | A clearly better behaviour or a new capability. Feel free to drop it. |
  | Personal preference | `tier: opinionated` | `Opinionated — feel free to drop:` | Taste: look, layout, gestures, wording, or how you like to work. In the shell it belongs in your own skin (below). |
  | Maintenance | `tier: maintenance` | `Maintenance:` | Docs, releases, CI, tests or refactors with no change in behaviour. |

  Optional labels:
  - `priority: 1` (review first), `priority: 2` (review next) and `priority: 3` (when there is time).
  - `needs: james review`: the PR waits for James to accept it or drop it.
  - `preview only`: an experiment that must not be merged.
  - `from: <where it already runs>`, for example `from: miguel test port`: the change is already in daily use there. A box in developer mode (below) uses `from: <owner> dev build`.

  Use the same tiers for issues. **Add the label when you open the PR** (`gh pr create --label "tier: ..."`); a PR without one shows as "No tier" on the board below. Agents label every PR they open, and add the missing label when they find one of their own without it.
- **Open the PR once your first commit is pushed.** Use a draft until it is ready: `gh pr create --base main --draft`.
- **Keep each PR to one change** that a reader can follow in a few minutes. Split unrelated fixes into separate PRs.
- **Title:** after the tier prefix, state the outcome in plain words ("Recommended fix: threads open instantly from the on-device cache"), rather than the mechanism.
- **Body:** fill in the PR template. Write it for someone opening it cold:
  1. **What and why:** what changes for the user or the system, and the problem it solves.
  2. **Verified:** the exact commands you ran and their results. Add runtime evidence (a live box, screenshots or a short recording) wherever behaviour changed. For a bug fix, show the new test failing before the fix and passing after it.
  3. **Not checked:** what you could not verify, and why.
  4. **Links:** related issues, the matching PRs in other repos, and the decision or spec this change follows.
- **If `main` moves while you work,** merge `origin/main` into your branch and re-run the checks.

### Two routes for every change

Every change reaches `main` one of two ways: **propose a fix** (`tier: recommended fix`) or **propose a feature** (any other tier). There is no third "my build" lane. Owners who only want Wizard to look or behave differently use their skin, settings or apps. People who change Wizard itself can run their branch first on a box in **developer mode**, which follows a named branch or fork instead of `latest`/`stable` (DECISIONS #97, wizard-os `releases/README.md`). That box is a test bench; the change still lands as a fix or feature PR.

### Tracking

**The [Wizard OS · PR pipeline](https://github.com/orgs/humanitylabs-org/projects/1) board is the source of truth for where every PR is**, across all repos: Draft → In review → Merged → On Latest → On Stable, or Dropped. wizard-os `tools/pr_board.py` syncs it every 15 minutes from the PRs and the release pointers, so nobody moves cards by hand; keep the tier label right and the board stays right. Check it before asking someone where a change is, and link it in status updates instead of listing PRs.

### Merging

DECISIONS #96 (24 Oct 2026). `main` keeps **0 required approvals** and non-strict status checks, so process never blocks work.

- **Humans are the only admins:** James (`jdefleur`), Jan (`JanMesaric`) and Miguel (`mistermizel`). Agent accounts (`defleur-agents`, `oscarhenrycollins`) hold Write and sit on `main`'s review-bypass list; they never change branch rules, collaborators or repository settings.
- **Fixes ship immediately.** A `tier: recommended fix` PR merges by its author, human or agent, without waiting for another review, once all of these hold:
  - a regression test that fails on `main` before the fix and passes after it;
  - the required checks are green;
  - every review thread is resolved (Codex or Agent review findings fixed or answered).

  The release carrying it can go to stable the same day (DECISIONS #82).
- **Everything else needs a review by someone other than its author**, and that reviewer may be an agent (the Agent review workflow or another collaborator's agent). This covers features, maintenance, taste and defaults, and the high-risk list: security or privacy boundaries, host powers or credentials, migrations or anything that deletes or rewrites owner data, and a release that reaches every install. Once the review, the required checks and resolved conversations hold, the author's agent merges; no human has to visit GitHub to click merge.
- **Every PR gets an agent review.** The **Agent review** workflow (`humanitylabs-org/wizard-ux` `tools/pr-agent-review.mjs`) posts one review on each push to a ready PR. It flags taste changed for everyone instead of in your own skin, likely breaking changes, secrets and personal paths or private hosts, and `docs/COMPONENTS.md` reuse problems. Fix every 🔴 before merging; each 🟡 is something the reviewer checks.
- **The Verified section must reflect real results** before anything merges.
- **What each tier means for merging:**
  - **Recommended fixes** merge on the fix conditions above.
  - **Strong suggestions and maintenance** merge after a non-author review, unless they change something James sees or uses every day. In that case add `needs: james review` and wait.
  - **Opinionated changes** to the shell's look or UX go into your own skin: wizard-ux `web/skins/<yours>/` plus your `SKINS` entry (see wizard-ux `web/skins/README.md`). Never add a Settings toggle or core code for one person's taste.
  - **Making something the default for everyone** (any opinionated change outside your own skin) carries `needs: james review` and waits for James. Bring it once you have used it in your skin, with a preview he can try.
  - **`preview only`** PRs never merge.
- **Use "Create a merge commit"**, then delete the branch.
- **After merging anything that publishes or deploys,** confirm that the workflow run on `main` succeeded.

### When a change needs a decision

Decide and merge yourself, except when the change:

- reverses a locked decision in wizard-os `docs/DECISIONS.md`;
- changes a contract in wizard-os `spec/` that other repos depend on;
- changes James's skins (Nebula, Grove, Tide, Ember, Signal) or the base shell look;
- deletes user data, rewrites history, or is otherwise hard to undo.

For those, open the PR or an issue and explain the choice in one paragraph. Then:

- **If James decides:** add `needs: james review`.
- **If another agent's side has to act:** assign that agent's account. GitHub's Assignee field is used only for this.

Carry on with other work while you wait.

### Changes that span repos

1. Change the contract first, with a `spec/` PR in wizard-os.
2. Land the code PRs in dependency order: the service before the UI that calls it.
3. Keep each step backward compatible, so `main` works in every repo at every point.
4. Link the PRs to each other.

### Releases

Anything shipped, tagged or handed to a tester is built only from commits already on GitHub. Release notes name the repo, branch and commit.

### Safety

- **Keep secrets and private data out of commits.** That covers keys, tokens, passwords, `.env` files, personal data, real conversation content, owner hostnames and home-directory paths. Put these in config or environment variables. Private repos are still visible to every org member.
- **Hermes, the agent harness, stays stock.** Wizard behaviour goes in the Agent Service, the App Manager, Wizard UX or an app.
- **Run this repo's checks before opening a PR.** They are listed under "This repo" in this file.

### Where work comes from

Pick up work from the open issues in this repo and from wizard-os `docs/WORK_OUTSTANDING.md`. For how the pieces fit together and what is already decided, read wizard-os `docs/ARCHITECTURE.md` and `docs/DECISIONS.md`.
<!-- /wizard-os-team-rules -->
