#!/usr/bin/env python3
"""Owner-only preparation of a host recovery Hermes; never starts/stops live services.

Invoked by `wizard agent import hermes recovery-home`. State and code are separate
siblings of the source home, not a named profile inside the tree being moved.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import urllib.request

import yaml

SKILLS = ('hermes-agent', 'wizard-live-updates', 'hermes-remote-operations')
PROVIDER_ENV = {
    'anthropic': ('ANTHROPIC_API_KEY', 'ANTHROPIC_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'),
    'openai-codex': (), 'openai': ('OPENAI_API_KEY',),
    'openrouter': ('OPENROUTER_API_KEY',), 'nous': ('NOUS_API_KEY',),
}
SOUL = '''# Archimedes — System Recovery

You are old Archimedes: James's deliberately opened host recovery and maintenance
agent, not his everyday assistant. The everyday Archimedes lives in a Wizard
agent container. Your separate home and code remain on the VPS host.

Use the local terminal to inspect and repair Docker containers, host files and
user systemd services when James asks. You have the owner's normal host shell,
Docker and systemctl access, not new root privileges. Never change provider to
work around a sign-in problem. Explain the failure and repair the same sign-in.

Do not run scheduled work, connect messaging platforms, accept app bindings or
become the default agent. No cron, autonomous monitoring or automatic updates.
Open on purpose, diagnose first, preserve rollback, and obtain permission for
consequential/disruptive maintenance. Do not silently restart the main agent or
Agent Service. Load the included maintenance skill before changing Wizard/Hermes.
'''


class RecoveryError(RuntimeError):
    pass


def need(ok, code):
    if not ok:
        raise RecoveryError(code)


def regular(path, limit=4 * 1024 * 1024):
    s = path.lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size <= limit, 'unsafe_source_file')
    return path.read_text()


def safe_path(path):
    path = Path(path).expanduser().absolute()
    need(not any(p.is_symlink() for p in (path, *path.parents)), 'symlink_path')
    return path.resolve()


def private_write(path, text, mode=0o600):
    with path.open('x', encoding='utf-8') as f:
        os.fchmod(f.fileno(), mode)
        f.write(text)


def run(argv, **kwargs):
    # Command output may contain package indexes/credential diagnostics; keep it
    # in the owner's private runtime, never in the public JSON receipt.
    result = subprocess.run(argv, capture_output=True, text=True, **kwargs)
    need(result.returncode == 0, 'runtime_command_failed:' + Path(argv[0]).name)
    return result.stdout.strip()


def skill_sources(source):
    root = source / 'skills'
    need(root.is_dir() and not root.is_symlink(), 'skills_missing')
    found = {}
    for path in root.rglob('SKILL.md'):
        if path.parent.name in SKILLS:
            name = path.parent.name
            need(name not in found, 'ambiguous_skill:' + name)
            for node in (path.parent, *path.parent.rglob('*')):
                need(not node.is_symlink(), 'skill_symlink')
                if node.is_file():
                    regular(node, 10 * 1024 * 1024)
            found[name] = path.parent
    need(set(found) == set(SKILLS), 'required_skills_missing')
    return found


def credentials(source, provider):
    """Copy only the selected provider, never bot tokens, other pools or MCP.

    Borrowed Claude Code credentials deliberately remain in the shared host CLI
    store OUTSIDE HERMES_HOME; Hermes serializes refresh there across profiles.
    Copying that single-use refresh grant would instead create a rotation race.
    """
    need(provider in PROVIDER_ENV, 'provider_requires_explicit_credential_support')
    auth_path = source / 'auth.json'
    auth = json.loads(regular(auth_path)) if auth_path.exists() else {}
    selected = {'version': auth.get('version', 1), 'active_provider': provider,
                'providers': {}, 'credential_pool': {}}
    for key in ('providers', 'credential_pool'):
        if isinstance(auth.get(key), dict) and provider in auth[key]:
            selected[key][provider] = auth[key][provider]
    # Parse, don't shell-source the source .env. Do not expand $HOME or ${SECRET}.
    from dotenv import dotenv_values
    dotenv = source / '.env'
    env = dotenv_values(stream=__import__('io').StringIO(regular(dotenv)), interpolate=False) if dotenv.exists() else {}
    selected_env = {name: env[name] for name in PROVIDER_ENV[provider] if env.get(name)}
    singleton = source / '.anthropic_oauth.json'
    singleton_text = regular(singleton) if provider == 'anthropic' and singleton.exists() else None
    need(bool(selected_env or selected['providers'] or selected['credential_pool'] or singleton_text), 'selected_provider_credentials_missing')
    return selected, selected_env, singleton_text


def snapshot_runtime(install, runtime):
    """Independent tracked code + independently installed pinned dependencies.

    Never retain the source .venv, editable .pth or its bin/hermes shebang. The
    interpreter itself must live outside the moved source installation.
    """
    revision = run(['git', '-C', str(install), 'rev-parse', 'HEAD'])
    need(re.fullmatch(r'[0-9a-f]{40}', revision), 'invalid_revision')
    need(not run(['git', '-C', str(install), 'status', '--porcelain', '--untracked-files=no']), 'dirty_hermes_install')
    python = install / '.venv/bin/python'
    need(python.is_file(), 'source_python_missing')
    actual_python = python.resolve()
    need(not actual_python.is_relative_to(install), 'interpreter_would_move')
    dependencies = json.loads(run([str(python), '-I', '-c',
        'import importlib.metadata as m,json; print(json.dumps(sorted(d.metadata["Name"]+"=="+d.version for d in m.distributions() if d.metadata["Name"].lower().replace("_","-") != "hermes-agent")))']))
    need(all(re.fullmatch(r'[A-Za-z0-9_.-]+==[A-Za-z0-9_.+!-]+', d) for d in dependencies), 'invalid_dependency_pin')
    code = runtime / 'code'
    code.mkdir(mode=0o700)
    archive = runtime / 'source.tar'
    with archive.open('wb') as f:
        subprocess.run(['git', '-C', str(install), 'archive', revision], stdout=f, check=True)
    with tarfile.open(archive) as tar:
        tar.extractall(code, filter='data')
    archive.unlink()
    private_write(runtime / 'requirements.txt', '\n'.join(dependencies) + '\n')
    run(['uv', 'venv', '--python', str(actual_python), str(runtime / 'venv')])
    new_python = runtime / 'venv/bin/python'
    run(['uv', 'pip', 'install', '--python', str(new_python), '--only-binary', ':all:', '-r', str(runtime / 'requirements.txt')])
    run(['uv', 'pip', 'install', '--python', str(new_python), '--no-deps', '--no-build-isolation', '-e', str(code)])
    return revision


def prepare(source, destination, runtime, *, install=None, port=8867, acknowledge_host_access=False,
            runtime_builder=snapshot_runtime):
    need(acknowledge_host_access, 'host_access_acknowledgement_required')
    source, destination, runtime = map(safe_path, (source, destination, runtime))
    install = safe_path(install or source / 'hermes-agent')
    for path in (destination, runtime):
        need(not path.exists(), 'recovery_target_exists')
        need(not path.is_relative_to(source) and not source.is_relative_to(path), 'recovery_must_survive_move')
        need(not path.is_relative_to(install) and not install.is_relative_to(path), 'runtime_overlaps_install')
    need(not destination.is_relative_to(runtime) and not runtime.is_relative_to(destination), 'recovery_targets_overlap')
    wizard = safe_path(os.environ.get('WIZARD_OS_HOME', str(Path.home() / '.wizard-os')))
    need(not destination.is_relative_to(wizard / 'agents') and not runtime.is_relative_to(wizard / 'agents'), 'recovery_is_host_only')
    need(isinstance(port, int) and 1024 <= port <= 65535, 'invalid_recovery_port')
    with socket.socket() as s:
        try:
            s.bind(('127.0.0.1', port))
        except OSError:
            raise RecoveryError('recovery_port_in_use') from None
    config_bytes = regular(source / 'config.yaml')
    cfg = yaml.safe_load(config_bytes)
    model = cfg.get('model')
    need(isinstance(model, dict) and model.get('provider') and model.get('default'), 'explicit_source_model_required')
    provider = model['provider']
    if runtime_builder is snapshot_runtime:
        need(not (install / '.venv/bin/python').resolve().is_relative_to(source), 'interpreter_would_move')
    auth, env, singleton = credentials(source, provider)
    skills = skill_sources(source)
    # Construct from an allowlist, not a sanitised copy of the daily home.
    config = {'model': model, 'fallback_model': None, 'fallback_providers': [],
              'terminal': {'backend': 'local', 'cwd': str(Path.home())},
              'platform_toolsets': {'api_server': ['terminal', 'file', 'skills', 'web']},
              'memory': {'provider': 'none'}, 'mcp_servers': {},
              'plugins': {'enabled': [], 'auto_update': False},
              'gateway': {'platforms': {}, 'api_server': {'max_concurrent_runs': 1}},
              'cron': {'allow_agent_scheduling': False},
              'agent': {'max_iterations': 50, 'disabled_toolsets': ['cronjob', 'delegation']}}
    key = secrets.token_hex(32)
    created = []
    try:
        destination.mkdir(parents=True, mode=0o700)
        created.append(destination)
        runtime.mkdir(parents=True, mode=0o700)
        created.append(runtime)
        private_write(destination / 'config.yaml', yaml.safe_dump(config, sort_keys=False))
        private_write(destination / 'SOUL.md', SOUL)
        private_write(destination / 'auth.json', json.dumps(auth))
        if singleton:
            private_write(destination / '.anthropic_oauth.json', singleton)
        env['API_SERVER_KEY'] = key
        private_write(destination / '.env', '\n'.join(k + '=' + json.dumps(v, ensure_ascii=False) for k, v in env.items()) + '\n')
        (destination / 'skills').mkdir(mode=0o700)
        for name, path in skills.items():
            shutil.copytree(path, destination / 'skills' / name)
        revision = runtime_builder(install, runtime)
        shutil.copyfile(Path(__file__).with_name('recovery_listener.py'), runtime / 'listener.py')
        # A launcher starts with an environment allowlist: a bot token or
        # HERMES_HOME inherited from the owner shell cannot escape into recovery.
        manifest = {'schema': 1, 'home': str(destination), 'runtime': str(runtime),
                    'owner_home': str(Path.home()), 'port': port, 'provider': provider,
                    'model': model['default'], 'revision': revision, 'skills': list(SKILLS),
                    'source_config_sha256': hashlib.sha256(config_bytes.encode()).hexdigest()}
        private_write(runtime / 'recovery.json', json.dumps(manifest, indent=2) + '\n')
        private_write(runtime / 'agent-service.env',
                      f'HERMES_ORIGIN=http://127.0.0.1:{port}\nWIZARD_HERMES_API_KEY={key}\n')
        # Render only. The owner chooses a unit filename and installs/enables it
        # during cutover, not while preparing/rehearsing.
        def sq(text):
            need(not any(c in str(text) for c in '\n\r\x00'), 'unsafe_unit_path')
            return '"' + str(text).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'
        private_write(runtime / 'recovery.service',
            '[Unit]\nDescription=Wizard explicit host recovery Hermes\nAfter=network-online.target\n\n'
            '[Service]\nType=simple\nUMask=0077\n'
            f'ExecStart={sq(runtime / "venv/bin/python")} {sq(runtime / "listener.py")} {sq(runtime / "recovery.json")}\n'
            'Restart=on-failure\nRestartSec=10\nTimeoutStopSec=60\n\n[Install]\nWantedBy=default.target\n')
        need(hashlib.sha256(regular(source / 'config.yaml').encode()).hexdigest() == manifest['source_config_sha256'], 'source_config_changed')
        return manifest
    except BaseException:
        # No unit/registry was installed, so cleanup is limited to our new paths.
        for path in reversed(created):
            shutil.rmtree(path, ignore_errors=True)
        raise


def probe(runtime):
    runtime = safe_path(runtime)
    manifest = json.loads(regular(runtime / 'recovery.json'))
    from dotenv import dotenv_values
    key = dotenv_values(Path(manifest['home']) / '.env', interpolate=False)['API_SERVER_KEY']
    need(isinstance(key, str) and len(key) >= 32, 'recovery_key_missing')
    request = urllib.request.Request(f'http://127.0.0.1:{manifest["port"]}/api/sessions', headers={'Authorization': 'Bearer ' + str(key)})
    with urllib.request.urlopen(request, timeout=10) as response:
        need(response.status == 200, 'recovery_probe_failed')
        json.load(response)
    return {'healthy': True, 'port': manifest['port'], 'provider': manifest['provider'], 'model': manifest['model']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('prepare')
    p.add_argument('--source', required=True)
    p.add_argument('--home', default=str(Path.home() / '.hermes-recovery'))
    p.add_argument('--runtime', default=str(Path.home() / '.local/share/wizard-recovery'))
    p.add_argument('--install')
    p.add_argument('--port', type=int, default=8867)
    p.add_argument('--acknowledge-host-access', action='store_true')
    p = commands.add_parser('probe')
    p.add_argument('--runtime', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'prepare':
            result = prepare(args.source, args.home, args.runtime, install=args.install, port=args.port,
                             acknowledge_host_access=args.acknowledge_host_access)
        else:
            result = probe(args.runtime)
        print(json.dumps(result))
    except (RecoveryError, OSError, ValueError, subprocess.SubprocessError) as exc:
        # Never print third-party exception text: it can embed credentials.
        print(json.dumps({'error': str(exc) if isinstance(exc, RecoveryError) else type(exc).__name__}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
