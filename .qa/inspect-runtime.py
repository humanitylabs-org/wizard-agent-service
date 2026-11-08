import json, pathlib, sqlite3, subprocess, time, urllib.request
service = subprocess.check_output(['systemctl','--user','show','wizard-mobile.service','-p','MainPID','--value'],text=True).strip()
p = pathlib.Path('/proc')/service
env = dict(x.split('=',1) for x in p.joinpath('environ').read_bytes().decode().split('\0') if '=' in x)
upstream = env.get('HERMES_ORIGIN','http://127.0.0.1:8642')
queue = env.get('WIZARD_RUN_QUEUE_STATE_PATH','/home/telos/.hermes/state/wizard-mobile/run-queue.sqlite3')
db = sqlite3.connect('file:'+queue+'?mode=ro',uri=True); db.row_factory=sqlite3.Row
rows = [dict(r) for r in db.execute("SELECT public_run_id,session_id,runtime,status,upstream_run_id,worker_run_id FROM wizard_run_queue WHERE status IN ('queued','launching','running','waiting_for_approval','stopping')")]
for r in rows:
    if not r['upstream_run_id']: continue
    req = urllib.request.Request(upstream+'/v1/runs/'+r['upstream_run_id'],headers={'Authorization':'Bearer '+env.get('WIZARD_HERMES_API_KEY','')})
    try:
        with urllib.request.urlopen(req,timeout=5) as resp: run=json.load(resp)
        r['gateway_status']=run.get('status'); r['gateway_run_id']=run.get('run_id',run.get('id'))
        r['gateway_session_id']=run.get('session_id')
    except Exception as e: r['gateway_read_error']=str(e)
receipt = {'checked_at_epoch':time.time(),'wizard_service_pid':service,'wizard_service_cgroup':p.joinpath('cgroup').read_text().strip(),'release':str(pathlib.Path('/home/telos/.local/share/wizard-mobile-server/current').resolve()),'upstream':upstream,'service_children':subprocess.run(['pgrep','-P',service],capture_output=True,text=True).stdout.strip().splitlines(),'queue_active':rows,'no_restart_performed':True}
path=pathlib.Path('.qa/runtime-safety.json');path.write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt,indent=2))
