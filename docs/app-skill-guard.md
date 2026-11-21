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
computed name, a program the guard does not know). So for every call of a tool
that can write files (`execute_code`, `terminal`, `write_file`, `patch`,
`process`, `skill_manage`) that the text check let through,
`app_skill_undo.py` copies the installed app skill files first and, in
`post_tool_call`, puts back anything changed or deleted and removes anything
added. The tool result then carries an `app_skill_guard` note saying the edit
was undone and how to make it through the app's release instead. Kept as-is:
calls that run App Manager (`wam ...`), calls during which App Manager rewrote
`apps.json` (an install or update), and `wizard-job-*` routing pointers. Not
seen: later writes by a process the call left running in the background. Skills
trees over 64 MB are not copied (logged, fails open).

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
