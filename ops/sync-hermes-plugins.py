#!/usr/bin/env python3
"""Keep the Service's own Hermes plugins on the host in step with the deployed release.

Usage: sync-hermes-plugins.py <release dir> [--hermes-home <dir>] [--source-git <checkout>] [--no-reload]

The release bundle carries `hermes-plugin/<name>/`, but the host Hermes loads `$HERMES_HOME/plugins/<name>/`,
a plain copy made by hand when the plugin was first set up. Nothing refreshed that copy, so a merged plugin
change (issue 532: `wizard_schedule` gained `thread: 'daily'`) reached the Service and never the agent.

For every plugin the release ships, the installed copy is replaced by the release's copy only when it is safe:

  - it is already installed (a plugin the owner never added is never added here);
  - it is a plain folder, not a symlink (a link already follows its target);
  - Hermes did not install it (`plugins/.install-metadata.json` has no record for it, so `hermes plugins
    update` owns those);
  - every file in it is a version this repository once shipped at that path (checked against the git history
    of the source checkout), so an owner's own edit is never overwritten.

Then the running Hermes gateway is asked to re-discover its plugins (stock `reload_running_gateway`); the
plugin's tools apply from the next chat session. Prints one JSON line. Exit 0 unless the arguments are wrong.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

USAGE = 'Usage: sync-hermes-plugins.py <release dir> [--hermes-home <dir>] [--source-git <checkout>] [--no-reload]'
SKIP_PARTS = ('__pycache__',)
STAGE = '.wizard-plugin-sync'


def blob_sha(data: bytes) -> str:
    """The git blob id of these bytes (same as `git hash-object`)."""
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


def plugin_files(folder: Path) -> dict[str, str]:
    """relative path -> git blob id, for every regular file (bytecode caches skipped)."""
    out = {}
    for path in sorted(folder.rglob('*')):
        rel = path.relative_to(folder)
        if any(part in SKIP_PARTS for part in rel.parts) or path.suffix == '.pyc':
            continue
        if path.is_symlink():
            out[rel.as_posix()] = 'symlink'
        elif path.is_file():
            out[rel.as_posix()] = blob_sha(path.read_bytes())
    return out


def shipped_blobs(source_git: Path | None, name: str) -> set[tuple[str, str]]:
    """Every (relative path, blob id) this repository ever had under hermes-plugin/<name>/."""
    if not source_git or not (source_git / '.git').exists():
        return set()
    prefix = f'hermes-plugin/{name}/'
    result = subprocess.run(['git', 'log', '--all', '--no-renames', '--format=', '--raw', '--no-abbrev', '--', prefix],
                            cwd=source_git, text=True, capture_output=True)
    if result.returncode:
        return set()
    seen = set()
    for line in result.stdout.splitlines():
        if not line.startswith(':') or '\t' not in line:
            continue
        meta, path = line.split('\t', 1)
        fields = meta.split()
        if len(fields) < 4 or not path.startswith(prefix):
            continue
        for sha in fields[2:4]:
            if sha.strip('0'):
                seen.add((path[len(prefix):], sha))
    return seen


def hermes_managed(plugins: Path) -> set[str]:
    try:
        data = json.loads((plugins / '.install-metadata.json').read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        return set()
    return set(data) if isinstance(data, dict) else set()


def replace(source: Path, target: Path, stage: Path) -> None:
    """Swap target for a copy of source; the old copy is put back if the swap fails."""
    stage.mkdir(mode=0o700, exist_ok=True)
    fresh, old = stage / f'{target.name}.next', stage / f'{target.name}.prev'
    for leftover in (fresh, old):
        if leftover.exists():
            shutil.rmtree(leftover)
    shutil.copytree(source, fresh, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    os.replace(target, old)
    try:
        os.replace(fresh, target)
    except OSError:
        os.replace(old, target)
        raise
    shutil.rmtree(old, ignore_errors=True)


def sync(release: Path, hermes_home: Path, source_git: Path | None) -> dict:
    plugins = hermes_home / 'plugins'
    managed = hermes_managed(plugins)
    states, changed = {}, []
    for source in sorted(p for p in (release / 'hermes-plugin').iterdir() if (p / 'plugin.yaml').is_file()):
        name, target = source.name, plugins / source.name
        try:
            if target.is_symlink():
                states[name] = 'linked'
                continue
            if not target.is_dir():
                states[name] = 'not-installed'
                continue
            if name in managed:
                states[name] = 'hermes-managed'
                continue
            want, have = plugin_files(source), plugin_files(target)
            if want == have:
                states[name] = 'current'
                continue
            known = shipped_blobs(source_git, name) | set(want.items())
            if any(item not in known for item in have.items()):
                states[name] = 'owner-modified'
                continue
            replace(source, target, hermes_home / STAGE)
            states[name] = 'refreshed'
            changed.append(name)
        except OSError as exc:
            states[name] = f'error: {exc}'[:200]
    return {'hermes_home': str(hermes_home), 'plugins': states, 'changed': changed}


RELOAD = (
    'import json\n'
    'try:\n'
    '    from hermes_cli.plugins_activation import reload_running_gateway\n'
    'except Exception:\n'
    '    print(json.dumps({"verb": False}))\n'
    'else:\n'
    '    print(json.dumps({"verb": True, "answer": reload_running_gateway()}))\n'
)


def hermes_python(hermes_home: Path) -> str | None:
    """The interpreter of the owner's Hermes install: WIZARD_HERMES_PYTHON, else the `hermes` launcher's
    python shebang (a standard install links it from the venv), else the install's own venv."""
    if os.environ.get('WIZARD_HERMES_PYTHON'):
        return os.environ['WIZARD_HERMES_PYTHON']
    launcher = shutil.which('hermes') or str(Path.home() / '.local/bin/hermes')
    try:
        first = Path(launcher).resolve().read_bytes()[:300].split(b'\n', 1)[0].decode()
        if first.startswith('#!') and 'python' in first:
            return first[2:].strip().split()[0]
    except (OSError, UnicodeDecodeError):
        pass
    for venv in ('venv', '.venv'):
        candidate = hermes_home / 'hermes-agent' / venv / 'bin/python'
        if candidate.is_file():
            return str(candidate)
    return None


