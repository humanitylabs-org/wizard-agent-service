#!/usr/bin/env python3
"""Concrete attempt-scoped parent operations; dry-run never invokes this file.

Mutations are authorized only in the parent's detached no-drain launch or inside
pp-rig. All persisted receipts contain release/control metadata, never secrets.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
import urllib.request
from release_transaction import atomic
from python_rollout import Rollout, digest, tree_hash
from provider_adapter import Provider
from owner_acceptance import Owner, run

def load(path):return json.loads(Path(path).read_text())
def write(path,obj):atomic(path,(json.dumps(obj,indent=2)+'\n').encode())
def runtime_argv():
    raw=subprocess.check_output(['systemctl','--user','show','wizard-agent-runtime','--property=ExecStart','--value'],text=True)
    if 'argv[]=' not in raw:raise RuntimeError('runtime argv discovery unavailable')
    return shlex.split(raw.split('argv[]=',1)[1].split(' ; ',1)[0])
def restart(owner,runtime_origin):
    # This function is built for the parent, never invoked by the adapter lane on
    # James's VPS. Runtipi is intentionally absent. No blanket restart helper.
    run(['systemctl','--user','daemon-reload'],timeout=30)
    run(['systemctl','--user','restart','wizard-app-manager-api','wizard-agent-runtime','wizard-mobile'],timeout=210)
    deadline=time.monotonic()+120
    while time.monotonic()<deadline:
        try:
            code,b=owner.request('/wizard/health')
            if code==200:
                with urllib.request.urlopen('http://127.0.0.1:7790/healthz',timeout=3) as response:assert json.load(response).get('ok') is True
                with urllib.request.urlopen(runtime_origin+'/healthz',timeout=3) as response:assert json.load(response).get('ok') is True
                return
        except Exception:pass
        time.sleep(1)
    raise RuntimeError('Service readiness after single restart failed')
def runtime_rpc(plan,aid,action):
    secret=Path(plan['runtime_auth_file']).read_text().strip()
    q=urllib.request.Request(plan['runtime_origin']+'/agents/'+aid+'/'+action,b'{}',{'Content-Type':'application/json','Authorization':'Bearer '+secret},method='POST')
    with urllib.request.urlopen(q,timeout=210) as f:return json.load(f)
def main():
    ap=argparse.ArgumentParser(__doc__);ap.add_argument('operation',choices=['snapshot','deploy','install','privacy','regression','migrate','verify','rollback']);args=ap.parse_args()
    ctx=load(os.environ['PP_LAUNCH_CONTEXT']);p=ctx['plan'];attempt=ctx['attempt'];out=Path(os.environ['PP_LAUNCH_RECEIPTS']);home=Path(p['home'])
    if ctx['dry_run'] or os.environ.get('PP_LAUNCH_NO_DRAIN')!='1':raise RuntimeError('mutation rejected outside explicit parent no-drain invocation')
    if p.get('rig_target'):
        if Path('/etc/pp-rig').read_text().strip()!='pp-private-providers' or str(home)!='/home/rig':raise RuntimeError('rig target marker mismatch')
    elif os.environ.get('PP_PARENT_LIVE_RUN')!='1':raise RuntimeError('only the parent may launch production mutations')
    owner=Owner(home,p['service_origin'],p['owner_proof_file'],out,attempt)
    provider_wam=home/'.local/share/wam-python/current'
    if args.operation=='snapshot' or not provider_wam.exists():provider_wam=Path(ctx['live']['wam_sources']['selected']['api']['resolved'])
    rollout=Rollout(home,out,attempt);provider=Provider(home,provider_wam,out,attempt)
    result={'attempt':attempt,'operation':args.operation,'status':'passed'}
    phase=args.operation
    if phase=='snapshot':
        result['filesystem']=rollout.snapshot();result['provider']=provider.snapshot(p['legacy_source'],p['runtime_auth_file'])
        result['private_agent']=owner.require('/wizard/v1/agents/private')['agent'] if not p.get('rig_target') else owner.require('/wizard/v1/agents/'+p['rig_legacy_agent'])['agent']
        # Public metadata only: never open an agent record/home or container data.
        write(out/'pre-migration-public.json',result['private_agent']);write(out/'runtime-argv.json',runtime_argv())
    elif phase=='deploy':
        stage=load(out/'stage.json');metadata={'candidate_sha':stage['candidate_sha'],'repository':'https://github.com/humanitylabs-org/wizard-agent-service.git','wam_files':p['wam_files']}
        if digest(stage['local_artifact'])!=stage['artifact_sha256']:raise RuntimeError('candidate archive drift')
        if digest(p['wam_archive'])!=p['wam_archive_sha256']:raise RuntimeError('WAM archive drift')
        rollout.prepare(stage['local_artifact'],p['wam_archive'],metadata)
        result.update(rollout.promote(load(out/'runtime-argv.json')));restart(owner,p['runtime_origin'])
        from live_sources import discover
        result['wam_sources']=discover(home)
        for route in result['wam_sources']['selected'].values():
            if any(route['sha256'][n]!=h for n,h in p['wam_files'].items()):raise RuntimeError('independent WAM source selection readback failed')
        actual=json.loads(run(['docker','inspect','runtipi']))[0]
        if actual['Id']!=ctx['live']['containers']['runtipi']['id'] or actual['State']['StartedAt']!=ctx['live']['containers']['runtipi']['started_at']:raise RuntimeError('Runtipi daemon changed')
        result['runtipi_unchanged']=True
    elif phase=='install':
        result.update(provider.install(p['provider_archive'],p['provider_archive_sha256'],{'archive':p['provider_image_archive'],'sha256':p['provider_image_archive_sha256'],'id':p['provider_image_id']}));result['connection']=provider.connect(p['legacy_source'],p['runtime_origin'],p['runtime_auth_file'])
    elif phase=='privacy':
        result.update(owner.privacy(p['check_file'],p['legacy_source']))
    elif phase=='regression':
        result.update(owner.regression())
        if p.get('rig_target'):
            saved=owner.prefix;owner.prefix='pp-test-';result['legacy_coexistence_chat_completed']=owner.chat(p['rig_legacy_agent']).get('completed');owner.prefix=saved
            if not result['legacy_coexistence_chat_completed']:raise RuntimeError('legacy coexistence regression failed')
    elif phase=='migrate':
        aid=p.get('rig_legacy_agent') if p.get('rig_target') else 'private'
        before=load(out/'pre-migration-public.json');current=owner.require('/wizard/v1/agents/'+aid)['agent']
        if current['model']!=before['model'] or current.get('privacy')!=before.get('privacy'):raise RuntimeError('Private public model/privacy drifted since snapshot')
        # Journal intent BEFORE the PATCH: a lost HTTP response still triggers an
        # explicit attempt-fenced rollback, never a source-only downgrade.
        write(out/'migration-intent.json',{'attempt':attempt,'agent':aid})
        result['agent']=owner.require('/wizard/v1/agents/'+aid,{'migrate_private_provider':True,'private_migration_attempt':attempt},'PATCH')['agent']
        if result['agent']['model']['provider']!='wizard-tinfoil' or result['agent'].get('runtime',{}).get('isolation')!='restricted':raise RuntimeError('Private seal metadata did not verify')
    elif phase=='verify':
        aid=p.get('rig_legacy_agent') if p.get('rig_target') else 'private'
        owner.ready(aid)
        result['migration_readback']=runtime_rpc(p,aid,'private-migration-status')
        rb=result['migration_readback']
        write(out/'migration-status.json',{k:rb.get(k) for k in ('sealed','retirement_status','retired_files','files_scanned','credential_matches')})
        if rb.get('retirement_status')!='completed' or rb.get('credential_matches')!=0 or rb.get('sealed') is not True:raise RuntimeError('post-migration credential retirement readback failed')
        if p.get('rig_target'):
            # No production Private request exists in this code path. Synthetic
            # migrated inference is required only inside the marked rig.
            saved=owner.prefix;owner.prefix='pp-test-';result['completed_migrated_request']=owner.chat(aid).get('completed');owner.prefix=saved
            if not result['completed_migrated_request']:raise RuntimeError('migrated synthetic inference failed')
        if p.get('force_post_migration_failure'):
            write(out/'forced-postseal-failure.json',result)
            raise RuntimeError('injected post-seal verification failure')
        result['cleanup']=owner.cleanup()
    elif phase=='rollback':
        aid=p.get('rig_legacy_agent') if p.get('rig_target') else 'private'
        intent=out/'migration-intent.json'
        if intent.exists():
            if load(intent)!={'attempt':attempt,'agent':aid}:raise RuntimeError('foreign migration intent')
            current=owner.require('/wizard/v1/agents/'+aid)['agent']
            if current.get('runtime',{}).get('isolation')=='restricted' or current['model']['provider']=='wizard-tinfoil':
                owner.require('/wizard/v1/agents/'+aid,{'restore_private_provider':attempt},'PATCH')
            else:
                # An interrupted pre-seal scrub is restored through the existing
                # product rollback RPC, not by editing metadata/home ourselves.
                runtime_rpc(p,aid,'rollback-private-migration')
                owner.require('/wizard/v1/agents/'+aid+'/start',{},'POST')
            owner.ready(aid)
            readback=owner.require('/wizard/v1/agents/'+aid)['agent'];before=load(out/'pre-migration-public.json')
            if readback['model']!=before['model'] or readback.get('privacy')!=before.get('privacy'):raise RuntimeError('legacy route public rollback readback differs')
            result['postseal_legacy_restored']=True
            if p.get('rig_target'):
                saved=owner.prefix;owner.prefix='pp-test-';result['completed_legacy_request_after_rollback']=owner.chat(aid).get('completed');owner.prefix=saved
                if not result['completed_legacy_request_after_rollback']:raise RuntimeError('legacy chat did not recover after un-migration')
        result['cleanup']=owner.cleanup()
        result['provider']=provider.rollback()
        # Only now may old runtime/Service code be selected. Never point old code
        # at a sealed record. All target CAS checks happen before pointer writes.
        result['filesystem']=rollout.rollback();restart(owner,p['runtime_origin'])
        current=owner.require('/wizard/v1/agents/'+aid)['agent']
        result['legacy_route_after_code_rollback']=current['model']['provider']=='tinfoil'
    write(out/(phase+'.json'),result)
    return 0
if __name__=='__main__':
    try:sys.exit(main())
    except Exception as e:
        # Exception messages from urllib/Runtipi may include private response data.
        # Keep only exception class and adapter phase in the visible CLI result.
        import traceback
        frames=[{'file':Path(f.filename).name,'function':f.name,'line':f.lineno} for f in traceback.extract_tb(e.__traceback__)]
        error={'type':type(e).__name__,'frames':frames}
        import re
        status=re.search(r' -> (\d{3}):',str(e))
        if status:error['http_status']=int(status[1])
        codes=re.findall(r'\b(?:APP_ERROR|SYSTEM_ERROR)_[A-Z_]+\b',str(e))
        if codes:error['api_errors']=sorted(set(codes))
        root=os.environ.get('PP_LAUNCH_RECEIPTS')
        if root:write(Path(root)/'adapter-error.json',error)
        print('ADAPTER_FAILED '+json.dumps(error),file=sys.stderr)
        sys.exit(1)
