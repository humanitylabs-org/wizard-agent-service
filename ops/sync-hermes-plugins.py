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
    update` owns those), unless the record is this repository's own `hermes-plugin/<name>` pinned to a commit
    of the release's own history (issue 730: `wizard link` installs wizard-os that way, and stock Hermes never
    moves a pinned install, so those boxes kept the plugin they were linked with). Such a copy is refreshed
    like a plain one and its record's `revision` moves to the release commit (under Hermes' metadata lock);
    `wizard link`'s fingerprint in `$WIZARD_OS_HOME/linked.json` moves along when it matched the old copy.
    Any other source, an unpinned or catalog install, a pin outside the release's own history (newer, or
    another branch), or an App Manager fresh-mode copy (`.wizard-fresh-link.json`) stays as it is
    (`hermes-managed`, `hermes-pinned`);
  - it is not a git checkout (a `.git` inside means the owner keeps it with git: `git-checkout`, left alone);
  - every file in it is a version this repository once shipped at that path (checked against the git history
    of the source checkout, plus the pre-repo hand copies listed in ops/hermes-plugin-seeds.json), so an
    owner's own edit is never overwritten (`owner-modified`, with the unknown files under `unknown`).

Then the running Hermes gateway is asked to re-discover its plugins (stock `reload_running_gateway`); the
plugin's tools apply from the next chat session. Prints one JSON line. Exit 0 unless the arguments are wrong.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

USAGE = 'Usage: sync-hermes-plugins.py <release dir> [--hermes-home <dir>] [--source-git <checkout>] [--no-reload]'
SKIP_PARTS = ('__pycache__',)
STAGE = '.wizard-plugin-sync'
LOCK = '.wizard-plugin-sync.lock'
SEEDS = 'ops/hermes-plugin-seeds.json'
OWN_REPO = 'humanitylabs-org/wizard-agent-service'
METADATA = '.install-metadata.json'
FRESH_LINK = '.wizard-fresh-link.json'
LINKED_PLUGIN = 'wizard-os'   # the plugin `wizard link` journals in linked.json


def seed_blobs(release: Path, name: str) -> set[tuple[str, str]]:
    """(relative path, blob id) of the known pre-repo hand copies of this plugin (ops/hermes-plugin-seeds.json in
    the release). A missing or broken list means none are known."""
    try:
        data = json.loads((release / SEEDS).read_text(encoding='utf-8'))
        files = data['plugins'].get(name) or {}
        return {(path, sha) for path, blobs in files.items() for sha in blobs}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return set()


def default_source() -> Path | None:
    """The deploy helper's source checkout (WAS_SOURCE, else ~/apps/wizard-agent-service), for a run by hand."""
    path = Path(os.environ.get('WAS_SOURCE') or Path.home() / 'apps/wizard-agent-service')
    return path if (path / '.git').exists() else None


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


def shipped_blobs(source_git: Path | None, name: str, ref: str = 'HEAD') -> set[tuple[str, str]]:
    """Every (relative path, blob id) the release's own history had under hermes-plugin/<name>/ (only commits
    that are ancestors of `ref`, never other branches: their code never shipped)."""
    if not source_git or not (source_git / '.git').exists():
        return set()
    prefix = f'hermes-plugin/{name}/'
    result = subprocess.run(['git', 'log', ref, '--no-renames', '--format=', '--raw', '--no-abbrev', '--', prefix],
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


def read_metadata(plugins: Path) -> dict | None:
    """Hermes' install records ({} when there are none). None when the file exists but can't be read: then
    nobody can tell which copies are Hermes's, so nothing is touched."""
    path = plugins / METADATA
    if not path.exists() and not path.is_symlink():
        return {}
    try:
        data = json.loads(path.read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def hermes_managed(plugins: Path) -> set[str] | None:
    """Names Hermes installed (its install metadata); None when it can't be read."""
    data = read_metadata(plugins)
    return None if data is None else set(data)


def own_source(source: object, name: str) -> bool:
    """True when an install record's source is this repository's own hermes-plugin/<name> (any of the forms
    Hermes or `wizard link` write: owner/repo, https URL with or without .git, git@github.com:)."""
    if not isinstance(source, str) or '#' not in source:
        return False
    repo, subdir = source.strip().split('#', 1)
    repo = repo.strip().rstrip('/')
    for prefix in ('https://github.com/', 'http://github.com/', 'git@github.com:', 'ssh://git@github.com/'):
        if repo.lower().startswith(prefix):
            repo = repo[len(prefix):]
            break
    if repo.lower().endswith('.git'):
        repo = repo[:-4]
    return repo.lower() == OWN_REPO and subdir.strip().strip('/') == f'hermes-plugin/{name}'


def fresh_linked(plugins: Path, name: str) -> bool:
    """The App Manager's fresh-mode link journal names this plugin: it re-pins and fingerprints that copy
    itself, so a change here would read as an owner edit there."""
    try:
        data = json.loads((plugins / FRESH_LINK).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return False
    except (OSError, ValueError):
        return True   # unreadable: assume it is the link's
    return not isinstance(data, dict) or not data.get('source') or own_source(data.get('source'), name)


def resolve_commit(source_git: Path | None, ref: str) -> str | None:
    if not source_git or not (source_git / '.git').exists():
        return None
    out = subprocess.run(['git', 'rev-parse', '--verify', '-q', f'{ref}^{{commit}}'], cwd=source_git, text=True,
                         capture_output=True)
    sha = out.stdout.strip().lower()
    return sha if not out.returncode and len(sha) == 40 else None


def is_ancestor(source_git: Path, older: str, newer: str) -> bool:
    return subprocess.run(['git', 'merge-base', '--is-ancestor', older, newer], cwd=source_git,
                          capture_output=True).returncode == 0


def pinned_own(record: object, name: str, source_git: Path | None, ref: str) -> tuple[str, str | None]:
    """('own', release sha) when the record is a pinned install of this plugin from this repo at a commit of the
    release's own history; else ('hermes-managed' | 'hermes-pinned', None)."""
    if not isinstance(record, dict) or record.get('pinned') is not True or record.get('catalog') \
            or not own_source(record.get('source'), name):
        return 'hermes-managed', None
    revision = record.get('revision')
    release = resolve_commit(source_git, ref)
    if not release or not isinstance(revision, str) or len(revision) != 40:
        return 'hermes-managed', None
    if not is_ancestor(source_git, revision.lower(), release):
        return 'hermes-pinned', None
    return 'own', release


@contextmanager
def metadata_lock(plugins: Path):
    """The same advisory lock Hermes holds while it rewrites its install metadata
    (hermes_cli.plugins_cmd_git._install_metadata_lock: flock on `.install-metadata.json.lock`)."""
    with open(plugins / f'{METADATA}.lock', 'a+') as handle:
        deadline = time.monotonic() + 10
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise OSError('Hermes plugin metadata is locked') from None
                time.sleep(0.05)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def atomic_json(path: Path, data: dict, mode: int | None = None) -> None:
    """Write JSON via a temp file + rename. Hermes' metadata keeps Hermes' own layout (indent 2, sorted keys)
    and the file's mode; `mode` sets it for the link journal (0600)."""
    tmp = path.with_name(f'.{path.name}.wizard-sync-tmp')
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode if mode is not None else 0o644)
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(json.dumps(data, indent=2, sort_keys=mode is None) + '\n')
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(tmp, mode if mode is not None else path.stat().st_mode & 0o777)
        except OSError:
            pass
        os.replace(tmp, path)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def link_fingerprint(root: Path) -> str:
    """`wizard link`'s plugin fingerprint (wizard-app-manager wizard-cli `plugin_tree_fingerprint`)."""
    files = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in sorted(root.rglob('*')) if p.is_file() and '.git' not in p.parts
             and '__pycache__' not in p.parts and p.suffix != '.pyc'}
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()


def link_record_path() -> Path:
    return Path(os.environ.get('WIZARD_OS_HOME') or Path.home() / '.wizard-os').expanduser() / 'linked.json'


def move_pin(plugins: Path, hermes_home: Path, name: str, record: dict, release: str, before: str,
             target: Path) -> list[str]:
    """After the swap: the install record (still the one read before) names the release commit, and
    `wizard link`'s journal follows when it attested exactly the copy just replaced. Raises OSError when the
    record changed meanwhile or can't be written, so the swap is undone. The journal comes after the record and
    is best effort (a failure there is returned as a note): files and record already agree by then."""
    data = read_metadata(plugins)
    if not isinstance(data, dict) or data.get(name) != record:
        raise OSError('Hermes install record changed during the refresh')
    data[name] = {**record, 'revision': release}
    atomic_json(plugins / METADATA, data)
    path = link_record_path()
    try:
        link = json.loads(path.read_text(encoding='utf-8'))
        same_home = Path(link['hermes_home']).resolve() == hermes_home.resolve()
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return []
    if same_home and name == LINKED_PLUGIN and link.get('plugin_installed') and link.get('plugin_sha256') == before:
        link['plugin_sha256'] = link_fingerprint(target)
        if link.get('plugin_ref'):
            link['plugin_ref'] = release
        try:
            atomic_json(path, link, mode=0o600)
        except OSError as exc:
            return [f'wizard link journal not updated ({exc}); a relink will see the plugin as changed'[:200]]
    return []


def replace(source: Path, target: Path, stage: Path, after=None) -> None:
    """Swap target for a copy of source; the old copy is put back if the swap fails, or if `after` (run once
    the new copy is in place) raises."""
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
    if after is not None:
        try:
            after()
        except BaseException:
            os.replace(target, fresh)
            os.replace(old, target)
            shutil.rmtree(fresh, ignore_errors=True)
            raise
    shutil.rmtree(old, ignore_errors=True)


def release_ref(release: Path) -> str:
    """The commit the release was built from (its RELEASE_SHA), else the checkout's HEAD."""
    try:
        sha = (release / 'RELEASE_SHA').read_text().strip()
    except OSError:
        return 'HEAD'
    return sha if len(sha) == 40 and all(c in '0123456789abcdef' for c in sha) else 'HEAD'


def sync(release: Path, hermes_home: Path, source_git: Path | None) -> dict:
    """One run at a time per Hermes home: the deploy helper and the Service's own startup run (issue 532) can
    overlap, and both swap folders through the same staging dir."""
    if not (hermes_home / 'plugins').is_dir():
        return _sync(release, hermes_home, source_git)  # nothing installed, so nothing is written
    try:
        lock = open(hermes_home / LOCK, 'a')
    except OSError as exc:
        return {'hermes_home': str(hermes_home), 'plugins': {}, 'changed': [], 'error': f'lock: {exc}'[:200]}
    with lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _sync(release, hermes_home, source_git)


def _sync(release: Path, hermes_home: Path, source_git: Path | None) -> dict:
    plugins = hermes_home / 'plugins'
    metadata = read_metadata(plugins)
    if metadata is None:
        return {'hermes_home': str(hermes_home), 'plugins': {}, 'changed': [],
                'skipped': 'plugins/.install-metadata.json is unreadable; nothing changed'}
    ref = release_ref(release)
    states, changed, unknown, result_notes = {}, [], {}, {}
    for source in sorted(p for p in (release / 'hermes-plugin').iterdir() if (p / 'plugin.yaml').is_file()):
        name, target = source.name, plugins / source.name
        try:
            if target.is_symlink():
                states[name] = 'linked'
                continue
            if not target.is_dir():
                states[name] = 'not-installed'
                continue
            pin = None
            if name in metadata:
                kind, release_sha = pinned_own(metadata[name], name, source_git, ref)
                if kind != 'own' or fresh_linked(plugins, name):
                    states[name] = 'hermes-managed' if kind == 'own' else kind
                    continue
                pin = (metadata[name], str(release_sha))
            if (target / '.git').exists() or (target / '.git').is_symlink():
                states[name] = 'git-checkout'
                continue
            want, have = plugin_files(source), plugin_files(target)
            if want == have and (pin is None or pin[0].get('revision') == pin[1]):
                states[name] = 'current'
                continue
            known = shipped_blobs(source_git, name, ref) | seed_blobs(release, name) | set(want.items())
            strange = sorted(path for path, sha in have.items() if (path, sha) not in known)
            if strange:
                states[name] = 'owner-modified'
                unknown[name] = strange[:20]
                continue
            if pin is None:
                replace(source, target, hermes_home / STAGE)
            else:
                record, release_sha = pin
                before = link_fingerprint(target)
                notes = []
                with metadata_lock(plugins):
                    replace(source, target, hermes_home / STAGE,
                            after=lambda: notes.extend(move_pin(plugins, hermes_home, name, record, release_sha,
                                                                before, target)))
                if notes:
                    result_notes.setdefault(name, []).extend(notes)
            states[name] = 'refreshed' if want != have else 'current'
            if want != have:
                changed.append(name)
        except OSError as exc:
            states[name] = f'error: {exc}'[:200]
    result = {'hermes_home': str(hermes_home), 'plugins': states, 'changed': changed}
    if unknown:
        result['unknown'] = unknown
    if result_notes:
        result['notes'] = result_notes
    return result


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
    result = sync(Path(args[0]), Path(home), Path(source) if source else default_source())
    if result['changed'] and not no_reload:
        result['reload'] = reload_gateway(Path(home))
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
