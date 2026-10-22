#!/usr/bin/env python3
"""Owner-operated, journalled Hermes imports. No agent-facing Docker or shell API.

The host runtime owns this library, not the Agent Service HTTP process. Plans contain
names/metadata only; credentials are read only at apply and never subprocess arguments.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

import yaml
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import import_credentials as credential_policy

SCHEMA = 1
IMAGE = 'ghcr.io/humanitylabs-org/hermes-agent:v2026.9.24-wizard2'
OUTSIDE_TOOLS = 'web search browser x_search vision video image_gen video_gen tts delegation connections homeassistant spotify'.split()
TOOLS = 'git gh ssh node npm python3 uv sqlite3 curl jq rg bw op systemctl docker'.split()
# Directory names, at a home root (also applied to named profile roots).
LOCAL = {'bin', 'hermes-agent', 'logs', 'cache', 'tmp', 'runtime', 'locks', 'backups',
         'state-snapshots', 'browser-profiles', 'terminal-sessions', '.pytest_cache',
         'venvs', 'node', 'installs', 'tools', 'vendor', 'lsp'}
RUNTIME_NAMES = {'gateway.pid', 'gateway.lock', 'cron.pid', 'gateway_state.json',
                 'processes.json', '.backup.lock', 'active_profile'}
PATH_RE = re.compile(r'(?<![\w:/])(?:~/(?:[\w.@+*/-]+)|/(?:[\w.@+*-]+/)*[\w.@+*-]+)')
NAME_RE = re.compile(r'^[a-zA-Z0-9_.-]+$')
ID_RE = re.compile(r'^[a-z][a-z0-9-]{0,30}$')
SECRET_KEY = re.compile(r'(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)', re.I)


class ImportFailure(Exception):
    """Only symbolic, non-secret errors cross the CLI boundary."""


def require(ok, code):
    if not ok:
        raise ImportFailure(code)


def dump(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + '.tmp-' + secrets.token_hex(4))
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(value, out, indent=2, sort_keys=True)
        out.write('\n')
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def file_hash(path):
    h = hashlib.sha256()
    with open(path, 'rb') as src:
        for block in iter(lambda: src.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def load_yaml(text):
    try:
        value = yaml.safe_load(text) or {}
        require(isinstance(value, dict), 'config_not_mapping')
        return value
    except yaml.YAMLError:
        raise ImportFailure('invalid_yaml') from None


def excluded(rel):
    p = PurePosixPath(rel)
    parts = p.parts
    if len(parts) > 2 and parts[0] == 'profiles':
        parts = parts[2:]
    if not parts:
        return False
    return (parts[0] in LOCAL or p.name in RUNTIME_NAMES
            or (len(parts) == 1 and (p.name.startswith(('.env.bak', 'config.yaml.bak', 'config.yaml.pre-', 'state.db.malformed-backup')) or '.audit-backup-' in p.name))
            or p.name.endswith(('.lock', '.pid', '-wal', '-shm', '-journal', '.pyc'))
            or any(x in {'__pycache__', '.git', 'node_modules'} for x in parts)
            or parts[:2] == ('data', 'apps')
            or (parts[0] == 'plugins' and len(parts) > 1 and parts[1].startswith('wizard')))


def archive_entries(path, *, max_bytes=128 * 1024**3, max_members=300000):
    """Validate EVERY member before extracting any. Refuse aliases, special files and bombs."""
    try:
        with zipfile.ZipFile(path) as z:
            infos = z.infolist()
            require(len(infos) <= max_members, 'archive_member_limit')
            require(sum(i.file_size for i in infos) <= max_bytes, 'archive_size_limit')
            seen = set()
            for i in infos:
                n = i.filename
                require(n and not n.startswith(('/', '\\')) and '\\' not in n
                        and '\x00' not in n and ':' not in n
                        and all(p not in {'', '.', '..'} for p in n.rstrip('/').split('/')),
                        'archive_path')
                require(n.rstrip('/') not in seen, 'archive_duplicate')
                seen.add(n.rstrip('/'))
                mode = i.external_attr >> 16
                kind = stat.S_IFMT(mode)
                require(kind in {0, stat.S_IFREG, stat.S_IFDIR}, 'archive_special_file')
                require(i.file_size <= max_bytes and not (i.flag_bits & 1), 'archive_unsupported')
            names = [i.filename for i in infos if not i.is_dir()]
            # Stock Hermes archives are root-relative; accept one conventional wrapper folder.
            roots = {n.split('/')[0] for n in names}
            prefix = next(iter(roots)) + '/' if len(roots) == 1 and all('/' in n for n in names) else ''
            out = []
            for i in infos:
                if i.is_dir():
                    continue
                rel = i.filename[len(prefix):]
                require(not rel.startswith('_external/'), 'external_archive_requires_separate_approval')
                out.append((i.filename, rel, i.file_size))
            require(any(r == 'config.yaml' for _, r, _ in out), 'archive_no_config')
            return out
    except (zipfile.BadZipFile, OSError):
        raise ImportFailure('archive_invalid') from None


def files(root):
    """No symlink traversal; permission failures make the inventory incomplete, not silently green."""
    errors = []
    for base, dirs, names in os.walk(root, followlinks=False, onerror=lambda e: errors.append(e)):
        dirs[:] = sorted(d for d in dirs if not (Path(base) / d).is_symlink())
        for name in sorted(names):
            p = Path(base) / name
            if p.is_symlink():
                yield p, p.relative_to(root).as_posix(), p.lstat(), True
            else:
                try:
                    yield p, p.relative_to(root).as_posix(), p.stat(), False
                except FileNotFoundError:
                    continue  # A live writer's transient file; not portable state.
    if errors:
        raise ImportFailure('inventory_unreadable')


def read_inventory(root):
    """Prune known local trees before walking; report their sizes separately via root stat.

    Home scans inspect portable text/config and metadata; never hash or copy a large DB.
    """
    rows, texts, symlinks, skipped = [], {}, [], []
    for base, dirs, names in os.walk(root, followlinks=False):
        relbase = Path(base).relative_to(root)
        kept = []
        for d in sorted(dirs):
            p = Path(base) / d
            rel = (relbase / d).as_posix()
            if p.is_symlink():
                symlinks.append({'path': rel, 'target': str(p.resolve())})
            elif excluded(rel + '/placeholder'):
                skipped.append(rel)
            else:
                kept.append(d)
        dirs[:] = kept
        for n in sorted(names):
            p = Path(base) / n
            rel = (relbase / n).as_posix()
            try:
                s = p.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(s.st_mode):
                symlinks.append({'path': rel, 'target': str(p.resolve())})
                continue
            if not stat.S_ISREG(s.st_mode) or excluded(rel):
                continue
            rows.append((rel, s.st_size, s.st_mtime_ns))
            text_scope = (rel in {'config.yaml', 'SOUL.md', 'AGENTS.md', 'cron/jobs.json', '.env'}
                          or rel.startswith(('skills/', 'memories/', 'plugins/', 'profiles/')))
            if text_scope and s.st_size < 2 * 1024**2 and p.suffix.lower() in {'.md', '.yaml', '.yml', '.json', '.toml', '.py', '.sh', '.txt', '.env', ''}:
                try:
                    texts[rel] = p.read_text()
                except (UnicodeError, OSError):
                    pass
    return rows, texts, symlinks, skipped


def scan(source, *, owner_home=None):
    source = Path(source).absolute()
    owner_home = Path(owner_home or (source.parent if source.name == '.hermes' else Path.home())).absolute()
    is_zip = source.is_file()
    if is_zip:
        entries = archive_entries(source)
        rows = [(r, n, 0) for _, r, n in entries]
        texts = {}
        with zipfile.ZipFile(source) as z:
            for n, r, size in entries:
                if size < 2 * 1024**2 and (r in {'config.yaml', '.env', 'SOUL.md', 'AGENTS.md', 'cron/jobs.json'} or r.startswith(('skills/', 'plugins/', 'memories/'))):
                    with contextlib.suppress(UnicodeError):
                        texts[r] = z.read(n).decode()
        with zipfile.ZipFile(source) as z:
            names = {r: n for n, r, _ in entries}
            credential_items = credential_policy.inventory(names, lambda r: z.read(names[r]).decode())
        symlinks, skipped = [], [r for _, r, _ in entries if excluded(r)]
        identity = {'sha256': file_hash(source)}
    else:
        require(source.is_dir() and not source.is_symlink(), 'source_not_directory')
        rows, texts, symlinks, skipped = read_inventory(source)
        credential_items = credential_policy.inventory([r for r, _, _ in rows], lambda r: (source / r).read_text())
        # No ever-changing sessions or WAL stamps in the approval identity. Critical inputs are hash-bound.
        critical_names = {r for r in texts if r.startswith('plugins/')} | {c['path'] for c in credential_items} | {'config.yaml', '.env', 'cron/jobs.json'}
        identity = {'device': source.stat().st_dev, 'inode': source.stat().st_ino,
                    'critical': {r: file_hash(source / r) if (source / r).is_file() else None for r in sorted(critical_names)}}
    require('config.yaml' in texts, 'source_no_regular_config')
    cfg = load_yaml(texts.get('config.yaml', '{}'))
    deps = {}
    def add(path, kind, ref, proposal, **extra):
        path = str(path)
        key = (path, kind)
        item = deps.setdefault(key, {'path': path, 'kind': kind, 'references': [], 'proposal': proposal, 'approved': False, **extra})
        if ref not in item['references']:
            item['references'].append(ref)
    for rel, text in texts.items():
        if rel == '.env':
            continue  # Never derive dependency strings from credentials.
        for line_no, line in enumerate(text.splitlines(), 1):
            # Key/value credentials and URLs are not eligible for path extraction.
            fields = re.finditer(r'''(?<![\w.-])["']?([\w.-]*(?:token|secret|password|api[_-]?key|access[_-]?key|credential|authorization)[\w.-]*)["']?\s*[:=]''', line, re.I)
            if any(not match[1].lower().endswith(('_file', '_path', '-file', '-path')) for match in fields):
                continue
            for m in PATH_RE.finditer(line):
                raw = m.group().rstrip('/.,;')
                path = str(owner_home / raw[2:]) if raw.startswith('~/') else raw
                if path == str(source) or path.startswith(str(source) + '/'):
                    continue
                if path in {'/dev/null', '/bin/sh', '/bin/bash', '/usr/bin/env'}:
                    continue
                credential_ref = re.search(r'(?:token|secret|password|credential|key)[_-](?:file|path)', line, re.I) is not None
                kind = 'credential' if credential_ref or any(x in path for x in ('/.ssh', '/.config/gh', '/.gitconfig', '/.config/op', '/.config/Bitwarden')) else 'folder' if path.startswith((str(owner_home) + '/', '/Volumes/', '/workspace', '/opt/')) else 'unknown'
                proposal = 'carry secret' if kind == 'credential' else 'mount ro' if kind == 'folder' else 'leave behind'
                add(path, kind, f'{rel}:{line_no}', proposal)
    for item in symlinks:
        add(item['target'], 'unknown', item['path'] + ' (symlink)', 'leave behind')
    for rel in ('.ssh', '.config/gh/hosts.yml', '.gitconfig', '.git-credentials', '.config/op', '.config/Bitwarden CLI', '.local/share/bitwarden-cli', '.claude/.credentials.json', '.claude.json', '.codex/auth.json'):
        path = owner_home / rel
        if path.exists():
            add(path, 'credential', 'owner credential discovery', 'carry secret')
    for tool in TOOLS:
        add(tool, 'host-service' if tool in {'docker', 'systemctl'} else 'tool', 'runtime/tool inventory',
            'leave behind' if tool in {'docker', 'systemctl'} else 'available in image' if tool in {'git', 'ssh', 'node', 'npm', 'python3', 'uv', 'curl', 'rg'} else 'missing', host_available=shutil.which(tool) is not None)
    for service in ('docker.sock', 'host shell', 'Runtipi/App Manager install authority'):
        add(service, 'host-service', 'seal #59', 'leave behind')
    for name, val in (cfg.get('mcp_servers') or {}).items():
        if isinstance(val, dict) and val.get('command'):
            command = str(val['command'])
            # Emit executable path/name, never embedded shell commands or arguments.
            if re.fullmatch(r'[\w./~+-]+', command):
                add(command, 'tool', f'config.yaml:mcp_servers.{name}.command', 'missing')
    jobs_doc = json.loads(texts.get('cron/jobs.json', '{"jobs":[]}'))
    jobs = jobs_doc if isinstance(jobs_doc, list) else jobs_doc.get('jobs', [])
    platforms = (cfg.get('gateway') or {}).get('platforms') or cfg.get('platforms') or {}
    env_names = sorted(set(re.findall(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=', texts.get('.env', ''), re.M)))
    sessions = None
    if not is_zip and (source / 'state.db').exists():
        try:
            # A SQLite connection context only commits/rolls back; it does NOT
            # close descriptors. A leaked read-only WAL reader can retain an
            # O_RDWR -shm fd and make the subsequent stopped-writer census fail.
            with contextlib.closing(sqlite3.connect((source / 'state.db').as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
                sessions = db.execute('SELECT count(*) FROM sessions').fetchone()[0]
        except sqlite3.Error:
            sessions = 'unavailable'
    paths = [r for r, _, _ in rows]
    plan = {'schema': SCHEMA, 'source': str(source), 'source_kind': 'archive' if is_zip else 'home',
            'owner_home': str(owner_home), 'source_identity': identity, 'approved': False,
            'path_preserving': not is_zip, 'logical_home': str(source) if not is_zip else '/opt/data',
            'mode': 'paused', 'move': False,
            'image': IMAGE, 'network': 'restricted', 'port': 18720,
            'credentials': credential_items, 'isolation': 'restricted', 'supplemental_groups': [],
            'gateway_url': '', 'approved_plugins': [], 'approved_mcp': [],
            'approved_env_names': [],  # deprecated; use per-path credentials entries
            'outside_tools': [],
            'wizard_assets': [], 'source_units': [],
            'dependencies': sorted(deps.values(), key=lambda d: (d['kind'], d['path'])),
            'summary': {'portable_bytes': sum(n for _, n, _ in rows), 'files': len(rows),
                        'sessions': sessions, 'state_db_bytes': next((n for r, n, _ in rows if r == 'state.db'), 0),
                        'memory_provider': (cfg.get('memory') or {}).get('provider', 'builtin'),
                        'skills': sum(p.startswith('skills/') and p.endswith('/SKILL.md') for p in paths),
                        'model': {k: v for k, v in (cfg.get('model') or {}).items() if k in {'provider', 'default'}},
                        'plugins': sorted({p.split('/')[1] for p in paths if p.startswith('plugins/') and len(p.split('/')) > 2}),
                        'mcp_servers': sorted((cfg.get('mcp_servers') or {}).keys()),
                        'cron_jobs': len(jobs), 'cron_enabled': sum(j.get('enabled', True) and j.get('state') != 'paused' and not j.get('paused_at') for j in jobs),
                        'platforms_enabled': sorted(k for k, v in platforms.items() if isinstance(v, dict) and v.get('enabled')),
                        'credential_names': [n for n in env_names if SECRET_KEY.search(n)],
                        'excluded_local_roots': sorted(set(skipped)), 'symlinks': len(symlinks)}}
    # Review token changes whenever ANY selection/permission/route changes. No secret bytes in the plan.
    return plan


def approval_hash(plan):
    return digest({k: v for k, v in plan.items() if k not in {'approval', 'approved'}})


def assert_owner(path):
    require(os.geteuid() != 0, 'run_as_owner_not_root')
    require(Path(path).stat().st_uid == os.geteuid(), 'not_owner')


def safe_mount(path, *, owner_home, wizard_home, source):
    require(',' not in str(path) and not any(ord(c) < 32 for c in str(path)), 'mount_path_invalid')
    p = Path(path)
    require(p.is_absolute() and not any(c in str(p) for c in '\n\r,:') and '..' not in p.parts, 'mount_path')
    require(p.exists(), 'mount_missing')
    p = p.resolve()
    forbidden = [Path(wizard_home).resolve(), Path(owner_home) / '.wizard-os', Path(source).resolve(),
                 Path('/var/run'), Path('/run'), Path('/proc'), Path('/sys'), Path('/dev'), Path('/etc'), Path('/root')]
    for blocked in forbidden:
        blocked = blocked.resolve()
        require(not (p == blocked or p in blocked.parents or blocked in p.parents), 'mount_sealed')
    require(p != Path(owner_home).resolve() and p != Path('/') and p != Path('/home'), 'mount_owner_home')
    if p.is_dir():
        # Bind mounts cannot smuggle another agent via nested mounts or symlinks resolved by the host.
        for base, dirs, names in os.walk(p, followlinks=False):
            require('.wizard-os' not in dirs, 'mount_contains_wizard')
            for n in dirs + names:
                q = Path(base) / n
                if q.is_symlink():
                    r = q.resolve()
                    require(not any(r == b or b in r.parents for b in forbidden[:2]), 'mount_sealed_symlink')
            dirs[:] = [d for d in dirs if d not in {'.git', 'node_modules', '__pycache__'} and not (Path(base) / d).is_symlink()]
    return str(p)


def logical_home(plan):
    return plan.get('logical_home', plan['source']) if plan['path_preserving'] else '/opt/data'


def validate_plan(plan, wizard_home):
    require(plan.get('schema') == SCHEMA and plan.get('approved') is True
            and secrets.compare_digest(str(plan.get('approval', '')), approval_hash(plan)), 'plan_not_approved')
    require(plan.get('mode') in {'paused', 'take-over'}, 'mode_invalid')
    require(plan.get('mode') != 'take-over' or (plan.get('move') and plan.get('source_units')), 'takeover_requires_move_and_writer_units')
    require(not plan.get('move') or plan.get('source_kind') == 'home', 'move_archive')
    require(plan.get('move') or plan.get('source_kind') == 'archive', 'home_requires_move')
    require(bool(plan.get('path_preserving')) == (plan.get('source_kind') == 'home'), 'path_rewrite_not_supported')
    target = Path(logical_home(plan))
    if plan['path_preserving']:
        owner = Path(plan['owner_home'])
        require(target.is_absolute() and '..' not in target.parts and target != owner and owner in target.parents
                and '.wizard-os' not in target.parts and not target.is_relative_to(Path(wizard_home)), 'logical_home_invalid')
    require(isinstance(plan.get('port'), int) and 1024 <= plan['port'] <= 65535, 'port_invalid')
    require(re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', plan.get('network', '')) is not None and plan['network'] not in {'host', 'none'}, 'network_required')
    require(re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9./:@_-]+', plan.get('image', '')) is not None, 'image_invalid')
    require(re.fullmatch(r'https?://[a-zA-Z0-9_.:-]+/wizard/mcp', plan.get('gateway_url', '')) is not None, 'wizard_gateway_required')
    require(set(plan.get('outside_tools', [])) <= set(OUTSIDE_TOOLS), 'outside_tools_invalid')
    for name in plan.get('approved_env_names', []):
        require(re.fullmatch(r'[A-Z_][A-Z0-9_]*', name) is not None, 'env_name_invalid')
    for name in plan.get('approved_plugins', []) + plan.get('approved_mcp', []):
        require(NAME_RE.fullmatch(name) is not None and name not in {'.', '..'} and not name.startswith('wizard'), 'plugin_name')
    for item in plan.get('dependencies', []):
        require(item.get('kind') in {'folder', 'credential', 'tool', 'host-service', 'unknown'}, 'dependency_kind')
        if not item.get('approved'):
            continue
        action = item.get('action', item['proposal'])
        if 'credential_source' in item:
            require(action == 'carry secret' and item['kind'] == 'credential', 'credential_source_action')
            scoped = Path(safe_mount(item['credential_source'], owner_home=plan['owner_home'], wizard_home=wizard_home, source=plan['source']))
            require(scoped.is_relative_to(Path(plan['owner_home']).resolve()), 'credential_outside_owner_home')
            require(not scoped.is_relative_to(Path(plan['source']).resolve()), 'credential_source_inside_home')
        require(action in {'mount ro', 'mount rw', 'carry secret', 'available in image', 'leave behind'}, 'dependency_action')
        if action in {'mount ro', 'mount rw', 'carry secret'}:
            mount = Path(safe_mount(item['path'], owner_home=plan['owner_home'], wizard_home=wizard_home, source=plan['source']))
            require(not mount.is_relative_to(Path(plan['source']).resolve())
                    and not mount.is_relative_to(target.resolve()) and mount != target, 'home_mount_override')
        require(item['kind'] != 'host-service' or action == 'leave behind', 'host_authority_forbidden')
    for asset in plan.get('wizard_assets', []):
        require(asset['kind'] in {'plugins', 'skills'} and NAME_RE.fullmatch(asset['name']) and asset['name'].startswith('wizard'), 'wizard_asset')
        require(file_hash(asset['archive']) == asset['sha256'], 'wizard_asset_changed')
        archive_entries(asset['archive'])  # Assets use the same checked envelope (config.yaml required).


def run(argv, *, timeout=120, env=None, input=None):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env, input=input)
    except (OSError, subprocess.TimeoutExpired):
        raise ImportFailure('command_unavailable_or_timeout') from None
    require(result.returncode == 0, 'command_failed_' + Path(argv[0]).name)
    return result.stdout


class DockerRuntime:
    def __init__(self, plan, directory, agent_id):
        self.plan, self.directory, self.id = plan, Path(directory), agent_id
        self.name = 'agent-' + agent_id

    def preflight(self):
        require(not run(['docker', 'ps', '-a', '--filter', 'name=^/' + self.name + '$', '--format', '{{.Names}}']).strip(), 'container_exists')
        run(['docker', 'image', 'inspect', self.plan['image'], '--format', '{{.Id}}'])
        run(['docker', 'network', 'inspect', self.plan['network'], '--format', '{{.Id}}'])
        import socket
        try:
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', self.plan['port']))
        except OSError:
            raise ImportFailure('port_in_use') from None

    def remove(self):
        out = run(['docker', 'ps', '-a', '--filter', 'name=^/' + self.name + '$', '--format', '{{.Names}}'])
        if self.name in out.splitlines():
            # Refuse to delete an unrelated pre-existing container, even on recovery.
            labels = json.loads(run(['docker', 'inspect', self.name, '--format', '{{json .Config.Labels}}']))
            require(labels.get('wizard.import.id') == self.id and labels.get('wizard.import.journal') == str(self.directory), 'container_not_owned')
            run(['docker', 'rm', '-f', '-v', self.name])
        require(not run(['docker', 'ps', '-a', '--filter', 'name=^/' + self.name + '$', '--format', '{{.Names}}']).strip(), 'container_removal_failed')

    def import_archive(self, archive, uid=None):
        # No network, no credentials in argv/env, no host service namespace. The stock
        # public CLI runs as the eventual agent UID into the owned, stopped home.
        code = ('import os,pathlib,runpy; h=pathlib.Path(os.environ["HOME"]); '
                '(h/".hermes").mkdir(parents=True,exist_ok=True); '
                '(h/".hermes/config.yaml").write_text("{}"); '
                'os.chdir("/opt/hermes"); import sys; '
                'sys.argv=["hermes","--ignore-rules","import","/import.zip","--force"]; '
                'runpy.run_module("hermes_cli.main",run_name="__main__")')
        run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
             '--security-opt', 'no-new-privileges', '--user', f'{os.getuid() if uid is None else uid}:{os.getgid() if uid is None else uid}',
             '--tmpfs', '/tmp:rw,mode=1777', '-e', 'HOME=/tmp/import-native', '-e', 'HERMES_HOME=/opt/data',
             '-e', 'PYTHONDONTWRITEBYTECODE=1', '--mount', f'type=bind,src={self.directory / "home"},dst=/opt/data',
             '--mount', f'type=bind,src={archive},dst=/import.zip,readonly',
             '--entrypoint', '/opt/hermes/.venv/bin/python', self.plan['image'], '-c', code], timeout=600)

    def start(self):
        p = self.plan
        h = logical_home(p)
        native_home = p['owner_home'] if p['path_preserving'] else '/opt/data/native-home'
        # Numeric --user alone has no NSS row in images whose built-in UID differs.
        # OpenSSH needs getpwuid(); expose a synthetic identity, not host passwd.
        require(not any(c in native_home for c in ':\r\n'), 'runtime_identity_home')
        identity = self.directory / 'runtime-identity'
        require(not identity.is_symlink(), 'runtime_identity_symlink')
        identity.mkdir(mode=0o700, exist_ok=True)
        uid, gid = os.getuid(), os.getgid()
        passwd = ('' if uid == 0 else 'root:x:0:0:root:/root:/bin/sh\n') + f'wizard-agent:x:{uid}:{gid}:Imported agent:{native_home}:/bin/sh\n'
        group = ('' if gid == 0 else 'root:x:0:\n') + f'wizard-agent:x:{gid}:\n'
        for name, text in [('passwd', passwd), ('group', group)]:
            path = identity / name
            require(not path.is_symlink(), 'runtime_identity_symlink')
            path.write_text(text)
            path.chmod(0o600)
        args = ['docker', 'run', '-d', '--name', self.name, '--label', 'wizard.import.id=' + self.id,
                '--label', 'wizard.import.journal=' + str(self.directory), '--network', p['network'],
                '--network-alias', self.name, '--restart', 'no', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '4g',
                '--user', f'{os.getuid()}:{os.getgid()}', '--tmpfs', '/tmp:rw,mode=1777',
                '-p', f'127.0.0.1:{p["port"]}:8642', '-e', 'HOME=' + native_home,
                '-e', 'HERMES_HOME=' + h, '-e', 'PYTHONDONTWRITEBYTECODE=1',
                '--mount', f'type=bind,src={identity / "passwd"},dst=/etc/passwd,readonly',
                '--mount', f'type=bind,src={identity / "group"},dst=/etc/group,readonly',
                '--mount', f'type=bind,src={self.directory / "home"},dst={h}',
                '--entrypoint', '/opt/hermes/.venv/bin/python']
        if h != '/opt/data':
            # Suppress the base image's anonymous VOLUME; no orphan volume on a
            # path-preserving import and no second durable home in the namespace.
            args += ['--tmpfs', f'/opt/data:rw,uid={os.getuid()},gid={os.getgid()},mode=0700']
        # No s6 root bootstrap/chown, no host executable/code, only the pinned image.
        for item in p['dependencies']:
            if item.get('approved') and item.get('action', item['proposal']) in {'mount ro', 'mount rw'}:
                src = safe_mount(item['path'], owner_home=p['owner_home'], wizard_home=self.directory.parent.parent, source=p['source'])
                args += ['--mount', f'type=bind,src={src},dst={item["path"]}' + (',readonly' if item.get('action', item['proposal']) == 'mount ro' else '')]
        for item in p['dependencies']:
            if item.get('approved') and item.get('action', item['proposal']) == 'carry secret':
                # Secrets are private copies, not writable source mounts; own host HOME is never mounted.
                dest = str(Path(native_home) / Path(item['path']).relative_to(p['owner_home']))
                args += ['--mount', f'type=bind,src={self.directory / "credentials" / digest(item["path"])},dst={dest},readonly']
        code = ('import os,runpy,sys; os.chdir(os.environ["HERMES_HOME"]); '
                'sys.path.insert(0,"/opt/hermes"); sys.argv=["hermes","gateway","run"]; '
                'runpy.run_module("hermes_cli.main",run_name="__main__")')
        args += [p['image'], '-c', code]
        run(args)

    def healthy(self, key, timeout=120):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            try:
                req = urllib.request.Request(f'http://127.0.0.1:{self.plan["port"]}/health', headers={'Authorization': 'Bearer ' + key})
                with urllib.request.urlopen(req, timeout=2) as r:
                    if r.status == 200:
                        return
            except OSError:
                pass
            time.sleep(1)
        raise ImportFailure('agent_health_timeout')


def atomic_backup(source, dest):
    """Publish complete bytes only; an interrupted copy is never a rollback input."""
    dest = Path(dest)
    tmp = dest.with_name(dest.name + '.partial-' + secrets.token_hex(4))
    shutil.copy2(source, tmp)
    with tmp.open('rb') as fd:
        os.fsync(fd.fileno())
    checksum = file_hash(tmp)
    marker = dest.with_name(dest.name + '.sha256')
    marker.write_text(checksum)
    with marker.open('rb') as fd:
        os.fsync(fd.fileno())
    os.replace(tmp, dest)
    fd = os.open(dest.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def validate_backups(directory, journal):
    for name in journal['backups']:
        original = Path(directory) / 'originals' / name
        if original.exists():
            marker = original.with_name(original.name + '.sha256')
            require(marker.is_file() and marker.read_text() == file_hash(original), 'backup_corrupt')


def sanitize_credentials(home, plan, directory, journal, journal_path):
    current = credential_policy.inventory([r for _, r, _, link in files(home) if not link],
                                          lambda r: managed_path(home, r).read_text())
    # Fresh names discovered after scan cannot inherit a broad/default approval.
    for rel in sorted({c['path'] for c in current} - {'.env', 'config.yaml'}):
        path = managed_path(home, rel)
        if not path.exists():
            continue
        items = [c for c in current if c['path'] == rel]
        if all(c['kind'] == 'file' for c in items) and credential_policy.selected(plan, rel, 'file'):
            continue
        if rel not in journal['backups']:
            journal['backups'].append(rel)
            dump(journal_path, journal)
            dest = directory / 'originals' / rel
            dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            atomic_backup(path, dest)
        if any(c['kind'] == 'auth-provider' or c['kind'] == 'auth-envelope' for c in items):
            path.write_text(credential_policy.filtered_auth(path.read_text(), plan, rel))
        elif any(c['kind'] == 'env' for c in items):
            path.write_text(credential_policy.filtered_env(path.read_text(), plan, rel))
        else:
            path.unlink()


def home_path(home, relative):
    home = Path(home)
    path = home / relative
    require(not home.is_symlink(), 'home_symlink')
    for parent in path.parents:
        if parent == home:
            break
        require(not parent.is_symlink(), 'managed_parent_symlink')
    return path


def managed_path(home, relative):
    """Agent-writable homes are untrusted: never follow their host-side links/FIFOs."""
    path = home_path(home, relative)
    require(not path.is_symlink(), 'managed_file_symlink')
    if path.exists():
        require(path.is_file() and path.stat().st_nlink == 1, 'managed_file_not_regular_or_shared')
    return path


def wire(home, plan, api_key, gateway_key):
    """Only passive data enters a paused rehearsal; originals are journalled by apply."""
    home = Path(home)
    for name in ['config.yaml', '.env', 'cron/jobs.json']:
        managed_path(home, name)
    cfg = credential_policy.filter_config(load_yaml((home / 'config.yaml').read_text() if (home / 'config.yaml').exists() else '{}'), plan)
    cfg['terminal'] = {'backend': 'local', 'cwd': logical_home(plan), 'timeout': 180}
    disabled = set((cfg.get('agent') or {}).get('disabled_toolsets') or [])
    disabled.update(set(OUTSIDE_TOOLS) - set(plan.get('outside_tools', [])))
    cfg.setdefault('agent', {})['disabled_toolsets'] = sorted(disabled)
    cfg['fallback_providers'] = []
    cfg['mcp_servers'] = {k: v for k, v in (cfg.get('mcp_servers') or {}).items() if k in plan.get('approved_mcp', [])}
    cfg['mcp_servers']['wizard'] = {'url': plan['gateway_url'], 'headers': {'Authorization': 'Bearer ${WIZARD_MCP_TOKEN}'}}
    # Do not multiplex imported named profiles, which would start their own gateways/cron.
    cfg.setdefault('gateway', {})['multiplex_profiles'] = False
    cfg['gateway']['platforms'] = cfg['gateway'].get('platforms') or cfg.get('platforms') or {}
    if plan['mode'] == 'paused':
        for name in cfg['gateway']['platforms']:
            cfg['gateway']['platforms'][name]['enabled'] = False
        cfg['platforms'] = {k: {**v, 'enabled': False} for k, v in (cfg.get('platforms') or {}).items()}
        cfg['hooks'] = {}
        cfg['curator'] = {'enabled': False}
    cfg['gateway']['platforms']['api_server'] = {'enabled': True}
    # Plugin activation is explicit; source host/Wizard bootstrap cannot win.
    memory_plugin = (cfg.get('plugins') or {}).get('hermes-memory-store')
    cfg['plugins'] = {'enabled': list(plan.get('approved_plugins', [])) + [a['name'] for a in plan.get('wizard_assets', []) if a['kind'] == 'plugins'], 'disabled': []}
    if isinstance(memory_plugin, dict):
        cfg['plugins']['hermes-memory-store'] = memory_plugin
    (home / 'config.yaml').write_text(yaml.safe_dump(cfg, sort_keys=False))
    os.chmod(home / 'config.yaml', 0o600)
    env_path = home / '.env'
    lines = credential_policy.filtered_env(env_path.read_text() if env_path.exists() else '', plan).splitlines()
    # Keep provider credentials; remove ALL platform discovery and host/runtime authority.
    # Source credentials remain in originals/.env, outside every container mount.
    protected = ('API_SERVER_', 'WIZARD_', 'HERMES_HOME', 'HOME', 'DOCKER_', 'SSH_AUTH_SOCK',
                 'TERMINAL_', 'HERMES_GATEWAY_', 'HERMES_PROFILE')
    platform = ('TELEGRAM_', 'DISCORD_', 'SLACK_', 'WHATSAPP_', 'SIGNAL_', 'MATRIX_', 'EMAIL_',
                'SMS_', 'FEISHU_', 'DINGTALK_', 'WECHAT_', 'WEIXIN_', 'NTFY_', 'TEAMS_', 'LINE_',
                'SIMPLEX_', 'BLUEBUBBLES_', 'PHOTON_', 'WEBHOOK_', 'MATTERMOST_', 'GOOGLE_CHAT_')
    kept = []
    for line in lines:
        match = re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=', line)
        if match and (match[1].startswith(protected) or (plan['mode'] == 'paused' and match[1].startswith(platform))):
            continue
        if match and SECRET_KEY.search(match[1]) and not credential_policy.selected(plan, '.env', 'env', match[1]):
            continue
        kept.append(line)
    kept += ['API_SERVER_HOST=0.0.0.0', 'API_SERVER_PORT=8642', 'API_SERVER_KEY=' + api_key, 'WIZARD_MCP_TOKEN=' + gateway_key]
    env_path.write_text('\n'.join(kept) + '\n')
    os.chmod(env_path, 0o600)
    cron = home / 'cron/jobs.json'
    if plan['mode'] == 'paused' and cron.exists():
        doc = json.loads(cron.read_text())
        for job in doc if isinstance(doc, list) else doc.get('jobs', []):
            job.update(enabled=False, state='paused', paused_at='import-rehearsal', next_run_at=None)
        dump(cron, doc)


def assert_no_writers(source, *, _pids=None):
    """Fail closed if a process still has a writable descriptor into the source home."""
    root = str(Path(source).resolve()) + '/'
    processes = Path('/proc').iterdir() if _pids is None else (Path('/proc') / str(pid) for pid in _pids)
    for proc in processes:
        if not proc.name.isdigit() or int(proc.name) == os.getpid():
            continue
        try:
            if proc.stat().st_uid != os.getuid():
                continue
            for fd in (proc / 'fd').iterdir():
                try:
                    target = os.readlink(fd)
                    if target.startswith(root):
                        info = (proc / 'fdinfo' / fd.name).read_text()
                        match = re.search(r'^flags:\s+(\d+)', info, re.M)
                        require(match is not None, 'source_writer_census_denied')
                        assert match is not None
                        flags = int(match[1], 8)
                        require((flags & os.O_ACCMODE) == os.O_RDONLY, 'source_has_writers')
                except FileNotFoundError:
                    continue
        except FileNotFoundError:
            continue
        except PermissionError:
            # Dumpability can hide same-UID systemd FDs even from a container
            # with SYS_PTRACE. Kernel read leases test the FILE, not /proc: a
            # read lease is refused while any other process has it open writable.
            # No contents are read and every lease is released immediately.
            for path, _, metadata, link in files(Path(source)):
                if link or not stat.S_ISREG(metadata.st_mode):
                    continue
                fd = None
                try:
                    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
                    fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_RDLCK)
                    fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
                except BlockingIOError:
                    raise ImportFailure('source_has_writers') from None
                except OSError:
                    raise ImportFailure('source_writer_census_denied') from None
                finally:
                    if fd is not None:
                        os.close(fd)
            return


def approve(plan):
    plan['approved'] = True
    plan['approval'] = approval_hash(plan)
    return plan


def source_identity(plan):
    if plan['source_kind'] == 'archive':
        return {'sha256': file_hash(plan['source'])}
    p = Path(plan['source'])
    require(not p.is_symlink(), 'source_symlink')
    identity = plan['source_identity']
    return {'device': p.stat().st_dev, 'inode': p.stat().st_ino,
            'critical': {r: file_hash(p / r) if (p / r).is_file() else None for r in identity['critical']}}


def lifecycle_lock(function):
    """Serialize apply/undo against the same owner registry, including crash recovery."""
    import functools
    @functools.wraps(function)
    def locked(*args, **kwargs):
        if function.__name__ == 'apply':
            root = Path(args[2] if len(args) > 2 else kwargs['wizard_home']).absolute()
        else:
            path = Path(args[0] if args else kwargs['journal_path']).absolute()
            root = path.parent.parent.parent if path.parent.parent.name in {'agents', 'imports'} else path.parent.parent
        require(not root.is_symlink(), 'wizard_home_symlink')
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        assert_owner(root)
        fd = os.open(root / '.hermes-import.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ImportFailure('import_busy') from None
            return function(*args, **kwargs)
        finally:
            os.close(fd)
    return locked


@lifecycle_lock
def apply(plan, agent_id, wizard_home, *, runtime_factory=DockerRuntime, allow_source_stop=False):
    if runtime_factory is DockerRuntime:
        import restricted_import
        return restricted_import.apply(SimpleNamespace(**globals()), plan, agent_id, wizard_home, allow_source_stop=allow_source_stop)
    started = time.monotonic()
    wizard_home = Path(wizard_home).absolute()
    require(ID_RE.fullmatch(agent_id) and agent_id not in {'hermes', 'main', 'default', 'options', 'new'}, 'agent_id')
    validate_plan(plan, wizard_home)
    source = Path(plan['source'])
    assert_owner(source)
    require(source_identity(plan) == plan['source_identity'], 'source_changed_rescan')
    directory = wizard_home / 'agents' / agent_id
    require(not directory.exists() and not directory.is_symlink(), 'agent_exists')
    require(not source.is_relative_to(wizard_home) and not wizard_home.is_relative_to(source), 'source_target_overlap')
    require(source != Path(plan['owner_home']) and source not in Path(plan['owner_home']).parents, 'source_is_owner_home')
    require(not directory.parent.is_symlink(), 'agent_registry_symlink')
    runtime = runtime_factory(plan, directory, agent_id)
    if hasattr(runtime, 'preflight'):
        runtime.preflight()
    directory.mkdir(parents=True, mode=0o700)
    # All journal data is outside home, inaccessible to the agent. Persist intent BEFORE effects.
    journal = {'schema': SCHEMA, 'id': agent_id, 'plan': plan, 'state': 'preparing', 'moved': False,
               'quarantined': [], 'backups': [], 'managed_absent': [], 'assets_added': [], 'services_active': [], 'settings_before': None,
               'settings_after_hash': None, 'source': str(source), 'home_inode': None}
    journal_path = directory / 'import-journal.json'
    dump(journal_path, journal)
    runtime = runtime_factory(plan, directory, agent_id)
    try:
        if plan['move']:
            require(source.stat().st_dev == directory.stat().st_dev, 'move_cross_filesystem')
            for unit in plan.get('source_units', []):
                require(re.fullmatch(r'hermes[-a-z0-9]*\.service', unit) is not None, 'source_unit_invalid')
                require(allow_source_stop, 'source_stop_requires_explicit_authority')
                status = subprocess.run(['systemctl', '--user', 'is-active', unit], capture_output=True, text=True)
                if status.returncode == 0:
                    journal['services_active'].append(unit)
                    dump(journal_path, journal)
                    run(['systemctl', '--user', 'stop', unit])
            assert_no_writers(source)
            journal['state'] = 'moving'
            journal['home_inode'] = source.stat().st_ino
            dump(journal_path, journal)
            source.rename(directory / 'home')
            journal['moved'] = True
            dump(journal_path, journal)
            # Explicit pointer, NOT a symlink (old launchers must not follow into the new live home).
            source.mkdir(mode=0o700)
            dump(source / 'WIZARD-IMPORTED.json', {'agent': agent_id, 'journal': str(journal_path)})
        else:
            (directory / 'home').mkdir(mode=0o700)
            safe_zip = directory / 'transport.zip'
            entries = archive_entries(source)
            require(shutil.disk_usage(directory).free > sum(n for _, _, n in entries) * 3 + 256 * 1024**2, 'disk_reserve')
            with zipfile.ZipFile(source) as z, zipfile.ZipFile(safe_zip, 'w', compression=zipfile.ZIP_DEFLATED) as out:
                for name, rel, _ in entries:
                    if not excluded(rel):
                        with z.open(name) as src, out.open(rel, 'w') as dst:
                            shutil.copyfileobj(src, dst, 1024**2)
            runtime.import_archive(safe_zip)
            safe_zip.unlink()
        home = directory / 'home'
        originals = directory / 'originals'
        originals.mkdir(mode=0o700)
        for name in ['config.yaml', '.env', 'cron/jobs.json']:
            p = managed_path(home, name)
            if not p.exists():
                journal['managed_absent'].append(name)
                dump(journal_path, journal)
            else:
                require(p.is_file() and not p.is_symlink(), 'managed_file_not_regular')
                journal['backups'].append(name)
                dump(journal_path, journal)
                q = originals / name
                q.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                atomic_backup(p, q)
        # Remove every machine-specific/bootstrap input from the future runtime; rename, not copy.
        quarantine = directory / 'quarantine'
        quarantine.mkdir(mode=0o700)
        candidates = [p for p in home.iterdir() if p.name in LOCAL | RUNTIME_NAMES | {'hooks', 'profiles', 'gateway.json'} or p.is_symlink()
                      or (p.is_file() and excluded(p.name) and not p.name.endswith(('-wal', '-shm', '-journal')))]
        if (home / 'data/apps').exists():
            candidates.append(home / 'data/apps')  # App data is a Wizard package, not an agent package.
        plugin_dir = home / 'plugins'
        if plugin_dir.is_dir() and not plugin_dir.is_symlink():
            candidates += [p for p in plugin_dir.iterdir() if p.name not in plan.get('approved_plugins', [])]
        skill_dir = home / 'skills'
        if skill_dir.is_dir() and not skill_dir.is_symlink():
            candidates += [p for p in skill_dir.iterdir() if p.name.startswith('wizard')]
        for p in candidates:
            rel = p.relative_to(home).as_posix()
            journal['quarantined'].append(rel)
            dump(journal_path, journal)
            q = quarantine / rel
            q.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            p.rename(q)
        api_key, gateway_key = secrets.token_hex(32), secrets.token_hex(32)
        for name, value in [('runtime.key', api_key), ('gateway.key', gateway_key)]:
            p = directory / name
            p.write_text(value + '\n')
            p.chmod(0o600)
        sanitize_credentials(home, plan, directory, journal, journal_path)
        wire(home, plan, api_key, gateway_key)
        for item in plan['dependencies']:
            if item.get('approved') and item.get('action', item['proposal']) == 'carry secret':
                src = Path(item.get('credential_source', item['path']))
                require(src.is_relative_to(plan['owner_home']), 'credential_outside_owner_home')
                dest = directory / 'credentials' / digest(item['path'])
                dest.parent.mkdir(mode=0o700, exist_ok=True)
                if src.is_dir():
                    require(not any(p.is_symlink() for p in src.rglob('*')), 'credential_symlink')
                    members = sorted(p.relative_to(src).as_posix() for p in src.rglob('*') if p.is_file())
                    require(members == sorted(item.get('approved_files', [])), 'credential_files_require_individual_review')
                    shutil.copytree(src, dest)
                else:
                    require(not src.is_symlink(), 'credential_symlink')
                    shutil.copy2(src, dest)
                if dest.is_file():
                    dest.chmod(0o600)
        for asset in plan.get('wizard_assets', []):
            dest = home / asset['kind'] / asset['name']
            journal['assets_added'].append(dest.relative_to(home).as_posix())
            dump(journal_path, journal)
            dest.mkdir(parents=True, mode=0o700)
            with zipfile.ZipFile(asset['archive']) as z:
                for n, rel, _ in archive_entries(asset['archive']):
                    if rel != 'config.yaml':
                        p = dest / rel
                        p.parent.mkdir(parents=True, exist_ok=True)
                        p.write_bytes(z.read(n))
        cfg = load_yaml((home / 'config.yaml').read_text())
        model = cfg.get('model') or {}
        require(isinstance(model, dict) and isinstance(model.get('default', ''), str), 'model_invalid')
        record = {'schema': 1, 'id': agent_id, 'label': agent_id.replace('-', ' ').title(), 'harness': 'hermes',
                  'imported': {'schema': 1, 'format': 'hermes'},
                  'privacy': 'standard', 'appearance': {'glyph': 'spark', 'hue': 265},
                  'model': {'provider': model.get('provider', 'openai-codex'), 'model': model.get('default', ''),
                            'allowed_models': [model.get('default', '')], 'fallback': False},
                  'permissions': {'preset': 'standard', 'outside_tools': plan.get('outside_tools', []), 'files': 'own', 'wizard_apps': [], 'agent_apps': [], 'other_agents': 'none'},
                  'runtime': {'kind': 'container', 'app_id': 'agent-' + agent_id, 'api': 'http://agent-' + agent_id + ':8642', 'port': plan['port']},
                  'created_at': int(time.time())}
        journal['state'] = 'starting'
        dump(journal_path, journal)
        runtime.start()
        runtime.healthy(api_key)
        # Publish only a healthy, sanitized target. Service's existing registry discovers it without restart.
        dump(directory / 'agent.json', record)
        dump(directory / 'runtime-state.json', {'desired': 'running', 'started_at': int(time.time() * 1000)})
        journal['state'] = 'applied'
        journal['apply_seconds'] = round(time.monotonic() - started, 3)
        dump(journal_path, journal)
        return {'id': agent_id, 'journal': str(journal_path), 'apply_seconds': journal['apply_seconds']}
    except Exception:
        journal['state'] = 'failed'
        dump(journal_path, journal)
        # Keep evidence and reversible state; explicit undo is safe after every recorded intent.
        with contextlib.suppress(Exception):
            runtime.remove()
        raise


@lifecycle_lock
def imported_lifecycle(journal_path, action, *, runtime_factory=DockerRuntime):
    """Host helper lifecycle without regenerating imported memory/settings/auth."""
    require(action in {'start', 'stop', 'apply'}, 'import_lifecycle_action')
    path = Path(journal_path).absolute()
    assert_owner(path)
    journal = json.loads(path.read_text())
    if runtime_factory is DockerRuntime:
        require(journal.get('restricted_import'), 'unrestricted_import_lifecycle_disabled')
        import restricted_import
        return restricted_import.lifecycle(SimpleNamespace(**globals()), path, action)
    require(journal['state'] == 'applied', 'import_not_applied')
    directory = path.parent
    record = json.loads((directory / 'agent.json').read_text())
    require(record.get('imported') == {'schema': 1, 'format': 'hermes'} and record['id'] == journal['id'], 'import_record_invalid')
    runtime = runtime_factory(journal['plan'], directory, journal['id'])
    runtime.remove()
    if action == 'stop':
        dump(directory / 'runtime-state.json', {'desired': 'stopped'})
        return {'ok': True, 'status': 'stopped'}
    plan = dict(journal['plan'])
    plan['outside_tools'] = record['permissions']['outside_tools']
    home = directory / 'home'
    cfg = load_yaml(managed_path(home, 'config.yaml').read_text())
    cfg.setdefault('model', {}).update(provider=record['model']['provider'], default=record['model']['model'])
    cfg.setdefault('agent', {})['disabled_toolsets'] = [v for v in cfg.get('agent', {}).get('disabled_toolsets', []) if v not in OUTSIDE_TOOLS + ['file', 'terminal', 'code_execution']]
    if record['permissions']['files'] == 'none':
        cfg['agent']['disabled_toolsets'] += ['file', 'terminal', 'code_execution']
    (home / 'config.yaml').write_text(yaml.safe_dump(cfg))
    api_key = (directory / 'runtime.key').read_text().strip()
    wire(home, plan, api_key, (directory / 'gateway.key').read_text().strip())
    runtime.start()
    runtime.healthy(api_key)
    dump(directory / 'runtime-state.json', {'desired': 'running', 'started_at': int(time.time() * 1000)})
    return {'ok': True, 'status': 'running'}


@lifecycle_lock
def route_default(journal_path, *, acknowledge_cutover=False):
    """Explicit owner cutover ONLY. Never called by apply or a rehearsal."""
    require(acknowledge_cutover, 'cutover_acknowledgement_required')
    path = Path(journal_path).absolute()
    assert_owner(path)
    journal = json.loads(path.read_text())
    require(journal['state'] == 'applied' and journal['plan']['mode'] == 'take-over', 'cutover_requires_takeover')
    require(not journal.get('settings_after_value_hash'), 'cutover_already_journalled')
    root = path.parent.parent.parent
    settings = root / 'settings.json'
    main = root / 'agents/.main-agent.json'
    previous = json.loads(settings.read_text()) if settings.exists() else {}
    previous_main = json.loads(main.read_text()) if main.exists() else None
    updated = json.loads(json.dumps(previous))
    updated.setdefault('agents', {})['default_agent_id'] = journal['id']
    recovery = {**(previous_main or {}), 'role': 'recovery'}
    journal.update(settings_before=previous, settings_existed=settings.exists(), main_before=previous_main,
                   settings_after_value_hash=digest(updated), main_after_value_hash=digest(recovery))
    dump(path, journal)  # Intent and snapshots precede both routing writes.
    dump(main, recovery)
    dump(settings, updated)
    require(json.loads(settings.read_text())['agents']['default_agent_id'] == journal['id']
            and json.loads(main.read_text())['role'] == 'recovery', 'cutover_readback_failed')
    return {'default_agent_id': journal['id'], 'previous_agent_role': 'recovery'}


@lifecycle_lock
def undo(journal_path, *, runtime_factory=DockerRuntime):
    started = time.monotonic()
    path = Path(journal_path).absolute()
    assert_owner(path)
    journal = json.loads(path.read_text())
    if runtime_factory is DockerRuntime and journal.get('restricted_import'):
        import restricted_import
        return restricted_import.undo(SimpleNamespace(**globals()), path)
    require(journal.get('schema') == SCHEMA and ID_RE.fullmatch(journal['id']), 'journal_invalid')
    directory = path.parent
    if journal['state'] == 'undone':
        require(directory.name == 'imports', 'journal_location')
        return {'id': journal['id'], 'state': 'undone', 'undo_seconds': journal.get('undo_seconds'), 'journal': str(path)}
    require(directory.name == journal['id'] and path.name == 'import-journal.json', 'journal_location')
    settings = directory.parent.parent / 'settings.json'
    main = directory.parent / '.main-agent.json'
    if journal.get('settings_after_value_hash'):
        current = json.loads(settings.read_text()) if settings.exists() else {}
        current_main = json.loads(main.read_text()) if main.exists() else None
        require(digest(current) in {journal['settings_after_value_hash'], digest(journal['settings_before'])}, 'settings_changed_since_cutover')
        require(digest(current_main) in {journal['main_after_value_hash'], digest(journal['main_before'])}, 'recovery_changed_since_cutover')
    validate_backups(directory, journal)  # fail before any record/assets/originals are changed
    runtime = runtime_factory(journal['plan'], directory, journal['id'])
    runtime.remove()  # Stop before restoring anything; failures leave the journal recoverable.
    (directory / 'agent.json').unlink(missing_ok=True)
    home = directory / 'home'
    source = Path(journal['source'])
    # Reconcile the crash window after rename but before the moved flag.
    moved = journal['moved'] or (journal.get('home_inode') and home.exists() and home.stat().st_ino == journal['home_inode'])
    if moved and home.exists():
        for rel in journal.get('assets_added', []):
            dest = home_path(home, rel)
            if dest.is_dir() and not dest.is_symlink():
                shutil.rmtree(dest)
            else:
                dest.unlink(missing_ok=True)
        for rel in journal.get('managed_absent', []):
            managed_path(home, rel).unlink(missing_ok=True)
        for name in journal['backups']:
            original = directory / 'originals' / name
            if original.exists():
                dest = managed_path(home, name)
                shutil.copy2(original, dest)
        for rel in reversed(journal['quarantined']):
            original = directory / 'quarantine' / rel
            if original.exists() or original.is_symlink():
                dest = home_path(home, rel)
                if dest.is_dir() and not dest.is_symlink():
                    shutil.rmtree(dest)
                else:
                    dest.unlink(missing_ok=True)
                original.rename(dest)
        if source.exists():
            require(not source.is_symlink(), 'source_pointer_changed')
            entries = list(source.iterdir())
            require(not entries or (len(entries) == 1 and entries[0].name == 'WIZARD-IMPORTED.json'
                    and json.loads(entries[0].read_text()).get('journal') == str(path)), 'source_pointer_changed')
            for e in entries:
                e.unlink()
            source.rmdir()
        home.rename(source)
    elif moved:
        require(source.exists() and source.stat().st_ino == journal['home_inode'], 'undo_home_missing')
    if journal.get('settings_after_value_hash'):
        if journal.get('settings_existed'):
            dump(settings, journal['settings_before'])
        else:
            settings.unlink(missing_ok=True)
        if journal['main_before'] is None:
            main.unlink(missing_ok=True)
        else:
            dump(main, journal['main_before'])
    for unit in journal.get('services_active', []):
        run(['systemctl', '--user', 'start', unit])
    # No archive, credentials, old record or imported home retained in the registered agent directory.
    for name in ['home', 'credentials', 'originals', 'quarantine', 'runtime-identity']:
        p = directory / name
        if p.exists():
            shutil.rmtree(p)
    for name in ['runtime.key', 'gateway.key', 'runtime-state.json', 'transport.zip']:
        (directory / name).unlink(missing_ok=True)
    journal['state'] = 'undone'
    journal['undo_seconds'] = round(time.monotonic() - started, 3)
    dump(path, journal)
    # Keep the non-secret journal outside the agent registry, not an orphan agent record/folder.
    dest = directory.parent.parent / 'imports' / (journal['id'] + '-' + secrets.token_hex(4) + '.json')
    dest.parent.mkdir(mode=0o700, exist_ok=True)
    os.replace(path, dest)
    directory.rmdir()
    return {'id': journal['id'], 'state': 'undone', 'undo_seconds': journal['undo_seconds'], 'journal': str(dest)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    refresh = commands.add_parser('refresh-managed')
    refresh.add_argument('directory')
    p = commands.add_parser('scan')
    p.add_argument('source')
    p.add_argument('--owner-home')
    p.add_argument('--out', required=True)
    p = commands.add_parser('approve')
    p.add_argument('plan')
    p = commands.add_parser('apply')
    p.add_argument('plan')
    p.add_argument('--id', required=True)
    p.add_argument('--wizard-home', default=os.environ.get('WIZARD_OS_HOME', str(Path.home() / '.wizard-os')))
    p.add_argument('--allow-source-stop', action='store_true')
    p = commands.add_parser('lifecycle', help='host runtime helper only')
    p.add_argument('journal')
    p.add_argument('action', choices=['start', 'stop', 'apply'])
    p = commands.add_parser('route-default', help='OWNER CUTOVER ONLY; never part of apply')
    p.add_argument('journal')
    p.add_argument('--acknowledge-cutover', action='store_true', required=True)
    p = commands.add_parser('undo')
    p.add_argument('journal')
    args = parser.parse_args(argv)
    try:
        if args.command == 'refresh-managed':
            folder = Path(args.directory)
            change = json.loads((folder / 'import-update.json').read_text())
            cfg = load_yaml((folder / 'managed/config.yaml').read_text())
            model = change['model']
            cfg.setdefault('model', {}).update(default=model['model'], provider=model['provider'])
            if 'model_id' in cfg['model']:
                cfg['model']['model_id'] = model['model']
            cfg['model'].pop('api_key', None)
            cfg['model'].pop('base_url', None)
            cfg.setdefault('terminal', {})['backend'] = 'local'
            # Preserve memory plugins and custom tools; only known outside-tool
            # grants are controlled by this owner permission contract.
            grants = set(change['permissions']['outside_tools'])
            tools = cfg.setdefault('toolsets', {}).get('api_server', [])
            outside = {'web', 'search', 'browser', 'x_search', 'vision', 'video', 'image_gen', 'video_gen', 'tts', 'delegation', 'connections', 'homeassistant', 'spotify'}
            files = {'file', 'terminal', 'code_execution'}
            cfg['toolsets']['api_server'] = [t for t in tools if (t not in outside or t in grants) and (t not in files or change['permissions']['files'] != 'none')]
            (folder / 'managed/config.yaml').write_text(yaml.safe_dump(cfg, sort_keys=False))
            result = {'updated': True}
        elif args.command == 'scan':
            plan = scan(args.source, owner_home=args.owner_home)
            dump(args.out, plan)
            print(json.dumps({'plan': args.out, 'summary': plan['summary'], 'dependency_count': len(plan['dependencies'])}, indent=2))
        elif args.command == 'approve':
            path = Path(args.plan)
            assert_owner(path)
            plan = approve(json.loads(path.read_text()))
            # Approval is deliberate CLI action, not a flag silently selecting every proposal.
            dump(path, plan)
            print(json.dumps({'approval': plan['approval']}))
        elif args.command == 'apply':
            print(json.dumps(apply(json.loads(Path(args.plan).read_text()), args.id, args.wizard_home, allow_source_stop=args.allow_source_stop)))
        elif args.command == 'lifecycle':
            print(json.dumps(imported_lifecycle(args.journal, args.action)))
        elif args.command == 'route-default':
            print(json.dumps(route_default(args.journal, acknowledge_cutover=args.acknowledge_cutover)))
        else:
            print(json.dumps(undo(args.journal)))
        return 0
    except (ImportFailure, ValueError, OSError, sqlite3.Error, zipfile.BadZipFile) as exc:
        print(json.dumps({'error': str(exc) if isinstance(exc, ImportFailure) else 'import_io_or_format_error'}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
