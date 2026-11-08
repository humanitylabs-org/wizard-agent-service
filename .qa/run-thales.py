import fcntl, hashlib, json, os, pathlib, signal, socket, subprocess, sys, time
root = pathlib.Path('/Volumes/ThalesMedia/WizardQA/chat-app-provenance-20261014')
shas = {'baseline':sys.argv[1], 'candidate':sys.argv[2]}
os.environ['PATH'] = '/opt/homebrew/bin:' + os.environ.get('PATH','')
def hashes(source):
    return {str(p.relative_to(source)):hashlib.sha256(p.read_bytes()).hexdigest() for p in source.rglob('*') if p.is_file() and not any(part in {'node_modules','.git'} for part in p.parts)}
def save(mode, data):
    (root/('receipt-'+mode+'-'+shas[mode][:12]+'.json')).write_text(json.dumps(data,indent=2))
receipts = {mode:{'host':socket.gethostname(),'source_sha':sha,'source_path':str(root/mode),'started_at':time.time(),'steps':[],'source_hashes_before':hashes(root/mode)} for mode,sha in shas.items()}
with open(root/'coordinator.log','w') as progress, open('/Volumes/ThalesMedia/AndroidBuilds/worker.lock','a') as lock:
    wait_seconds=float(sys.argv[3]) if len(sys.argv)>3 else 300
    progress.write('Waiting for shared heavy-worker lock; bounded at '+str(wait_seconds)+' seconds\n');progress.flush()
    deadline=time.monotonic()+wait_seconds
    while True:
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
        except BlockingIOError:
            if time.monotonic()>=deadline:
                holders=subprocess.run(['lsof','/Volumes/ThalesMedia/AndroidBuilds/worker.lock'],capture_output=True,text=True).stdout
                for mode,r in receipts.items():
                    r.update({'status':'BLOCKED_SHARED_WORKER_LOCK','lock':'/Volumes/ThalesMedia/AndroidBuilds/worker.lock','holders':holders,'finished_at':time.time(),'source_hashes_after':hashes(root/mode)})
                    save(mode,r)
                progress.write('Blocked: no dependency installation or npm suite started\n');progress.flush()
                sys.exit(75)
            time.sleep(2)
    progress.write('Acquired\n');progress.flush()
    for mode,sha in shas.items():
        source=root/mode;case=root/('state-'+mode)
        for name in ['tmp','hermes','wizard','home','cache']:(case/name).mkdir(parents=True,exist_ok=True)
        env={**os.environ,'HERMES_HOME':str(case/'hermes'),'WIZARD_OS_HOME':str(case/'wizard'),'HOME':str(case/'home'),'TMPDIR':str(case/'tmp'),'npm_config_cache':str(case/'cache')}
        steps=[('install',['npm','ci','--no-audit','--no-fund'])]
        if mode=='candidate':steps.append(('focused',['npm','test','--','tests/thread-app-provenance.test.ts','tests/thread-status.test.ts','tests/session-truth-seek.test.ts','tests/thread-status-backfill-list.test.ts','tests/thread-subjects.test.ts','tests/thread-titles.test.ts','--maxWorkers=2','--reporter=default','--reporter=json','--outputFile='+str(root/('focused-'+sha[:12]+'.json'))]))
        steps.append(('suite',['npm','test','--','--maxWorkers=2','--reporter=default','--reporter=json','--outputFile='+str(root/('suite-'+mode+'-'+sha[:12]+'.json'))]))
        r=receipts[mode]
        for name,command in steps:
            log=root/(mode+'-'+name+'-'+sha[:12]+'.log');start=time.time()
            with open(log,'w') as out:
                process=subprocess.Popen(command,cwd=source,env=env,stdout=out,stderr=subprocess.STDOUT,start_new_session=True)
                try:rc=process.wait(timeout=900)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid,signal.SIGKILL);rc=process.wait();r['timed_out_step']=name
            r['steps'].append({'step':name,'command':command,'exit':rc,'log':str(log),'duration_seconds':time.time()-start});save(mode,r)
            progress.write(mode+' '+name+' exit='+str(rc)+'\n');progress.flush()
            if name=='install' and rc:break
        r.update({'status':'FINISHED','finished_at':time.time(),'source_hashes_after':hashes(source)})
        r['source_unchanged']=r['source_hashes_before']==r['source_hashes_after'];save(mode,r)
    progress.write('Finished\n');progress.flush()
