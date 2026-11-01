"""Keep app workflows in released app source, not private or installed skill copies.

App Manager wipes/re-copies installed skills on registry writes. This bounded
classifier catches skill_manage and literal file/shell writes whose *target* is
an installed app skill. It is a nudge toward the app's release process, not a
security boundary: computed paths and arbitrary programs are not interpreted
(fail-open). Reads, verification (cat/grep/sha256sum/cmp/diff with any
redirection to non-skill paths) and the `wam` install/update path stay allowed.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import shlex

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
# Python-level writes (execute_code, or `python -c` inside a shell command).
PY_WRITE_RE = re.compile(
    r"(write_text|write_bytes|\.unlink\(|\.rename\(|\.replace\(|\.touch\(|os\.remove|os\.rename|"
    r"os\.replace|shutil\.(?:copy\w*|move|rmtree)|open\([^)]*['\"][wax][+bt]*['\"])"
)
# Shell redirection: optional fd, > or >>, optional clobber |, then the target.
# `>&2` / `2>&1` duplicate descriptors and have no file target.
REDIRECT_RE = re.compile(r"(?<![>&])\d*>>?\|?\s*(?!&)(['\"]?)([^\s;|&<>'\"]+)\1")
SEGMENT_RE = re.compile(r"\|\||&&|[;\n]|(?<!>)\|")
ANY_ARG_WRITERS = {'tee', 'rm', 'touch', 'patch', 'truncate', 'unlink', 'mv', 'rmdir', 'mkdir', 'shred'}
DEST_WRITERS = {'cp', 'rsync', 'install', 'ln'}
SKIP_PREFIX = {'sudo', 'env', 'command', 'nice', 'nohup', 'time'}


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


def _skill_token(token: str) -> str | None:
    token = token.strip('\'"')
    path = _literal_skill_path(token)
    return path if path and token.startswith(path) else None


def _args(segment: str) -> list[str]:
    try:
        words = shlex.split(segment, comments=False, posix=True)
    except ValueError:
        words = segment.split()
    # Drop redirections (handled separately), env assignments and wrappers.
    out, skip_target = [], False
    for word in words:
        if skip_target:
            skip_target = False
            continue
        if re.fullmatch(r"\d*>>?\|?|\d*<<?-?|&>>?", word):
            skip_target = True
            continue
        if re.match(r"\d*>>?|\d*<|&>", word):
            continue
        if not out and (re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", word) or word in SKIP_PREFIX):
            continue
        out.append(word)
    return out


def _redirect_targets(segment: str) -> list[str]:
    """File targets of real redirection operators. Quoted text such as `printf '>/path'` is a word, not an
    operator; `>&2`, `2>&1` and `>&-` duplicate descriptors and have no file target."""
    try:
        lex = shlex.shlex(segment, posix=True, punctuation_chars='<>&|')
        lex.whitespace_split = True
        tokens = list(lex)
    except ValueError:  # unbalanced quotes: fall back to the conservative raw scan
        return [m.group(2) for m in REDIRECT_RE.finditer(segment)]
    out = []
    for op, target in zip(tokens, tokens[1:]):
        if '>' not in op or set(op) - set('<>&|'):
            continue
        if op.endswith('&') and (target.isdigit() or target == '-'):
            continue
        out.append(target)
    return out


def _dest_operands(cmd: str, rest: list[str]) -> list[str]:
    """Destination of cp/install/ln (`-t DIR`, `-tDIR`, `--target-directory[=]DIR`, else the last operand) and
    rsync (always the last operand; its `-t` is --times)."""
    if cmd != 'rsync':
        for i, w in enumerate(rest):
            if w.startswith('--target-directory='):
                return [w.split('=', 1)[1]]
            if w in ('-t', '--target-directory') and i + 1 < len(rest):
                return [rest[i + 1]]
            if re.fullmatch(r'-[A-Za-z]*t.+', w) and not w.startswith('--'):
                return [w[w.index('t') + 1:]]
    operands = [w for w in rest if not w.startswith('-')]
    return operands[-1:] if len(operands) >= 2 or (cmd == 'ln' and operands) else []


def _shell_write_target(text: str) -> str | None:
    """Return the protected path a shell command writes to, if any.

    Only the write *target* counts: reading an installed skill while redirecting
    stderr or output elsewhere is verification, not an edit. Relative targets after
    `cd` into a skill root are resolved against it, so the wizard-job-* routing
    exemption still applies.
    """
    cwd = None   # the literal skill-root directory a `cd` entered, if any

    def hit_for(word: str) -> str | None:
        word = word.strip('\'"')
        hit = _skill_token(word)
        if hit:
            return hit
        if cwd and word and not word.startswith(('/', '~', '$')):
            return _skill_token(cwd.rstrip('/') + '/' + word)
        return None

    for segment in SEGMENT_RE.split(text):
        segment = segment.strip()
        if not segment:
            continue
        for target in _redirect_targets(segment):
            hit = hit_for(target)
            if hit:
                return hit
        words = _args(segment)
        if not words:
            continue
        cmd, rest = os.path.basename(words[0]), words[1:]
        if cmd == 'cd':
            cwd = rest[0].strip('\'"') if rest and _skill_token(rest[0]) else None
            continue
        if cmd == 'wam':  # App Manager's own install/update path.
            continue
        operands = [w for w in rest if not w.startswith('-')]
        candidates: list[str] = []
        if cmd in ANY_ARG_WRITERS:
            candidates = operands
        elif cmd == 'sed' and any(w == '--in-place' or w.startswith('--in-place=')
                                  or re.fullmatch(r"-[a-zA-Z]*i\S*", w) for w in rest):
            candidates = operands
        elif cmd in DEST_WRITERS:
            candidates = _dest_operands(cmd, rest)
        elif cmd in {'python', 'python3', 'perl', 'node', 'ruby'} and PY_WRITE_RE.search(segment):
            path = _literal_skill_path(segment)
            if path:
                return path
        for word in candidates:
            hit = hit_for(word)
            if hit:
                return hit
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
    elif tool_name == 'terminal':
        target = _shell_write_target(str(args.get('command') or ''))
        if target:
            return _block(f'a shell write touching {target}')
    elif tool_name == 'execute_code':
        code = str(args.get('code') or '')
        for line in code.splitlines():
            if PY_WRITE_RE.search(line):
                path = _literal_skill_path(line)
                if path:
                    return _block(f'a code write touching {path}')
    return None


def register(ctx) -> None:
    def guard(tool_name='', args=None, **kwargs):
        # Optional, installation-owned migration list. No personal app/skill map
        # ships in the product. Read through Hermes's plugin config namespace.
        shadows = (ctx.get_config('app_skill_guard.shadow_skills', default=[])
                   if hasattr(ctx, 'get_config') else [])
        return pre_tool_call(tool_name, args, shadow_skills=shadows, **kwargs)

    ctx.register_hook('pre_tool_call', guard)
