"""Keep app workflows in released app source, not private or installed skill copies.

App Manager wipes/re-copies installed skills on registry writes. This bounded
classifier catches skill_manage and literal file/shell writes; it is not a
sandbox and does not interpret computed paths or arbitrary programs.
"""
from __future__ import annotations

import os
from pathlib import Path
import re

try:
    from . import kernel
except ImportError:  # plain-module loading, like the other plugin helpers
    import kernel  # type: ignore[no-redef]

# App Manager's wam/agent_link.py SKILLS_TARGET (read-only container bind mount).
SKILLS_TARGET = Path('/opt/wizard-os/skills')
ROUTING_PREFIX = kernel.JOB_SKILL_PREFIX
ROUTE = (
    "App workflows live in the app, so every Wizard gets the same behaviour. "
    "Make this change in the app's source repo instead (its SKILL.md / wizard.md / "
    "presets / validators), push a named branch, and follow the app's review and "
    "release process; then update installs and verify the installed skill matches "
    "the release. If the owner has not approved an app change, propose it in the "
    "thread. Do not keep a personal workflow copy in Hermes skills."
)
WRITE_RE = re.compile(
    r"(>|\btee\b|\bsed\b[^|;&]*\s-i|\bcp\b|\bmv\b|\brsync\b|\binstall\b|"
    r"\bpatch\b|\bln\b|\brm\b|\btouch\b|write_text|write_bytes|write_file|"
    r"open\([^)]*['\"][wax][+bt]*['\"])"
)


def skill_roots() -> tuple[Path, ...]:
    # Resolve per call: the home is not frozen at plugin import/registration.
    home = kernel.os_home()
    return home / 'skills', home / 'store/skills', SKILLS_TARGET


def _frontmatter_name(path: Path) -> str | None:
    try:
        with path.open(encoding='utf-8', errors='ignore') as source:
            if source.readline().strip() != '---':
                return None
            for _, line in zip(range(32), source):
                if line.strip() == '---':
                    break
                if line.startswith('name:'):
                    return line.split(':', 1)[1].strip().strip("'\"") or None
    except OSError:
        pass
    return None


def app_skill_names() -> dict[str, str]:
    """Installed ids plus frontmatter aliases, including registry-less mounts."""
    names: dict[str, str] = {}
    registry = kernel.read_registry()
    apps = registry.get('apps') if isinstance(registry, dict) else None
    for app in apps if isinstance(apps, list) else []:
        if not isinstance(app, dict):
            continue
        app_id = app.get('id')
        if isinstance(app_id, str) and app_id and app.get('skill') and not app_id.startswith(ROUTING_PREFIX):
            names[app_id] = app_id
    for root in skill_roots():
        try:
            for entry in root.iterdir():
                if not entry.is_dir() or entry.name.startswith(ROUTING_PREFIX):
                    continue
                names.setdefault(entry.name, entry.name)
                alias = _frontmatter_name(entry / 'SKILL.md')
                if alias and not alias.startswith(ROUTING_PREFIX):
                    names.setdefault(alias, entry.name)
        except OSError:
            continue
    return names


def _protected_path(raw: str) -> bool:
    try:
        path = Path(os.path.expanduser(raw)).resolve()
        for root in skill_roots():
            try:
                rel = path.relative_to(root.resolve())
            except ValueError:
                continue
            if not (rel.parts and rel.parts[0].startswith(ROUTING_PREFIX)):
                return True
    except (OSError, RuntimeError, ValueError):
        pass
    return False


def _block(what: str) -> dict[str, str]:
    return {'action': 'block', 'message': f'App-skill guard blocked {what}. {ROUTE}'}


def _ops(args: dict) -> list[dict]:
    ops = args.get('operations')
    if isinstance(ops, list):
        return [op for op in ops if isinstance(op, dict)]
    return [args] if args.get('name') else []


def _shrinks(op: dict) -> bool:
    if str(op.get('action') or '') in {'delete', 'remove_file'}:
        return True
    return (op.get('action') == 'patch' and 'old_string' in op
            and len(str(op.get('new_string') or '')) <= len(str(op.get('old_string') or '')))


def _shadow_names(config) -> dict[str, str]:
    names = {}
    for item in config if isinstance(config, list) else []:
        if not isinstance(item, dict):
            continue
        name, app_id = item.get('name'), item.get('app_id')
        if isinstance(name, str) and name and isinstance(app_id, str) and app_id:
            names[name] = app_id
    return names


def _literal_skill_path(text: str) -> str | None:
    """Match known home/mount spellings, not a hard-coded developer home."""
    roots = {str(root) for root in skill_roots()}
    home = str(Path.home())
    for root in tuple(roots):
        if root.startswith(home + '/'):
            roots.add('~' + root[len(home):])
    roots.update(variable + suffix for variable in ('$WIZARD_OS_HOME', '${WIZARD_OS_HOME}')
                 for suffix in ('/skills', '/store/skills'))
    # Routing-only pointer writes stay allowed, even in the same command.
    for root in sorted(roots, key=len, reverse=True):
        pattern = re.escape(root) + r'(?:/([A-Za-z0-9_.-]+))?(?=[/\s\'";|&)]|$)'
        for match in re.finditer(pattern, text):
            app = match.group(1)
            if not (app and app.startswith(ROUTING_PREFIX)):
                return match.group(0)
    return None


def pre_tool_call(tool_name: str = '', args=None, *, shadow_skills=None, **_kwargs):
    if not isinstance(args, dict):
        return None
    if tool_name == 'skill_manage':
        names, shadows = app_skill_names(), _shadow_names(shadow_skills)
        for op in _ops(args):
            name = str(op.get('name') or '')
            if name in names:
                return _block(f"skill_manage on '{name}', shipped by installed app '{names[name]}'")
            if name in shadows and not _shrinks(op):
                return _block(f"growing personal skill '{name}', which duplicates app '{shadows[name]}' "
                              "(it may only shrink toward 'use the app' until migrated)")
    elif tool_name in {'write_file', 'patch'}:
        paths = [args.get('path')]
        if args.get('mode') == 'patch' and args.get('patch'):
            paths += re.findall(r'\*\*\* (?:Update|Add|Delete) File: (.+)', str(args['patch']))
        for raw in paths:
            if isinstance(raw, str) and raw and _protected_path(raw):
                return _block(f'editing installed app skill copy {raw}')
    elif tool_name in {'terminal', 'execute_code'}:
        text = str(args.get('command') or args.get('code') or '')
        if WRITE_RE.search(text):
            path = _literal_skill_path(text)
            if path:
                return _block(f'a shell/code write touching {path}')
    return None


def register(ctx) -> None:
    def guard(tool_name='', args=None, **kwargs):
        # Optional, installation-owned migration list. No personal app/skill map
        # ships in the product. Read through Hermes's plugin config namespace.
        shadows = (ctx.get_config('app_skill_guard.shadow_skills', default=[])
                   if hasattr(ctx, 'get_config') else [])
        return pre_tool_call(tool_name, args, shadow_skills=shadows, **kwargs)

    ctx.register_hook('pre_tool_call', guard)
