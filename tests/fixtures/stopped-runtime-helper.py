"""Real runtime-helper actions with Docker/Runtipi mocked at their subprocess/API boundary.
Invoked only by round4-boundaries on disposable homes. Never connects to a daemon.
"""
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'ops' / 'agent-runtime'))
import agent_runtime as ar

root, agent_id, kind, action = sys.argv[1:]
agents = ar.Agents(Path(root), None)
agent = agents.read(agent_id)
agent['runtime']['isolation'] = 'restricted' if kind == 'restricted' else ''
driver_type = ar.RuntipiDriver if kind == 'runtipi' else ar.RestrictedDriver
driver = driver_type.__new__(driver_type)
driver.agents = agents
driver.home_mount = 'alongside'
state_path = agents.root / agent_id / 'fixture-lifecycle.json'
state = json.loads(state_path.read_text())

def stop(*args, **kwargs):
    state.update(status='stopped', container='absent' if kind == 'runtipi' else 'exited')
    state_path.write_text(json.dumps(state))
    return SimpleNamespace(returncode=0)

def docker(argv, **kwargs):
    if argv[0] == 'ps':
        return SimpleNamespace(stdout='' if state['container'] == 'absent' else 'fixture-cid')
    if argv[0] == 'inspect':
        return SimpleNamespace(stdout='\n'.join(map(json.dumps, ['fixture-cid', {
            'Status': state['container'], 'Running': state['container'] == 'running',
            'StartedAt': '2026-01-01T00:00:00Z', 'FinishedAt': '2026-01-01T01:00:00Z'}, 0])))
    if argv[0] == 'run':
        assert argv[argv.index('--network') + 1] == 'none'
        assert argv[argv.index('--user') + 1] == '10000:10000'
        assert '--read-only' in argv and argv[argv.index('--mount') + 1].endswith(',readonly')
        assert kwargs['timeout'] == 30
        # Emulate only the subprocess boundary on the fixture home. Execute the
        # exact sidecar program with no Docker; uid/mount flags asserted above.
        script = argv[argv.index('-c') + 1]
        return subprocess.run([sys.executable, '-c', script, str(agents.home(agent_id)), argv[-1]],
                              check=True, capture_output=True, text=True, timeout=30)
    raise AssertionError('unexpected Docker operation')

ar.docker = docker
driver._compose = stop
rt = SimpleNamespace(app=lambda urn: {'app': {'status': state['status']}}, req=stop,
                     wait_status=lambda *a, **kw: state['status'])
driver.cli = SimpleNamespace(Config=lambda: SimpleNamespace(runtipi=lambda: rt))
with ar.lifecycle_lock(driver, driver if kind == 'restricted' else None, agent_id):
    print(json.dumps(ar.lifecycle_action(driver, agent, action)))
