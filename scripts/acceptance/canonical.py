"""Real v0.22.1 authority + HTTP handlers behind candidate WAS, no model/owner data.
Run with HERMES_SOURCE pointing at an unmodified v0.22.1 checkout and its dependencies.
The exact upstream restart fixture claims a head then replaces authority AND adapter.
Only model execution is an in-process deterministic answer; no real reboot is claimed.
"""
import asyncio, json, os, sys, tempfile, subprocess
from pathlib import Path
source = Path(os.environ['HERMES_SOURCE']).resolve()
commit = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
if commit != '297552a9d646119871391d202509822cd86330df':
    raise SystemExit('Acceptance requires exact Hermes v0.22.1 commit, got ' + commit)
if subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain', '--untracked-files=no'], text=True).strip():
    raise SystemExit('Acceptance refuses a modified upstream checkout')
sys.path.insert(0, str(source))
import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from pytest import MonkeyPatch
from tests.gateway import test_api_unknown_resolution as upstream

async def main():
    root = Path(tempfile.mkdtemp(prefix='wizard-canonical-', dir=os.environ['TMPDIR']))
    patch = MonkeyPatch()
    # Same exact real adapter route handlers; include capabilities for WAS gating.
    def client_for(adapter):
        adapter._expected_api_key = lambda: 'checkpoint-two-api-key'
        app = web.Application()
        for method, path, handler in adapter._http_route_table():
            if path.startswith('/v1/runs') or path == '/v1/capabilities': app.router.add_route(method, path, handler)
        return TestClient(TestServer(app))
    patch.setattr(upstream, '_runs_client', client_for)
    client, adapters, store, owner, unknown, follower, executed, tasks = await upstream._restarted_api_runs(root, patch)
    proc = None
    checks = []
    try:
        was_home = root / 'was'; was_home.mkdir()
        env = dict(os.environ, ACCEPTANCE_HOME=str(was_home), ACCEPTANCE_UPSTREAM=str(client.make_url('')).rstrip('/'), ACCEPTANCE_SEED_RUN=unknown['request_id'])
        proc = await asyncio.create_subprocess_exec(os.environ.get('NODE', 'node'), str(Path(__file__).with_name('was-loopback.mjs')), env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        while True:
            line = await asyncio.wait_for(proc.stdout.readline(), 30)
            if not line: raise AssertionError((await proc.stderr.read()).decode())
            try: ready = json.loads(line)
            except ValueError: continue
            if ready.get('origin'): break
        async with aiohttp.ClientSession() as http:
            base = ready['origin'] + '/wizard/hermes'
            async def req(method, path, body=None, key=None):
                kwargs = {'json': body} if body is not None else {}
                if key: kwargs['headers'] = {'Idempotency-Key': key}
                async with http.request(method, base + path, **kwargs) as r: return r.status, await r.json()
            run_path = '/v1/runs/' + ready['seed_public_run']
            code, current = await req('GET', run_path)
            assert code == 200 and current['status'] == 'unknown', current
            assert current['admission_id'] == unknown['admission_id']
            checks.append('real restarted authority unknown projects through publicRunId')
            identity = {k: current[k] for k in ('admission_id', 'execution_generation')}
            code, bad = await req('POST', run_path+'/stop')
            assert code == 409 and bad['error']['code'] == 'unknown_execution', bad
            assert (await req('GET', run_path))[1]['status'] == 'unknown'
            checks.append('control409 preserves the admitted unknown head')
            code, bad = await req('POST', run_path+'/resolve-unknown', identity | {'execution_generation': identity['execution_generation'] + 1})
            assert code == 409 and bad['error']['code'] == 'stale_generation', bad
            checks.append('fresh GET rejects stale displayed generation')
            code, result = await req('POST', run_path+'/resolve-unknown', identity)
            assert code == 200 and result['outcome'] == 'interrupted', result
            await owner.sessions['api-session'].task
            assert executed == ['FOLLOWER'], executed
            code, repeat = await req('POST', run_path+'/resolve-unknown', identity)
            assert code == 200 and repeat == result, repeat
            assert executed == ['FOLLOWER']
            checks.append('exact recovery repeat returns same receipt; follower executes once without head replay')
            final = (await req('GET', run_path))[1]
            assert final['status'] in ('cancelled', 'interrupted'), final
            checks.append('canonical terminal state refreshes local queue')
        print(json.dumps({'scope':'real upstream authority/adapter replacement through WAS; deterministic execution, not a full gateway reboot','checks':checks,'upstream_commit':commit,'receipt':result,'artifact_dir':str(root)}, indent=2))
    finally:
        if proc and proc.returncode is None:
            proc.terminate()
            try: await asyncio.wait_for(proc.wait(), 10)
            except asyncio.TimeoutError: proc.kill(); await proc.wait()
        await upstream._close_fixture(client, adapters, store, tasks)
        patch.undo()
asyncio.run(main())
