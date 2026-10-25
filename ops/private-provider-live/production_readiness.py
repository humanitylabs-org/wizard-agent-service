"""Read-only admission for the concrete production plan and full rig proof."""
import hashlib
import json
import os
from pathlib import Path
from owner_acceptance import Owner
from provider_adapter import api,blank_config,urns,URN,OLD
FILES=('live-run-all.py','live-preflight.py','live_sources.py','release_transaction.py','python_rollout.py','provider_adapter.py','owner_acceptance.py','production_adapter.py','stage-candidate.py','production_readiness.py')
def code_hashes(root):return {n:hashlib.sha256((Path(root)/n).read_bytes()).hexdigest() for n in FILES}
def check(plan,rig,live,tooling):
    blockers=[]
    if plan.get('python_only_wam') is not True or plan.get('runtipi_daemon_unchanged') is not True:blockers.append('explicit Python-only WAM/unchanged daemon contract missing')
    full=rig.get('full_live_run_all',{})
    if full.get('normal_status')!='passed' or full.get('forced_failure_status')!='rolled_back' or full.get('completed_legacy_after_rollback') is not True:blockers.append('same-adapter full orchestration/forced post-seal rollback proof missing')
    if full.get('tooling_sha256')!=code_hashes(tooling):blockers.append('tooling changed since full rig proof')
    for name in ['service_sha','ux_sha','wam_archive_sha256','provider_archive_sha256']:
        if full.get(name)!=plan.get(name):blockers.append('exact rig/plan artifact mismatch: '+name)
    for name in ['wam','provider']:
        file=Path(plan[name+'_archive'])
        if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest()!=plan[name+'_archive_sha256']:blockers.append('local artifact drift: '+name)
    if blockers:return blockers
    if Path(plan['home'])!=Path.home():blockers.append('target is not current owner home')
    try:
        rt=api(plan['home'],live['wam_sources']['selected']['api']['resolved']);installed=urns(rt)
        rt.req('GET','/user-config/'+URN)
        if URN in installed or not blank_config(rt.req('GET','/user-config/'+URN)):blockers.append('private provider app or user-config already belongs to another attempt')
        if OLD in installed:rt.list_backups(OLD) # API capability and auth; no backup created
        owner=Owner(plan['home'],plan['service_origin'],plan['owner_proof_file'],Path(plan['home']), '0'*32)
        legacy=owner.require('/wizard/v1/agents/private')['agent']
        if legacy.get('privacy')!='private' or legacy.get('model',{}).get('provider')!='tinfoil' or legacy.get('runtime',{}).get('isolation')=='restricted':blockers.append('Private is not the expected unmigrated legacy confidential route')
        if not Path(plan['legacy_source']).is_file() or not Path(plan['runtime_auth_file']).is_file():blockers.append('trusted runtime/legacy source prerequisite absent')
        if not os.access(Path(plan['home'])/'runtipi/repos/wizardapps/apps',os.W_OK):blockers.append('owner-writable app source selection absent')
    except Exception as e:blockers.append(type(e).__name__+': read-only authenticated prerequisite failed')
    return blockers
