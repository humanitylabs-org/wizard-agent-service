#!/usr/bin/env python3
"""Exercise the SAME real operation plan twice in pp-rig: pass + forced rollback."""
import importlib.util,json,os,sys,time,uuid
from pathlib import Path
assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers' and os.geteuid()==1000
H=Path('/home/rig');B=H/'pp-live-assets';T=Path(__file__).parent;sys.path.insert(0,str(T));os.environ.update(XDG_RUNTIME_DIR='/run/user/1000',DBUS_SESSION_BUS_ADDRESS='unix:path=/run/user/1000/bus',HOME=str(H),RUNTIPI_ROOT=str(H/'runtipi'))
def module(name,file):
 s=importlib.util.spec_from_file_location(name,T/file);assert s and s.loader;m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
engine=module('engine','live-run-all.py');preflight=module('preflight','live-preflight.py')
from owner_acceptance import Owner
from production_readiness import code_hashes
assets=json.loads((B/'assets.json').read_text());seed=json.loads((B/'seed-rig-evidence.json').read_text())
plan={'schema':1,'no_drain':True,'migration_agent':'private','rollback_scope':'attempt','python_only_wam':True,'runtipi_daemon_unchanged':True,'rig_target':True,'rig_legacy_agent':'pp-test-legacy','home':str(H),'service_origin':'http://127.0.0.1:8787','owner_proof_file':str(H/'.wizard-os/agent-runtime/owner-proof'),'legacy_source':str(H/'pp-launch-3/legacy-key.env'),'runtime_origin':'http://127.0.0.1:7795','runtime_auth_file':str(H/'.wizard-os/agent-runtime/token'),'check_file':str(B/'candidate/acceptance/check.py'),**assets}
for name in ['wam','provider','provider_image']:plan[name+'_archive']=str(B/(name+'.tar'))
plan['provider_image_archive']=str(B/'provider-runtime.tar.gz')
plan['commands']={op:['/usr/bin/python3',str(T/('rig-stage.py' if op=='stage' else 'production_adapter.py'))]+([] if op=='stage' else [op]) for op in engine.REQUIRED}
root=H/'pp-live-receipts';root.mkdir(exist_ok=True);report={'status':'running','runs':[],'started_at':time.time()};target=root/'full-result.json'
def save():(target).write_text(json.dumps(report,indent=2)+'\n')
save();before=preflight.fingerprint(H)
for forced in [False,True]:
 attempt=uuid.uuid4().hex;out=root/attempt;out.mkdir();p={**plan,'force_post_migration_failure':forced};(out/'plan.json').write_text(json.dumps(p,indent=2)+'\n')
 ops=engine.Commands(p,attempt,out);result=engine.Orchestrator(ops,lambda:preflight.fingerprint(H),out/'receipt.json').run(seed,p,False);report['runs'].append(result);save()
 print('FULL_RUN', 'forced' if forced else 'normal',result['status'],flush=True)
 if not forced:
  assert result['status']=='passed','normal full orchestration failed'
  # Check e on the actual new product: removal keeps the migrated record sealed
  # and yields a visible unavailable result; reinstallation recovers the seal.
  from provider_adapter import Provider,api,URN,FORM
  from owner_acceptance import run
  wm=H/'.local/share/wam-python/current';rt=api(H,wm);owner=Owner(H,p['service_origin'],p['owner_proof_file'],out,attempt)
  rt.uninstall(URN);assert rt.wait_status(URN,{'missing'},timeout=180)=='missing'
  from wam import cli
  cli.write_registry(cli.Config(),rt)
  code,closed=owner.request('/wizard/hermes/api/sessions?agent=pp-test-legacy',{'source':'wizard-mobile'},'POST')
  assert code==503 and closed.get('error')=='private_provider_unavailable'
  sealed=owner.require('/wizard/v1/agents/pp-test-legacy')['agent'];assert sealed['model']['provider']=='wizard-tinfoil' and sealed['runtime']['isolation']=='restricted'
  assert not run(['docker','ps','-aq','--filter','label=com.docker.compose.service=agent-pp-test-legacy-tinfoil']).strip()
  run(['docker','image','load','-i',p['provider_image_archive']],timeout=180)
  rt.install(URN,FORM);assert rt.wait_status(URN,{'running','stopped'},timeout=180)=='running';cli.write_registry(cli.Config(),rt)
  Provider(H,wm,out,attempt).connect(p['legacy_source'],p['runtime_origin'],p['runtime_auth_file'])
  owner.require('/wizard/v1/agents/pp-test-legacy/start',{},'POST',allowed=(200,202));owner.ready('pp-test-legacy');owner.prefix='pp-test-';assert owner.chat('pp-test-legacy').get('completed') is True
  removal={'provider_removed':True,'visible_unavailable_http':503,'sealed_record_retained':True,'legacy_sidecar_absent':True,'sealed_request_recovered_after_reinstall':True};(out/'provider-removal.json').write_text(json.dumps(removal,indent=2)+'\n');report['provider_removal']=removal;save()
  # Restore a clean semantic baseline using the SAME product + API + pointer
  # rollback, even after successful promotion. Preserve the success receipt.
  cleanup=ops.call('rollback',out/'context.json',timeout=600);report['normal_explicit_rollback']=cleanup;save()
 else:
  assert result['status']=='rolled_back','forced post-seal failure did not roll back'
  proof=json.loads((out/'forced-postseal-failure.json').read_text());rollback=json.loads((out/'rollback.json').read_text())
  assert proof['completed_migrated_request'] is True and proof['migration_readback']['credential_matches']==0
  assert rollback['postseal_legacy_restored'] is True and rollback['completed_legacy_request_after_rollback'] is True and rollback['legacy_route_after_code_rollback'] is True
  report['postseal_rollback']=rollback
owner=Owner(H,plan['service_origin'],plan['owner_proof_file'],root,'0'*32)
checkpoint=json.loads((H/'pp-launch-3/legacy-checkpoint.json').read_text());sid=checkpoint['canonical_history']['session_id'];body=owner.require('/wizard/hermes/api/sessions/'+sid+'/messages?agent=pp-test-legacy')
import hashlib
assert hashlib.sha256(json.dumps(body.get('messages',body.get('data')),sort_keys=True,separators=(',',':')).encode()).hexdigest()==checkpoint['canonical_history']['sha256']
after=preflight.fingerprint(H);assert before['containers']['runtipi']==after['containers']['runtipi'];assert before['releases']==after['releases'] and before['shell']==after['shell'] and before['wam_sources']==after['wam_sources']
report.update(status='passed',canonical_history_preserved=True,runtipi_daemon_unchanged=True,selection_rollback_readback=True,finished_at=time.time(),full_live_run_all={'normal_status':report['runs'][0]['status'],'forced_failure_status':report['runs'][1]['status'],'completed_legacy_after_rollback':report['postseal_rollback']['completed_legacy_request_after_rollback'],'tooling_sha256':code_hashes(T),**{k:assets[k] for k in ['service_sha','ux_sha','wam_archive_sha256','provider_archive_sha256','provider_image_archive_sha256','provider_image_id']}});save();print('FULL_ORCHESTRATION_AND_POSTSEAL_ROLLBACK_PASS',flush=True)
