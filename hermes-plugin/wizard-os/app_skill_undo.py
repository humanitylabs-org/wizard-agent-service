"""Undo any change an agent tool call makes to installed app skill files (#797).

The pre-call guard (app_skill_guard) reads the call's text, so a path it cannot
spell (a glob loop, os.walk, a computed name, a program it does not know) gets
through. This is the backstop that does not depend on reading the code: before
a tool that can write files runs, it keeps a copy of every installed app skill
file (the same roots the guard protects, minus wizard-job-* routing pointers);
after the call it compares, puts back what was changed or deleted, removes what
was added, and tells the agent in the tool result that the edit was undone and
why. The Builder and App Manager updates stay the only way these files change:

- A call that runs App Manager (`wam ...`) is not undone.
- If App Manager rewrote its registry (apps.json) while the call ran, the change
  is an app install/update and is kept.

Limits: writes made later by a process the call left running in the background
are not seen, and a skills tree over MAX_SNAPSHOT_BYTES is not copied (it is
logged and fails open).
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import re
import shutil
import threading
import time

try:
    from . import kernel
except ImportError:  # plain-module loading, like the other plugin helpers
    import kernel  # type: ignore[no-redef]

logger = logging.getLogger(__name__)

# Tools that can change files on disk. Read/search tools are never copied around.
WRITING_TOOLS = {'execute_code', 'terminal', 'write_file', 'patch', 'process', 'process_manage', 'skill_manage'}
MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
STALE_SECONDS = 6 * 3600
WAM_RE = re.compile(r'(?<![\w.-])wam(?![\w.-])')

_lock = threading.Lock()
_pending: dict[tuple, dict] = {}
_notes: dict[tuple, tuple[str, float]] = {}


def _roots() -> list[Path]:
    try:
        from . import app_skill_guard as guard
    except ImportError:  # pragma: no cover - plain-module loading
        import app_skill_guard as guard  # type: ignore[no-redef]
    return list(guard.skill_roots())


def _registry_stamp():
    try:
        st = (kernel.os_home() / 'apps.json').stat()
        return st.st_mtime_ns, st.st_size, st.st_ino
    except OSError:
        return None


def _scan(root: Path, prefix: str, budget: list[int]) -> dict[str, tuple[bytes, int]] | None:
    files: dict[str, tuple[bytes, int]] = {}
    try:
        entries = sorted(root.iterdir())
    except OSError:
        return files
    for app in entries:
        if app.name.startswith(prefix):
            continue
        walk = [app] if not app.is_dir() or app.is_symlink() else None
        paths = walk if walk is not None else [p for p in app.rglob('*')]
        for path in paths:
            try:
                if path.is_symlink() or not path.is_file():
                    continue
                st = path.stat()
                budget[0] -= st.st_size
                if budget[0] < 0:
                    return None
                files[str(path.relative_to(root))] = (path.read_bytes(), st.st_mode & 0o7777)
            except (OSError, ValueError):
                continue
    return files


def snapshot() -> dict | None:
    budget = [MAX_SNAPSHOT_BYTES]
    roots = {}
    for root in _roots():
        try:
            real = root.resolve()
        except (OSError, RuntimeError):
            continue
        if not real.is_dir() or str(real) in roots:
            continue
        files = _scan(real, kernel.JOB_SKILL_PREFIX, budget)
        if files is None:
            logger.warning('app-skill undo: installed skills exceed %d bytes, not copied', MAX_SNAPSHOT_BYTES)
            return None
        roots[str(real)] = files
    return {'roots': roots, 'registry': _registry_stamp(), 'at': time.time()}


def restore(before: dict) -> list[str]:
    """Put every root back to the snapshot; return the paths that were undone."""
    undone: list[str] = []
    for root_text, files in before['roots'].items():
        root = Path(root_text)
        now = _scan(root, kernel.JOB_SKILL_PREFIX, [MAX_SNAPSHOT_BYTES * 4]) or {}
        for rel, (data, mode) in files.items():
            current = now.get(rel)
            if current is not None and current[0] == data:
                if current[1] != mode:
                    try:
                        os.chmod(root / rel, mode)
                    except OSError:
                        pass
                continue
            path = root / rel
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                if path.is_symlink() or path.is_dir():
                    shutil.rmtree(path) if path.is_dir() and not path.is_symlink() else path.unlink()
                tmp = path.with_name(f'.{path.name}.wizard-undo')
                tmp.write_bytes(data)
                os.chmod(tmp, mode)
                os.replace(tmp, path)
                undone.append(str(path))
            except OSError as error:
                logger.warning('app-skill undo: could not restore %s: %s', path, error)
        for rel in sorted(set(now) - set(files), reverse=True):
            path = root / rel
            try:
                path.unlink()
                undone.append(str(path))
                parent = path.parent
                while parent != root and not any(parent.iterdir()):
                    parent.rmdir()
                    parent = parent.parent
            except OSError as error:
                logger.warning('app-skill undo: could not remove %s: %s', path, error)
    return undone


def _key(tool_name, kwargs) -> tuple:
    return (tool_name, kwargs.get('session_id') or '', kwargs.get('task_id') or '', kwargs.get('tool_call_id') or '')


def _runs_app_manager(tool_name: str, args) -> bool:
    if not isinstance(args, dict):
        return False
    text = str(args.get('command') or '') if tool_name == 'terminal' else (
        str(args.get('code') or '') if tool_name == 'execute_code' else '')
    return bool(WAM_RE.search(text))


def before_call(tool_name: str = '', args=None, **kwargs):
    if tool_name not in WRITING_TOOLS or _runs_app_manager(tool_name, args):
        return None
    try:
        snap = snapshot()
    except Exception:  # noqa: BLE001 - never block a tool on the backstop
        logger.exception('app-skill undo: snapshot failed')
        return None
    if snap is None:
        return None
    with _lock:
        cutoff = time.time() - STALE_SECONDS
        for key in [k for k, v in _pending.items() if v['at'] < cutoff]:
            _pending.pop(key, None)
        _pending[_key(tool_name, kwargs)] = snap
    return None


def message(paths: list[str]) -> str:
    try:
        from . import app_skill_guard as guard
    except ImportError:  # pragma: no cover
        import app_skill_guard as guard  # type: ignore[no-redef]
    shown = ', '.join(paths[:5]) + (f' and {len(paths) - 5} more' if len(paths) > 5 else '')
    return (f'App-skill guard undid this call\'s changes to installed app skill files ({shown}): '
            f'they change only through the Builder and app updates. {guard.ROUTE}')


def after_call(tool_name: str = '', args=None, **kwargs) -> None:
    """post_tool_call: fires on every finished call (also errors), so the undo always runs."""
    key = _key(tool_name, kwargs)
    with _lock:
        before = _pending.pop(key, None)
    if before is None:
        return None
    try:
        if _registry_stamp() != before['registry']:
            return None  # App Manager installed or updated apps meanwhile: keep its files.
        undone = restore(before)
    except Exception:  # noqa: BLE001
        logger.exception('app-skill undo: restore failed')
        return None
    if undone:
        note = message(undone)
        logger.warning('app-skill undo: %s', note)
        with _lock:
            _notes[key] = (note, time.time())
    return None


def tell_agent(tool_name: str = '', args=None, result=None, **kwargs):
    """transform_tool_result: say in the result that the edit was undone, and why."""
    with _lock:
        cutoff = time.time() - STALE_SECONDS
        for stale in [k for k, v in _notes.items() if v[1] < cutoff]:
            _notes.pop(stale, None)
        entry = _notes.pop(_key(tool_name, kwargs), None)
    if entry is None:
        return None
    note = entry[0]
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            parsed['app_skill_guard'] = note
            return json.dumps(parsed, ensure_ascii=False)
        return f'{result}\n\n[{note}]'
    return json.dumps({'result': result, 'app_skill_guard': note}, ensure_ascii=False, default=str)


def register(ctx) -> None:
    """before_call runs inside app_skill_guard's pre_tool_call hook, only when it did not block."""
    ctx.register_hook('post_tool_call', after_call)
    ctx.register_hook('transform_tool_result', tell_agent)