def reload_gateway(hermes_home: Path) -> str:
    python = hermes_python(hermes_home)
    if not python:
        return 'restart-needed: Hermes not found; run hermes gateway restart'
    try:
        out = subprocess.run([python, '-c', RELOAD], env={**os.environ, 'HERMES_HOME': str(hermes_home)},
                             text=True, capture_output=True, timeout=60)
        row = json.loads(out.stdout.strip().splitlines()[-1])
    except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
        return 'restart-needed: reload failed; run hermes gateway restart'
    answer = row.get('answer')
    if not row.get('verb'):
        return 'restart-needed: this Hermes cannot reload plugins live; run hermes gateway restart'
    if answer and answer.get('reloaded'):
        return 'reloaded'
    if answer is None:
        return 'no-gateway'
    why = str(answer.get('error') or 'no reason given')[:120]
    return f'restart-needed: gateway refused the reload ({why}); run hermes gateway restart'


def main(argv: list[str]) -> int:
    args = list(argv)
    def take(flag):
        if flag not in args:
            return None
        i = args.index(flag)
        if i + 1 >= len(args):
            raise SystemExit(f'{flag} needs a value')
        value = args[i + 1]
        del args[i:i + 2]
        return value
    home = take('--hermes-home') or os.environ.get('HERMES_HOME') or str(Path.home() / '.hermes')
    source = take('--source-git')
    no_reload = '--no-reload' in args
    args = [a for a in args if a != '--no-reload']
    if len(args) != 1 or not (Path(args[0]) / 'hermes-plugin').is_dir():
        print(USAGE, file=sys.stderr)
        return 2
    result = sync(Path(args[0]), Path(home), Path(source) if source else None)
    if result['changed'] and not no_reload:
        result['reload'] = reload_gateway(Path(home))
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
