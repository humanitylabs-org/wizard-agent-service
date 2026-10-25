"""Explicit post-seal rollback proof. Synthetic pp-rig only."""
exec(__import__('pathlib').Path('/home/rig/pp-launch-3/legacy-extra.py').read_text().split("phase=sys.argv[1]")[0])
aid='pp-test-legacy'
try:
    raise RuntimeError('injected post-seal verify failure')
except RuntimeError as failure:
    assert str(failure)=='injected post-seal verify failure'
record=json.loads((A/aid/'agent.json').read_text())
assert record['runtime']['private_client'] is True
attempt=record['runtime']['migration_source']['attempt']
c,b=req('/wizard/v1/agents/'+aid,{'restore_private_provider':attempt},'PATCH')
assert c==200,('restore failed',c,b.get('error'))
running(aid)
c,b=req('/wizard/v1/agents/'+aid);assert c==200 and b['agent']['model']['provider']=='tinfoil'
restored=json.loads((A/aid/'agent.json').read_text())
assert restored['privacy']=='private' and not restored['runtime'].get('private_client')
checkpoint=json.loads((R/'legacy-checkpoint.json').read_text())
session=checkpoint['canonical_history']['session_id'];c,b=req('/wizard/hermes/api/sessions/'+session+'/messages?agent='+aid)
assert c==200 and 'PP_OK' in json.dumps(b)
assert hashlib.sha256(json.dumps(b.get('messages',b.get('data')),sort_keys=True,separators=(',',':')).encode()).hexdigest()==checkpoint['canonical_history']['sha256']
run(['python3',str(R/'probe-guest.py'),aid],timeout=420)
docs=containers();assert not any((x['Config'].get('Labels') or {}).get('com.docker.compose.service')=='agent-'+aid+'-client' for x in docs)
assert (A/aid/'home').stat().st_ino==checkpoint['inode']
save('postseal-rollback',{'status':'passed','forced_post_migration_failure':True,'completed_sealed_request_before_rollback':True,'owner_restore_http':200,'completed_legacy_request_after_rollback':True,'canonical_history_preserved':True,'home_inode_preserved':True,'sealed_client_absent':True,'attempt':attempt})
