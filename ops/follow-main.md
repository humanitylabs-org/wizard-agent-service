# Follow main (issue 514)

A box that runs the Agent Service from hand-deployed releases
(`~/.local/share/wizard-mobile-server/releases/was-<sha>`, switched by `ops/wizard-agent-service-deploy.py`)
used to stay on its last release until someone prepared the next one and deployed it by hand. Follow main does
that by itself. It is off by default behind the owner switch `wizard/follow-main`. `WIZARD_FOLLOW_MAIN=1` in the
env file forces it on and `=0` forces it off.

Every 5 minutes, `ops/wizard-agent-service-follow-main.py` runs these steps:

1. Read `origin/main`. If the live release already is main, stop.
2. Wait for GitHub's `test`, `gitleaks` and `validate` checks on that exact commit. CI is the remote worker that
   ran the full suite, so the box runs no tests. If a check fails, nothing is installed.
3. Prepare `releases/was-<sha>`: `git archive` of the commit, `npm ci --omit=dev` (four pure-JS packages),
   `RELEASE_SHA` and `SERVER_TREE`. It is built beside the other releases and renamed into place only when complete.
4. Deploy it with the box's own helper: `~/.local/bin/wizard-agent-service-deploy` if installed, otherwise the
   release's copy. The helper skips the drain while `wizard-run-keeper.service` is up, refuses rewinds and rolls
   back a release that fails its health check.
5. Write `follow-main.json` beside the releases with `state`, `live`, `main`, `behind_by`, `behind_since` and `reason`.

If a prepare or deploy of the same commit fails, it is retried after 30 min (`WIZARD_FOLLOW_MAIN_RETRY_S`).

The Agent Service reads that file (`WIZARD_FOLLOW_MAIN_STATUS` overrides the path). While the switch is on:

- `/wizard/health` carries `follow_main`. The timer reads `follow_main.on` from it.
- The owner is told ("Wizard is behind") only when there is a step he can take, and the notice names it
  (issue 638):
  - the timer stopped running: the `systemctl --user enable --now ...` command that restarts it;
  - a prepare or deploy of main still fails after its 30-min retry: ask his agent to run the box's deploy helper
    and fix what it reports.
- Everything else is not the owner's and sends nothing; `follow_main.reason` and `follow_main.cause` in health still
  say why the box is behind:
  - `red-main`: a required check failed on main. The **Red main** workflow (`.github/workflows/red-main.yml`) reruns
    the failed jobs once, so a flaky test heals and the box installs the commit on its next pass. If the rerun fails
    too, it files one `bug` issue "Main is red: ..." here for the builder (later red commits comment on it).
  - `checks-pending`: main's checks are still running; `github`: GitHub could not be read.
- At most one notice per cause until the box is current again, never one per merge.

With the switch off, health has no `follow_main` field, the timer pass changes nothing and no notice is sent.

## Install on a box (owner)

```sh
cp ops/wizard-agent-service-follow-main.service ops/wizard-agent-service-follow-main.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now wizard-agent-service-follow-main.timer
```

Then turn on `wizard/follow-main` in Settings › Look. On a box with no Look file, put `WIZARD_FOLLOW_MAIN=1` into
`~/.config/wizard-agent-service/follow-main.env`.

The unit runs the copy in the live release, so each deploy brings its own newer follow-main step.

Undo: `systemctl --user disable --now wizard-agent-service-follow-main.timer`.

This replaces a hand-made "Follow main" cron, if the box has one. Two passes never deploy at the same time,
because the deploy helper takes its own lock.
