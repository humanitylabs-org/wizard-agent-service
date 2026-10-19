# Agents working on wizard-agent-service

The Wizard Agent Service is the back end that every Wizard front end talks to. It sits in front of a stock Hermes Agent and owns threads, runs and steers, files, read state, voice recovery and AI usage. It reaches Hermes only through Hermes's API server and a read-only `state.db`. Read the team rules below before you start.

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

<!-- wizard-os-team-rules v1 (19 Oct 2026). Same text in every Wizard OS repo; the canonical copy is humanitylabs-org/wizard-os AGENTS.md. Change it there first, then copy the block to every repo in one round of PRs. -->
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

- **Open the PR once your first commit is pushed.** Use a draft until it is ready: `gh pr create --base main --draft`.
- **Keep each PR to one change** that a reader can follow in a few minutes. Split unrelated fixes into separate PRs.
- **Title:** state the outcome in plain words ("Threads open instantly from the on-device cache"), rather than the mechanism.
- **Body:** fill in the PR template. Write it for someone opening it cold:
  1. **What and why:** what changes for the user or the system, and the problem it solves.
  2. **Verified:** the exact commands you ran and their results. Add runtime evidence (a live box, screenshots or a short recording) wherever behaviour changed. For a bug fix, show the new test failing before the fix and passing after it.
  3. **Not checked:** what you could not verify, and why.
  4. **Links:** related issues, the matching PRs in other repos, and the decision or spec this change follows.
- **If `main` moves while you work,** merge `origin/main` into your branch and re-run the checks.

### Merging

- **The author merges their own PR** once three things hold:
  - the required checks are green;
  - the Verified section reflects real results;
  - nothing in the PR needs a decision (see the next section).

  There is no wait for a human approval.
- **Use "Create a merge commit"**, then delete the branch.
- **After merging anything that publishes or deploys,** confirm that the workflow run on `main` succeeded.

### When a change needs a decision

Decide and merge yourself, except when the change:

- reverses a locked decision in wizard-os `docs/DECISIONS.md`;
- changes a contract in wizard-os `spec/` that other repos depend on;
- changes James's skins (Nebula, Grove, Tide, Ember, Signal) or the base shell look;
- deletes user data, rewrites history, or is otherwise hard to undo.

For those, open the PR or an issue, explain the choice in one paragraph, and assign it to the agent account of the person who needs to decide. GitHub's Assignee field is used only for this. Carry on with other work while you wait.

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
