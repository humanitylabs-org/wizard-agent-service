"""Keep installed app skill files exactly as App Manager wrote them (#797).

The pre-call guard (app_skill_guard) reads a call's text, so a path it cannot
spell (a glob loop, os.walk, a computed name, another program) gets through.
This backstop does not read the code. It keeps a copy of every installed app
skill file (the guard's roots, minus wizard-job-* routing pointers) and puts any
change back:

- after every call of a tool that can write files (execute_code, terminal,
  write_file, patch, process, skill_manage), and the tool result tells the agent
  the edit was undone and why;
- every few seconds from a background watcher, so a process a call left running
  cannot change them later either (the next tool result carries that note).

Only App Manager changes them. App Manager writes skills/<app>/SKILL.md and then
apps.json (wam/registry.py), so:

- outside tool calls, a change that comes with an apps.json rewrite is kept, and
  an unexplained change is undone only once it is still there a tick later (so a
  half-finished App Manager write is never reverted);
- inside a call, a change is kept only for apps whose apps.json entry changed,
  except a terminal call that really runs `wam` and rewrites apps.json, which
  keeps everything (an install or update the agent ran). Touching apps.json
  without changing an app's entry keeps nothing.

Limits: a skills tree over MAX_SNAPSHOT_BYTES is not copied (logged, fails open),
and one that edits both apps.json's entry and the skill in one call is taken as
an app update; App Manager's next registry write re-copies the released skill.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import re
import shlex
import threading
import time

try:
    from . import kernel
except ImportError:  # plain-module loading, like the other plugin helpers
    import kernel  # type: ignore[no-redef]

logger = logging.getLogger(__name__)

WRITING_TOOLS = {'execute_code', 'terminal', 'write_file', 'patch', 'process', 'process_manage', 'skill_manage'}
MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
WATCH_SECONDS = 3.0          # 0 disables the background watcher (tests drive tick() directly)
CALL_GRACE_SECONDS = 1.0     # an unexplained change at the end of a call waits this long for apps.json
SEGMENT_RE = re.compile(r'\|\||&&|[;\n|&()]')

_lock = threading.RLock()
_state: dict = {}            # baseline: files, sigs, registry entries and stamp
_calls: dict = {}            # in-flight writing calls: key -> {'wam': bool, 'stamp': ...}
_notes: dict = {}            # key -> note for that call's result
_late: list[str] = []        # undone by the watcher, told in the next tool result
_suspect: dict = {}          # watcher: unexplained diffs seen on the previous tick
_watcher: threading.Thread | None = None


def _roots() -> list[Path]:
    try:
        from . import app_skill_guard as guard
    except ImportError:  # pragma: no cover - plain-module loading
        import app_skill_guard as guard  # type: ignore[no-redef]
    out = []
    for root in guard.skill_roots():
        try:
            real = root.resolve()
        except (OSError, RuntimeError):
            continue
        if real not in out:
            out.append(real)
    return out


def _walk(root: Path):
    try:
        apps = sorted(root.iterdir())
    except OSError:
        return
    for app in apps:
        if app.name.startswith(kernel.JOB_SKILL_PREFIX) or app.name == '.wizard-job-routing':
            continue
        if app.is_dir() and not app.is_symlink():
            for path in app.rglob('*'):
                yield path
        else:
            yield app


def _is_temp(path: Path) -> bool:
    # App Manager's in-flight temp copy (.SKILL.md.<pid>.<tid>.tmp) and our own.
    return path.name.startswith('.SKILL.md.') or path.name.endswith('.wizard-undo')


def _sigs() -> dict[str, tuple]:
    out = {}
    for root in _roots():
        for path in _walk(root):
            try:
                st = path.lstat()
            except OSError:
                continue
            if path.is_symlink() or path.is_file():
                if not _is_temp(path):
                    out[str(path)] = (st.st_size, st.st_mtime_ns, st.st_ino, st.st_mode, path.is_symlink())
    return out


def _files() -> dict[str, tuple] | None:
    out, budget = {}, MAX_SNAPSHOT_BYTES
    for root in _roots():
        for path in _walk(root):
            if _is_temp(path):
                continue
            try:
                if path.is_symlink():
                    out[str(path)] = ('link', os.readlink(path), 0)
                elif path.is_file():
                    st = path.stat()
                    budget -= st.st_size
                    if budget < 0:
                        return None
                    out[str(path)] = ('file', path.read_bytes(), st.st_mode & 0o7777)
            except OSError:
                continue
    return out


def _registry():
    path = kernel.os_home() / 'apps.json'
    try:
        st = path.stat()
        stamp = (st.st_mtime_ns, st.st_size, st.st_ino)
    except OSError:
        return None, {}
    entries = {}
    doc = kernel.read_registry(path)
    for app in (doc.get('apps') if isinstance(doc, dict) else None) or []:
        if isinstance(app, dict) and isinstance(app.get('id'), str):
            entries[app['id']] = json.dumps(app, sort_keys=True)
    return stamp, entries


def _app_of(path: str) -> str:
    for root in _roots():
        try:
            rel = Path(path).relative_to(root)
        except ValueError:
            continue
        return rel.parts[0] if rel.parts else ''
    return ''


def _baseline() -> bool:
    if _state:
        return True
    files = _files()
    if files is None:
        logger.warning('app-skill undo: installed skills exceed %d bytes, not copied', MAX_SNAPSHOT_BYTES)
        return False
    stamp, entries = _registry()
    _state.update(files=files, sigs=_sigs(), stamp=stamp, entries=entries)
    return True


def _put_back(path: str, saved) -> bool:
    target = Path(path)
    try:
        if target.is_dir() and not target.is_symlink():
            import shutil
            shutil.rmtree(target)
        elif target.is_symlink() or target.exists():
            if saved is None:
                target.unlink()
                parent = target.parent
                roots = set(_roots())
                while parent not in roots and parent.is_dir() and not any(parent.iterdir()):
                    parent.rmdir()
                    parent = parent.parent
                return True
        if saved is None:
            return True
        target.parent.mkdir(parents=True, exist_ok=True)
        kind, data, mode = saved
        tmp = target.with_name(f'.{target.name}.wizard-undo')
        tmp.unlink(missing_ok=True)
        if kind == 'link':
            os.symlink(data, tmp)
        else:
            tmp.write_bytes(data)
            os.chmod(tmp, mode)
        os.replace(tmp, target)
        return True
    except OSError as error:
        logger.warning('app-skill undo: could not restore %s: %s', path, error)
        return False


def _diff() -> tuple[dict, dict] | None:
    """Current files and the paths that differ from the baseline (path -> saved or None)."""
    if _sigs() == _state['sigs']:
        return None
    now = _files()
    if now is None:
        return None
    old = _state['files']
    changed = {p: old.get(p) for p in set(old) | set(now) if old.get(p) != now.get(p)}
    return now, changed


def _settle(changed: dict, now: dict, keep) -> list[str]:
    undone = []
    for path, saved in changed.items():
        if keep(_app_of(path)):
            if path in now:
                _state['files'][path] = now[path]
            else:
                _state['files'].pop(path, None)
        elif _put_back(path, saved):
            undone.append(path)
    _state['sigs'] = _sigs()
    return undone


def reconcile(*, call: dict | None = None, grace: float = 0.0) -> list[str]:
    """Undo unexplained changes now; `call` is the in-flight call being finished (or None)."""
    with _lock:
        if not _baseline():
            return []
        found = _diff()
        if found is None:
            stamp, entries = _registry()
            _state.update(stamp=stamp, entries=entries)
            return []
        now, changed = found
        stamp, entries = _registry()
        updated = {a for a in set(entries) | set(_state['entries'])
                   if entries.get(a) != _state['entries'].get(a)}
        explained = lambda app: app in updated  # noqa: E731
        if any(not explained(_app_of(p)) for p in changed) and grace:
            time.sleep(grace)  # App Manager writes the skill first, apps.json right after
            stamp, entries = _registry()
            updated = {a for a in set(entries) | set(_state['entries'])
                       if entries.get(a) != _state['entries'].get(a)}
            now = _files() or now
            changed = {p: _state['files'].get(p) for p in set(_state['files']) | set(now)
                       if _state['files'].get(p) != now.get(p)}
        wam_update = bool(call and call.get('wam') and stamp != call.get('stamp'))
        undone = _settle(changed, now, lambda app: wam_update or app in updated)
        _state.update(stamp=stamp, entries=entries)
        return undone


def tick() -> list[str]:
    """One watcher pass. Skips while a writing call runs (that call's end settles it)."""
    with _lock:
        if _calls or not _baseline():
            return []
        found = _diff()
        stamp, entries = _registry()
        if found is None:
            _suspect.clear()
            _state.update(stamp=stamp, entries=entries)
            return []
        now, changed = found
        if stamp != _state['stamp']:
            # App Manager rewrote the registry: its skill copies are the release.
            _settle(changed, now, lambda app: True)
            _suspect.clear()
            _state.update(stamp=stamp, entries=entries)
            return []
        if {p: now.get(p) for p in changed} != _suspect:
            _suspect.clear()
            _suspect.update({p: now.get(p) for p in changed})
            return []   # wait one tick: a half-finished App Manager write is never undone
        _suspect.clear()
        undone = _settle(changed, now, lambda app: False)
        if undone:
            note = message(undone)
            logger.warning('app-skill undo (background): %s', note)
            _late.append(note)
        return undone


def _watch() -> None:
    while True:
        time.sleep(WATCH_SECONDS)
        try:
            tick()
        except Exception:  # noqa: BLE001 - the watcher never dies on one bad pass
            logger.exception('app-skill undo: watcher pass failed')


def _start_watcher() -> None:
    global _watcher
    if WATCH_SECONDS > 0 and (_watcher is None or not _watcher.is_alive()):
        _watcher = threading.Thread(target=_watch, name='wizard-app-skill-undo', daemon=True)
        _watcher.start()


def _key(tool_name, kwargs) -> tuple:
    call_id = kwargs.get('tool_call_id') or ''
    return ('id', call_id) if call_id else (tool_name, kwargs.get('task_id') or '', kwargs.get('session_id') or '')


def _runs_app_manager(tool_name: str, args) -> bool:
    """A terminal command with a segment whose program is `wam` (not just the word mentioned)."""
    if tool_name != 'terminal' or not isinstance(args, dict):
        return False
    for segment in SEGMENT_RE.split(str(args.get('command') or '')):
        try:
            words = shlex.split(segment)
        except ValueError:
            words = segment.split()
        words = [w for w in words if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*=.*', w)]
        while words and words[0] in {'sudo', 'env', 'command', 'nice', 'nohup', 'time', 'exec'}:
            words = words[1:]
        if words and os.path.basename(words[0]) == 'wam':
            return True
    return False


def before_call(tool_name: str = '', args=None, **kwargs) -> None:
    """Runs inside app_skill_guard's pre_tool_call hook, only when it did not block the call."""
    if tool_name not in WRITING_TOOLS:
        return None
    try:
        key = _key(tool_name, kwargs)
        undone = reconcile(grace=CALL_GRACE_SECONDS)   # what a background process changed since the last check
        with _lock:
            if undone:
                _late.append(message(undone))
            _calls[key] = {'wam': _runs_app_manager(tool_name, args), 'stamp': _state.get('stamp')}
        _start_watcher()
    except Exception:  # noqa: BLE001 - never block a tool on the backstop
        logger.exception('app-skill undo: before_call failed')
    return None


def _finish(tool_name, kwargs) -> None:
    key = _key(tool_name, kwargs)
    with _lock:
        call = _calls.pop(key, None)
    if call is None:
        return
    try:
        undone = reconcile(call=call, grace=CALL_GRACE_SECONDS)
    except Exception:  # noqa: BLE001
        logger.exception('app-skill undo: restore failed')
        return
    if undone:
        note = message(undone)
        logger.warning('app-skill undo: %s', note)
        with _lock:
            _notes[key] = note


def after_call(tool_name: str = '', args=None, **kwargs) -> None:
    """post_tool_call. In the agent loop it fires after transform_tool_result, so both settle; once."""
    _finish(tool_name, kwargs)
    return None


def message(paths: list[str]) -> str:
    try:
        from . import app_skill_guard as guard
    except ImportError:  # pragma: no cover
        import app_skill_guard as guard  # type: ignore[no-redef]
    shown = ', '.join(paths[:5]) + (f' and {len(paths) - 5} more' if len(paths) > 5 else '')
    return (f'App-skill guard undid changes to installed app skill files ({shown}): they change only through '
            f'the Builder and app updates, so the edit did not happen. {guard.ROUTE}')


def tell_agent(tool_name: str = '', args=None, result=None, **kwargs):
    """transform_tool_result: settle this call (if post_tool_call has not yet) and say what was undone."""
    _finish(tool_name, kwargs)
    with _lock:
        notes = [n for n in [_notes.pop(_key(tool_name, kwargs), None)] if n] + _late[:]
        _late.clear()
    if not notes:
        return None
    note = ' '.join(notes)
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            parsed['app_skill_guard'] = note
            return json.dumps(parsed, ensure_ascii=False)
        return f'{result}\n\n[{note}]'
    return None


def register(ctx) -> None:
    ctx.register_hook('post_tool_call', after_call)
    ctx.register_hook('transform_tool_result', tell_agent)


def _reset_for_tests() -> None:
    with _lock:
        for store in (_state, _calls, _notes, _suspect):
            store.clear()
        _late.clear()
