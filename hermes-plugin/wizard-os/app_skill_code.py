"""Find installed-app-skill writes in execute_code Python, across lines.

The line-by-line check in app_skill_guard only sees a write when the call and the
literal path share one line. Real agent code builds the path first and writes it
later (``p = Path.home() / '.wizard-os/skills/x/SKILL.md'`` ... ``p.write_text(s)``,
``open(p, 'w')``, ``shutil.copy(src, p)``, ``subprocess.run(['cp', ...])`` or the
``hermes_tools`` write_file/patch/terminal helpers). This module follows simple
assignments with a small abstract evaluator: every expression becomes the path
text it could spell (string pieces joined in source order, ``Path.home()`` /
``~`` / ``$HOME`` as the home, ``$WIZARD_OS_HOME`` as the Wizard home), and every
write-shaped call is checked against that text. File *contents* (``read_text()``,
``read()``) carry no path, so reading a skill and editing the text elsewhere stays
allowed. Still a bounded nudge, not a sandbox: computed or encoded paths fail open.
"""
from __future__ import annotations

import ast
import re
from typing import Callable

# Calls whose result is file content or metadata, never a path.
CONTENT_CALLS = {'read_text', 'read_bytes', 'read', 'readline', 'readlines', 'exists', 'is_file',
                 'is_dir', 'stat', 'loads', 'load', 'dumps', 'dump', 'len', 'hexdigest', 'digest',
                 'splitlines', 'strip', 'lower', 'upper', 'startswith', 'endswith', 'count', 'find',
                 'encode', 'decode', 'sha256', 'md5', 'listdir', 'iterdir', 'glob', 'rglob'}
HOME_CALLS = {'home', 'gethomedir'}
# pathlib / file-object methods that write their receiver.
RECEIVER_WRITES = {'write_text', 'write_bytes', 'unlink', 'touch', 'mkdir', 'rmdir', 'rename',
                   'symlink_to', 'hardlink_to', 'chmod', 'lchmod', 'link_to'}
# module functions that write every positional path they are given.
ALL_ARG_WRITES = {'remove', 'unlink', 'rmdir', 'removedirs', 'mkdir', 'makedirs', 'rename', 'renames',
                  'truncate', 'chmod', 'chown', 'lchown', 'utime', 'rmtree', 'move'}
# hermes_tools helpers inside execute_code: only the path argument is a target.
TOOL_WRITES = {'write_file', 'patch'}
# module functions whose last positional argument is the destination.
DEST_WRITES = {'copy', 'copy2', 'copyfile', 'copytree', 'copymode', 'copystat', 'symlink', 'link'}
SHELL_CALLS = {'system', 'popen', 'run', 'call', 'check_call', 'check_output', 'Popen', 'terminal',
               'getoutput', 'getstatusoutput', 'spawnl', 'spawnlp', 'spawnv', 'spawnvp'}
OPEN_WRITE_MODE = re.compile(r'[wax+]')
OS_WRITE_FLAGS = {'O_WRONLY', 'O_RDWR', 'O_CREAT', 'O_TRUNC', 'O_APPEND'}


def _name(node: ast.AST | None) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ''


class _Eval:
    def __init__(self, home: str, os_home: str):
        self.home, self.os_home = home, os_home
        self.env: dict[str, str] = {}

    def text(self, node) -> str:
        """The path text an expression could spell ('' when it carries none)."""
        if node is None:
            return ''
        if isinstance(node, ast.Constant):
            if isinstance(node.value, str):
                value = node.value
                if value.startswith('~'):
                    value = self.home + value[1:]
                return value.replace('$HOME', self.home).replace('${HOME}', self.home) \
                    .replace('${WIZARD_OS_HOME}', self.os_home).replace('$WIZARD_OS_HOME', self.os_home)
            return ''
        if isinstance(node, ast.Name):
            return self.env.get(node.id, '')
        if isinstance(node, ast.Subscript) or (isinstance(node, ast.Call) and _name(node.func) in {'get', 'getenv'}):
            key = node.slice if isinstance(node, ast.Subscript) else (node.args[0] if node.args else None)
            if isinstance(key, ast.Constant) and key.value == 'HOME':
                return self.home
            if isinstance(key, ast.Constant) and key.value == 'WIZARD_OS_HOME':
                return self.os_home
            if isinstance(node, ast.Subscript):
                return self.text(node.value)
        if isinstance(node, ast.Call):
            fname = _name(node.func)
            if fname in HOME_CALLS or fname == 'os_home':
                return self.home if fname in HOME_CALLS else self.os_home
            if fname in CONTENT_CALLS or fname == 'open':
                return ''
        if isinstance(node, ast.Lambda):
            return ''
        parts = [self.text(child) for child in ast.iter_child_nodes(node)
                 if not isinstance(child, (ast.expr_context, ast.operator, ast.keyword))]
        if isinstance(node, ast.Call):
            parts += [self.text(kw.value) for kw in node.keywords]
        return '/'.join(part for part in parts if part)

    def assign(self, target, value: str) -> None:
        if isinstance(target, ast.Name):
            self.env[target.id] = value
        elif isinstance(target, (ast.Tuple, ast.List)):
            for element in target.elts:
                self.assign(element, value)


