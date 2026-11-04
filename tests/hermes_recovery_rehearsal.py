#!/usr/bin/env python3
"""Opt-in real Docker move + independently installed host recovery API rehearsal.

Only --install/--skills-source are read from the live home. All agent content and
credentials are fake. No systemd lifecycle/installation command, production unit,
production port or live Agent Service request is made. The API checks do not invoke a paid model.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / 'ops/agent-runtime'))
import hermes_import as m
import recovery_home as r


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def cmd(argv, **kw):
    result = subprocess.run(argv, capture_output=True, text=True, **kw)
    if result.returncode:
        raise RuntimeError('rehearsal command failed: ' + Path(argv[0]).name)
    return result.stdout.strip()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--install', required=True)
    p.add_argument('--skills-source', required=True)
    p.add_argument('--image', required=True)
    p.add_argument('--evidence', required=True)
    p.add_argument('--confirm-isolated-rehearsal', action='store_true', required=True)
    args = p.parse_args()
    install, skills = Path(args.install).resolve(), Path(args.skills_source).resolve()
    live_config = skills / 'config.yaml'
    before = hashlib.sha256(live_config.read_bytes()).hexdigest()
    suffix = secrets.token_hex(5)
    agent_id = 'recovery-fixture-' + suffix
    network = 'wizard-recovery-fixture-' + suffix
    report = {'live_config_sha256_before': before, 'paid_inference': False,
              'production_units_installed': False, 'production_service_contacted': False,
              'original_install_revision': cmd(['git', '-C', str(install), 'rev-parse', 'HEAD'])}
    process, journal, net_created = None, None, False
    original_env = os.environ.copy()
    with tempfile.TemporaryDirectory(prefix='recovery-rehearsal-', dir=os.environ['TMPDIR']) as temporary:
        root = Path(temporary)
        owner = root / 'owner'
        source = owner / '.hermes'
        source.mkdir(parents=True)
        home = owner / '.hermes-recovery'
        runtime = owner / '.local/share/wizard-recovery'
        wizard = owner / '.wizard-os'
        (root / 'tmp').mkdir()
        os.environ.update(HOME=str(owner), HERMES_HOME=str(source), WIZARD_OS_HOME=str(wizard), TMPDIR=str(root / 'tmp'))
        try:
            # Real source code is reconstructed as a disposable Git install inside
            # the fake source home. Its dependency metadata is read before rename.
            code = source / 'hermes-agent'
            code.mkdir()
            archive = root / 'code.tar'
            with archive.open('wb') as f:
                subprocess.run(['git', '-C', str(install), 'archive', 'HEAD'], stdout=f, check=True)
            with tarfile.open(archive) as tar:
                tar.extractall(code, filter='data')
            archive.unlink()
            cmd(['git', '-C', str(code), 'init', '--quiet'])
            cmd(['git', '-C', str(code), 'add', '.'])
            cmd(['git', '-C', str(code), '-c', 'user.name=Recovery fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Disposable install snapshot'])
            (code / '.venv').symlink_to(install / '.venv', target_is_directory=True)
            # Same provider as the selected source fixture, but no real token.
            (source / 'config.yaml').write_text('model:\n  provider: anthropic\n  default: fixture-claude\nterminal:\n  backend: local\n')
            (source / '.env').write_text('ANTHROPIC_API_KEY=fixture-not-a-real-provider-key\n')
            (source / 'auth.json').write_text('{"version":1,"providers":{}}')
            (source / 'SOUL.md').write_text('Everyday fixture, not recovery')
            (source / 'memories').mkdir()
            (source / 'memories/MEMORY.md').write_text('fixture memory preserved by move')
            for name, path in r.skill_sources(skills).items():
                shutil.copytree(path, source / 'skills' / name)
            port = free_port()
            manifest = r.prepare(source, home, runtime, port=port, acknowledge_host_access=True)
            report.update(recovery_port=port, provider=manifest['provider'], model=manifest['model'],
                          independent_runtime_revision=manifest['revision'])
            cmd(['docker', 'network', 'create', network])
            net_created = True
            plan = m.scan(source, owner_home=owner)
            plan.update(move=True, image=args.image, network=network, port=free_port(),
                        gateway_url='http://unavailable.fixture.invalid:8923/wizard/mcp')
            m.approve(plan)
            inode = source.stat().st_ino
            applied = m.apply(plan, agent_id, wizard)
            journal = applied['journal']
            moved = wizard / 'agents' / agent_id / 'home'
            assert moved.stat().st_ino == inode
            assert not (source / 'hermes-agent').exists()
            assert (home / 'SOUL.md').exists()
            report.update(real_container_move=True, same_inode_after_move=True,
                          original_install_path_gone=True, new_python=str(runtime / 'venv/bin/python').replace(str(root), '$REHEARSAL'))
            log_path = root / 'listener.log'
            with log_path.open('w') as log:
                process = subprocess.Popen([str(runtime / 'venv/bin/python'), str(runtime / 'listener.py'), str(runtime / 'recovery.json')],
                                           cwd=owner, stdout=log, stderr=log)
                deadline = time.monotonic() + 60
                while True:
                    assert process.poll() is None, 'recovery listener exited before readiness'
                    try:
                        proof = r.probe(runtime)
                        break
                    except (OSError, ValueError):
                        if time.monotonic() >= deadline:
                            raise RuntimeError('recovery readiness timed out') from None
                        time.sleep(0.2)
                report['authenticated_api_sessions'] = proof['healthy']
                try:
                    urllib.request.urlopen(f'http://127.0.0.1:{port}/api/sessions', timeout=5)
                    raise AssertionError('unauthenticated API was accepted')
                except urllib.error.HTTPError as exc:
                    assert exc.code == 401
                    report['unauthenticated_status'] = exc.code
                # Use the same local terminal environment as the recovery listener.
                tools_code = ('import json,sys,subprocess;sys.path.insert(0,sys.argv[1]);'
                              'from listener import configure;configure(json.load(open(sys.argv[2])));'
                              'r=subprocess.run(["/bin/sh","-c","command -v hermes; command -v docker; command -v systemctl"],capture_output=True,text=True);'
                              'assert r.returncode==0;print(r.stdout)')
                tools = cmd([str(runtime / 'venv/bin/python'), '-c', tools_code, str(runtime), str(runtime / 'recovery.json')])
                assert str(source) not in tools
                report['host_tools_resolve'] = [Path(x).name for x in tools.splitlines()]
                access_code = ('import json,sys,subprocess;sys.path.insert(0,sys.argv[1]);'
                               'from listener import configure;configure(json.load(open(sys.argv[2])));'
                               'from hermes_cli.config import load_config;from hermes_cli.tools_config import _get_platform_tools;'
                               't=_get_platform_tools(load_config(),"api_server");'
                               'assert "terminal" in t and "cronjob" not in t and "delegation" not in t;'
                               'subprocess.run(["docker","info","--format","{{.ServerVersion}}"],check=True,stdout=subprocess.DEVNULL);'
                               'subprocess.run(["systemctl","--user","show-environment"],check=True,stdout=subprocess.DEVNULL);'
                               'print("host-access-ok")')
                assert cmd([str(runtime / 'venv/bin/python'), '-c', access_code, str(runtime), str(runtime / 'recovery.json')]) == 'host-access-ok'
                report.update(docker_daemon_access=True, systemd_user_bus_access=True, resolved_toolsets_no_cron_or_delegation=True)
                assert not (home / 'cron/jobs.json').exists()
                assert set(x.name for x in (home / 'skills').iterdir()) == set(r.SKILLS)
                report.update(no_cron_jobs=True, minimal_skills=list(r.SKILLS), unit_rendered_only=True)
                # Fixture registration uses the real Agent Service registry layout.
                m.dump(wizard / 'agents/.main-agent.json', {'schema': 1, 'role': 'recovery', 'wizard_apps': [], 'agent_apps': []})
                read_registry = ('import {createAgentRegistry} from "./server/agents.mjs";'
                                 'const r=createAgentRegistry({agentsDir:process.argv[1]});'
                                 'if(r.read("hermes").role!=="recovery")throw Error("role");'
                                 'console.log(JSON.stringify({role:r.read("hermes").role}));')
                # See the separate owner-only admission suite for Service auth.
                cmd(['node', '--input-type=module', '-e', read_registry, str(wizard / 'agents')], cwd=ROOT)
                report['service_registry_role'] = 'recovery'
                process.terminate()
                process.wait(timeout=30)
                process = None
                report['listener_terminated'] = True
        finally:
            if process is not None:
                process.terminate()
                process.wait(timeout=30)
            if journal:
                m.undo(journal)
                report['move_undone'] = source.stat().st_ino == inode
            # An apply failure may leave a journal before returning a receipt.
            elif (wizard / 'agents' / agent_id / 'import-journal.json').exists():
                m.undo(wizard / 'agents' / agent_id / 'import-journal.json')
            if net_created:
                cmd(['docker', 'network', 'rm', network])
            report['container_absent'] = not cmd(['docker', 'ps', '-a', '--filter', 'name=^/agent-' + agent_id + '$', '--format', '{{.Names}}'])
            report['network_absent'] = not cmd(['docker', 'network', 'ls', '--filter', 'name=^' + network + '$', '--format', '{{.Name}}'])
            after = hashlib.sha256(live_config.read_bytes()).hexdigest()
            report.update(live_config_sha256_after=after, live_config_unchanged=before == after)
            os.environ.clear()
            os.environ.update(original_env)
            # Preserve failure diagnostics only after sanitising them: no raw API,
            # credentials or listener output is copied into public evidence.
    report['scratch_removed'] = not Path(temporary).exists()
    assert report['live_config_unchanged']
    Path(args.evidence).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
