# Released app workflows, not private skill copies

The `wizard-os` Hermes plugin registers an always-on `pre_tool_call` guard.
App workflow rules, styles, presets and approved outputs belong in the app's
source repository, reviewed release and installed update. Changing a private
Hermes skill does not update anyone else's Wizard. Changing the installed copy
is also temporary: App Manager removes and re-copies app skills on registry
writes.

## What it catches

- `skill_manage` mutations whose names match an installed app id or its shipped
  skill's frontmatter name, including batch operations and deletion.
- `write_file` and `patch` edits inside the installed `skills` and `store/skills`
  directories, including apply-patch file headers and resolved symlink paths.
- Literal `terminal` / `execute_code` writes mentioning those directories.
- `execute_code` Python that builds the path on one line and writes it later
  (`app_skill_code.py`): simple assignments are followed, `Path.home()`, `~`,
  `$HOME` and `$WIZARD_OS_HOME` are resolved, and `open(..., 'w')`, pathlib
  writes, `os` / `shutil` writes and copies, `subprocess` / `os.system` shell
  commands and the `hermes_tools` `write_file` / `patch` / `terminal` helpers
  are checked against their target. Reading a skill and writing the text
  elsewhere stays allowed.

The guard uses the plugin's existing `kernel.os_home()` and
`kernel.read_registry()`: `WIZARD_OS_HOME`, otherwise `~/.wizard-os`.
It also scans/protects `/opt/wizard-os/skills`, the App Manager container bind
mount (`wam/agent_link.py`'s `SKILLS_TARGET`), even when `apps.json` is not
available in the container. Folder names and frontmatter aliases are discovered
from disk, so the product contains no fixed app list. App source files and
`wizard-job-*` routing-only pointer skills remain writable.

## Undo backstop (any path)

Reading the call's text cannot catch every path (a glob loop, `os.walk`, a
computed name, a program the guard does not know). `app_skill_undo.py` does not
read the code: it keeps a copy of the installed app skill files and puts any
change back (changed or deleted files restored, mode included; added files
removed):

- at the end of every call of a tool that can write files (`execute_code`,
  `terminal`, `write_file`, `patch`, `process`, `skill_manage`) that the text
  check let through; the tool result carries an `app_skill_guard` note saying
  the edit was undone and how to make it through the app's release instead;
- every 3 seconds from a background watcher, and at the start of the next
  writing call, so a process a call left running cannot change them later; the
  next tool result carries that note.

Only App Manager changes them. It writes `skills/<app>/SKILL.md` and then
`apps.json`, so outside tool calls a change that comes with an `apps.json`
rewrite is kept, and an unexplained one is undone only when it is still there a
tick later (a half-finished App Manager write is never reverted). Inside a call
a change is kept only for apps whose `apps.json` entry changed (an install or
update happening meanwhile), or when the call is a terminal command that really
runs `wam` and rewrites `apps.json`. Mentioning `wam`, or touching `apps.json`
without changing an app's entry, keeps nothing. `wizard-job-*` routing pointers
are not watched. Files over 4 MB are watched by size and time only (an added one is removed; a changed one is logged, not restored), and a skills tree that already holds over 64 MB when the first call runs is not copied (logged, fails open).

A blocked call explains the durable route: edit the app's source, follow its
review/release process, update installs, and verify the installed skill matches.
The guard never merges, releases, updates installs or rewrites skills itself.

## Optional private-skill migration list

There is **no personal shadow-skill map in the product**. An installation may
opt in to a list through the normal Hermes plugin settings namespace:

```yaml
plugins:
  entries:
    wizard-os:
      settings:
        app_skill_guard:
          shadow_skills:
            - name: personal-clips
              app_id: video-app
```

The default list is empty. A configured shadow may be deleted, have a supporting
file removed, or receive a patch whose replacement is no longer than the old
text, so it can shrink toward a pointer to the app. Growth and full rewrites are
blocked. This is a migration heuristic, not semantic proof that a patch is a
pointer. Installed app skills are blocked regardless of patch length.

## Limits and checks

This is a bounded workflow guard, **not a security sandbox**. Shell/code matching
is deliberately conservative: a command containing both a write operation and
a literal protected path is blocked, even when that path was only a copy source.
Computed/encoded paths, arbitrary programs, and other tool surfaces are not
interpreted. Read-only commands such as `cat` and `diff` are allowed. Only
Hermes processes loading this plugin receive the hook; existing installations
need the normal plugin update. No live install is changed by this PR.

Run `npm run test:plugin` for isolated synthetic registry/home/mount regression
fixtures and the existing media/follow-up plugin tests. It is also part of
`npm test`, so CI cannot skip the guard regression.