def _norm(text: str) -> str:
    text = re.sub(r'/+', '/', text)
    while '/./' in text:
        text = text.replace('/./', '/')
    return text


def _open_writes(call: ast.Call) -> bool:
    mode = call.args[1] if len(call.args) > 1 else next(
        (kw.value for kw in call.keywords if kw.arg in {'mode', 'flags'}), None)
    if mode is None:
        return False
    if isinstance(mode, ast.Constant) and isinstance(mode.value, str):
        return bool(OPEN_WRITE_MODE.search(mode.value))
    return any(_name(node) in OS_WRITE_FLAGS for node in ast.walk(mode))


def _shell_text(ev: _Eval, node) -> str:
    if isinstance(node, (ast.List, ast.Tuple)):
        return ' '.join(ev.text(e) for e in node.elts)
    return ev.text(node)


def code_write_target(code: str, path_hit: Callable[[str], str | None],
                      shell_hit: Callable[[str], str | None], home: str, os_home: str) -> str | None:
    """Return the protected path a Python snippet writes to, if any.

    `path_hit(text)` returns the protected path spelled in text (or None);
    `shell_hit(command)` does the same for a shell command line.
    """
    try:
        tree = ast.parse(code)
    except (SyntaxError, ValueError):
        return None
    ev = _Eval(home, os_home)

    def hit(node) -> str | None:
        return path_hit(_norm(ev.text(node)))

    # Statements in source order so assignments are known before later uses; nested
    # blocks (with/for/def bodies) are visited in place.
    for node in _ordered(tree):
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.NamedExpr)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            value = ev.text(node.value) if node.value is not None else ''
            if isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name):
                value = ev.env.get(node.target.id, '') + value
            for target in targets:
                ev.assign(target, value)
        elif isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
            ev.assign(node.target, ev.text(node.iter))
        elif isinstance(node, ast.withitem) and node.optional_vars is not None:
            if not (isinstance(node.context_expr, ast.Call) and _name(node.context_expr.func) == 'open'):
                ev.assign(node.optional_vars, ev.text(node.context_expr))
        elif isinstance(node, ast.Call):
            fname = _name(node.func)
            receiver = node.func.value if isinstance(node.func, ast.Attribute) else None
            positional = list(node.args)
            targets: list = []
            if fname == 'open':
                module = receiver is None or _name(receiver) in {'os', 'io', 'codecs'}
                if module and _open_writes(node):
                    targets = positional[:1]  # open(path, 'w'), os.open(path, os.O_WRONLY), io.open
                elif not module and _open_writes(ast.Call(func=node.func, args=[receiver] + positional,
                                                          keywords=node.keywords)):
                    targets = [receiver]  # Path(path).open('w')
            elif fname == 'replace' and receiver is not None and positional and _name(receiver) not in {'os'}:
                # Path.replace(dest) moves the receiver; str.replace(a, b) has two args.
                if len(positional) == 1:
                    targets = [receiver] + positional
            elif fname == 'replace' and _name(receiver) == 'os':
                targets = positional
            elif fname in RECEIVER_WRITES and receiver is not None and _name(receiver) not in {'os', 'shutil'}:
                targets = [receiver] + positional
            elif fname in TOOL_WRITES and receiver is None:
                targets = positional[:1] + [kw.value for kw in node.keywords if kw.arg == 'path']
            elif fname in ALL_ARG_WRITES:
                targets = positional + [kw.value for kw in node.keywords if kw.arg in {'path', 'src', 'dst'}]
            elif fname in DEST_WRITES:
                dest = next((kw.value for kw in node.keywords if kw.arg == 'dst'), None)
                targets = [dest] if dest is not None else positional[-1:] if len(positional) >= 2 else []
            elif fname in SHELL_CALLS and (positional or node.keywords):
                command = positional[0] if positional else next(
                    (kw.value for kw in node.keywords if kw.arg in {'args', 'command', 'cmd'}), None)
                found = shell_hit(_shell_text(ev, command)) if command is not None else None
                if found:
                    return found
            for target in targets:
                found = hit(target)
                if found:
                    return found
    return None


def _ordered(tree: ast.AST):
    """Pre-order walk in source order (ast.walk is breadth-first)."""
    stack = [tree]
    while stack:
        node = stack.pop()
        yield node
        children = list(ast.iter_child_nodes(node))
        # Visit an assignment's value before binding its target.
        stack.extend(reversed(children))
