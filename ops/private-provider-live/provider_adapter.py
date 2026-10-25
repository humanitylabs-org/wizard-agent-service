"""API-only private provider installation and exact prior-app restore.

All filesystem writes stay inside owner-writable repos/wizardapps/apps/. Generated
Runtipi files are NEVER written. No daemon image/Compose route is present here.
"""
import hashlib
import gzip
import subprocess
import json
from pathlib import Path
import shutil
import sys
import time
import urllib.request
from python_rollout import digest, unpack
from release_transaction import atomic
URN='wizard-tinfoil_private:wizardapps'
OLD='wizard-tinfoil:wizardapps'
ID='wizard-tinfoil_private'
SHA='07eca5e30ca7873ab8cfda503175768fc55f66d4'
FORM={'openPort':False,'exposed':False,'exposedLocal':False,'port':18804,'WIZARD_TRUSTED_HOSTS':'127.0.0.1:18804,localhost:18804','WIZARD_TRUSTED_ORIGINS':'http://127.0.0.1:18804','HERMES_DASHBOARD_BASIC_AUTH_PASSWORD':'relay-only-unused-local-value'}
OVERRIDE='services:\n  wizard-tinfoil:\n    networks: !override\n      - provider-bootstrap\n    volumes:\n      - tinfoil-private-data:/data\nvolumes:\n  tinfoil-private-data:\n    name: wizard-tinfoil-private-data\n'

def api(home,wam):
    sys.path.insert(0,str(wam))
    from wam.runtipi import Runtipi
    return Runtipi.from_install(Path(home)/'runtipi')

def urns(rt):return {(r.get('info') or {}).get('urn'):r for r in rt.installed()}

def user_config(rt):
    # An unstaged local recipe has no catalogue entry yet. Only this exact API
    # absence is a blank prior config; auth/transport/other errors fail closed.
    try:return rt.req('GET','/user-config/'+URN)
    except Exception as error:
        text=str(error)
        if type(error).__name__=='RuntipiError' and text.startswith('GET /user-config/'+URN+' -> 404:') and 'APP_ERROR_APP_NOT_FOUND' in text:
            return {'dockerCompose':'','appEnv':''}
        raise

def config_hash(data):
    return hashlib.sha256(json.dumps({k:(data.get(k) or '').rstrip('\n') for k in ['dockerCompose','appEnv']},sort_keys=True).encode()).hexdigest()

def blank_config(data):
    import yaml
    try:
        compose=yaml.safe_load(data.get('dockerCompose') or '')
    except yaml.YAMLError:
        return False  # !override is a real pre-existing config, never a blank template
    return not any(l.strip() and not l.lstrip().startswith('#') for l in (data.get('appEnv') or '').splitlines()) and compose in [None,{}, {'services':{}},{'services':None}]

class Provider:
    def __init__(self,home,wam,receipts,attempt):
        self.home=Path(home);self.wam=Path(wam);self.root=Path(receipts);self.attempt=attempt
        self.rt=api(home,wam);self.journal=self.root/'provider-transaction.json'
    def snapshot(self,legacy_source,auth_source=None):
        installed=urns(self.rt)
        if URN in installed:raise RuntimeError('private provider already installed by another attempt')
        before=user_config(self.rt)
        if not blank_config(before):raise RuntimeError('foreign private provider user-config')
        old=installed.get(OLD)
        data={'attempt':self.attempt,'old_present':bool(old),'old_status':(old or {}).get('app',{}).get('status'),'backup':None,'new_owned':False,'prior_user_config':before}
        atomic(self.journal,json.dumps(data).encode())
        if old:
            # The API restore handler requires an installed row. Preserve its
            # exact form encrypted under the unchanged trusted runtime auth, not
            # as credential-bearing JSON in the operation receipt.
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            import os
            if not auth_source:raise RuntimeError('trusted restore sealing source absent')
            form=(self.rt.app(OLD).get('app') or {}).get('config') or {}
            plain=json.dumps(form,sort_keys=True).encode()
            from owner_acceptance import load_legacy_source
            if load_legacy_source(legacy_source).encode() in plain:raise RuntimeError('legacy credential in app form; encrypted snapshot refused')
            seal=hashlib.sha256(b'pp-provider-form-v1\0'+Path(auth_source).read_bytes()).digest();nonce=os.urandom(12)
            atomic(self.root/'prior-provider-form.sealed',nonce+AESGCM(seal).encrypt(nonce,plain,self.attempt.encode()))
            old_config=self.rt.req('GET','/user-config/'+OLD)
            data.update(form_auth_source=str(auth_source),old_form_sha256=hashlib.sha256(plain).hexdigest(),old_user_config_sha256=config_hash(old_config),old_retired=False,old_restored=False)
            atomic(self.journal,json.dumps(data).encode())
            ids=subprocess.check_output(['docker','ps','-aq','--filter','label=com.docker.compose.project=wizard-tinfoil_wizardapps','--filter','label=com.docker.compose.service=wizard-tinfoil'],text=True).split()
            if len(ids)!=1:raise RuntimeError('prior provider image identity ambiguous')
            doc=json.loads(subprocess.check_output(['docker','inspect',ids[0]]))[0]
            image=doc['Image'];ref=doc['Config']['Image'];out=self.root/'prior-provider-image.tar.gz'
            from owner_acceptance import load_legacy_source
            needle=load_legacy_source(legacy_source).encode();overlap=b''
            proc=subprocess.Popen(['docker','image','save',ref],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            assert proc.stdout is not None and proc.stderr is not None
            try:
                with gzip.open(out,'wb',compresslevel=1) as sink:
                    while chunk:=proc.stdout.read(1048576):
                        data_chunk=overlap+chunk
                        if needle in data_chunk:raise RuntimeError('credential baked into prior interpreter image; snapshot refused')
                        overlap=data_chunk[-len(needle):];sink.write(chunk)
                err=proc.stderr.read();rc=proc.wait(timeout=30)
                if rc:raise RuntimeError('prior provider image snapshot failed (output withheld)')
                if out.stat().st_size>500_000_000:raise RuntimeError('prior provider image exceeds control-plane artifact bound')
            except BaseException:
                out.unlink(missing_ok=True);raise
            finally:
                if proc.poll() is None:proc.kill();proc.wait()
            out.chmod(0o600);data.update(prior_image=image,prior_image_ref=ref,prior_image_archive=str(out),prior_image_sha256=digest(out));atomic(self.journal,json.dumps(data).encode())
        return {'old_present':bool(old),'new_present':False,'user_config_readback':True,'prior_interpreter_image_retained':bool(old)}
    def install(self,archive,expected_sha,runtime=None):
        import yaml
        from wam import cli
        if digest(archive)!=expected_sha:raise RuntimeError('provider source drift')
        data=json.loads(self.journal.read_text());assert data['attempt']==self.attempt
        if not runtime or digest(runtime['archive'])!=runtime['sha256']:raise RuntimeError('provider interpreter artifact absent or drifted')
        subprocess.run(['docker','image','load','-i',runtime['archive']],check=True,capture_output=True,timeout=180)
        img=json.loads(subprocess.check_output(['docker','image','inspect',runtime['id']]))[0]
        if img['Id']!=runtime['id'] or img['Architecture']!='amd64':raise RuntimeError('provider interpreter identity/architecture drift')
        if data['old_present']:
            # The existing canonical provider occupies the same port/id. Runtipi
            # owns the root-only snapshot; no provider data enters our receipts.
            previous={x['id'] for x in self.rt.list_backups(OLD)}
            self.rt.backup_app(OLD)
            deadline=time.monotonic()+180
            while True:
                fresh=[x for x in self.rt.list_backups(OLD) if x['id'] not in previous]
                if fresh:break
                if time.monotonic()>deadline:raise RuntimeError('prior provider snapshot timeout')
                time.sleep(1)
            if len(fresh)!=1:raise RuntimeError('prior provider snapshot ambiguous')
            data['backup']=fresh[0]['id'];atomic(self.journal,json.dumps(data).encode())
            data['old_retired']=True;atomic(self.journal,json.dumps(data).encode())
            self.rt.uninstall(OLD,remove_backups=False)
            deadline=time.monotonic()+180
            while OLD in urns(self.rt):
                if time.monotonic()>deadline:raise RuntimeError('prior provider retirement timeout')
                time.sleep(1)
        dst=self.home/'runtipi/repos/wizardapps/apps'/ID
        if dst.exists():raise RuntimeError('private provider source selection already exists')
        src=unpack(archive,self.root/'provider-source')
        (dst/'metadata').mkdir(parents=True)
        release=dst/'releases'/SHA;shutil.copytree(src,release)
        comp=yaml.safe_load((src/'runtipi/docker-compose.yml').read_text());cfg=json.loads((src/'runtipi/config.json').read_text());cfg.update(id=ID,source='local:'+ID)
        svc=comp['services']['wizard-tinfoil'];svc.update(image=runtime['id'],pull_policy='never');assert comp.pop('volumes')=={'tinfoil-private-data':{'name':'wizard-tinfoil-private-data'}}
        assert svc.pop('volumes')==['tinfoil-private-data:/data']
        svc['volumes']=[str(release)+':/app:ro'];svc['ports']=['127.0.0.1:${APP_PORT}:18804']
        for n,raw in [('wizard.md',(src/'wizard.md').read_bytes()),('config.json',json.dumps(cfg).encode()),('docker-compose.yml',yaml.safe_dump(comp,sort_keys=False).encode()),('.wizard-commit',(SHA+'\n').encode()),('.wizard-source',json.dumps({'repo':'local:'+ID,'private':True}).encode())]:atomic(dst/n,raw,0o644)
        shutil.copy2(src/'runtipi/metadata/logo.jpg',dst/'metadata/logo.jpg');atomic(dst/'metadata/description.md',b'Private relay-only provider\n',0o644)
        # Prove the immutable interpreter image has identical dependencies before
        # installing source at /app; never replace the Runtipi daemon image.
        p=subprocess.run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--entrypoint','python',svc['image'],'-c','from pathlib import Path;import hashlib;print(hashlib.sha256(Path("/app/requirements.lock").read_bytes()).hexdigest())'],capture_output=True,text=True,timeout=90)
        if p.returncode or p.stdout.strip()!=digest(src/'requirements.lock'):raise RuntimeError('provider interpreter dependency parity absent')
        data['source_hash']=__import__('python_rollout').tree_hash(dst)
        data['new_owned']=True;data['new_volume']='wizard-tinfoil-private-'+self.attempt;atomic(self.journal,json.dumps(data).encode())
        prior=data['prior_user_config'];env=prior.get('appEnv') or ''
        selected_override=OVERRIDE.replace('name: wizard-tinfoil-private-data','name: '+data['new_volume'])
        self.rt.req('PUT','/user-config/'+URN,{'dockerCompose':selected_override,'appEnv':env})
        after=self.rt.req('GET','/user-config/'+URN)
        if (after.get('dockerCompose') or '').rstrip('\n')!=selected_override.rstrip('\n') or (after.get('appEnv') or '').rstrip('\n')!=env.rstrip('\n'):raise RuntimeError('provider API override readback failed')
        self.rt.install(URN,FORM)
        status=self.rt.wait_status(URN,{'running','stopped'},timeout=180)
        if status!='running':raise RuntimeError('provider did not start')
        cfg=cli.Config();registry=cli.write_registry(cfg,self.rt)
        rows=[x for x in registry['apps'] if x.get('id')=='wizard-tinfoil']
        if len(rows)!=1 or rows[0].get('urn')!=URN or not rows[0].get('private_inference'):raise RuntimeError('canonical provider registry readback failed')
        atomic(self.root/'provider-registry-projection.json',json.dumps({k:rows[0].get(k) for k in ['id','status','urn','private_inference']}).encode())
        return {'urn':URN,'override_api_readback':True,'app_status':status,'source_sha':SHA,'dependency_parity':True,'canonical_registry_unique':True}
    def connect(self,legacy_source,runtime_origin,runtime_auth_file):
        # The authenticated runtime owns metadata reconciliation. The installer
        # never traverses a private agent's records or container data.
        auth=Path(runtime_auth_file).read_text().strip()
        q=urllib.request.Request(runtime_origin+'/providers/reconcile',b'{}',{'Content-Type':'application/json','Authorization':'Bearer '+auth},method='POST')
        with urllib.request.urlopen(q,timeout=180) as f:reconciled=json.load(f)
        del auth
        if reconciled.get('ok') is not True or reconciled.get('failure_count')!=0:raise RuntimeError('provider egress reconciliation failed')
        origin='http://127.0.0.1:18804';deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            try:
                with urllib.request.urlopen(origin+'/api/connection',timeout=3) as f:
                    if json.load(f).get('contract')=='wizard.ai-connection/1':break
            except Exception:pass
            time.sleep(.5)
        value=''
        for line in Path(legacy_source).read_text().splitlines():
            if line.startswith('TINFOIL_API_KEY='):value=line.split('=',1)[1].strip().strip('\"\'')
        if not value:raise RuntimeError('host legacy provider source unavailable')
        q=urllib.request.Request(origin+'/api/connect',json.dumps({'apiKey':value}).encode(),{'Content-Type':'application/json','Origin':origin,'X-Wizard-Request':'1'},method='POST')
        with urllib.request.urlopen(q,timeout=180) as f:result=json.load(f)
        if result.get('credentialStored') is not True:raise RuntimeError('provider credential admission failed')
        selected=subprocess.check_output(['docker','ps','-q','--filter','label=com.docker.compose.project=wizard-tinfoil_private_wizardapps','--filter','label=com.docker.compose.service=wizard-tinfoil'],text=True).split()
        if len(selected)!=1:raise RuntimeError('provider container ambiguous')
        raw=subprocess.check_output(['docker','exec',selected[0],'python','-c',"import os;from pathlib import Path;print((Path(os.environ.get('DATA_DIR','/data'))/'gateway-token.json').read_text())"])
        gateway=json.loads(raw)['token'];del raw
        q=urllib.request.Request(origin+'/v1/chat/completions',json.dumps({'model':'glm-5-3','messages':[{'role':'user','content':'Reply exactly PP_AUTH.'}],'max_tokens':64,'thinking':{'type':'disabled'},'stream':False}).encode(),{'Content-Type':'application/json','Authorization':'Bearer '+gateway},method='POST')
        with urllib.request.urlopen(q,timeout=180) as f:answer=json.load(f)
        del gateway,value
        if 'PP_AUTH' not in json.dumps(answer):raise RuntimeError('provider credential real inference did not verify')
        with urllib.request.urlopen(origin+'/api/connection',timeout=10) as f:verified=json.load(f)
        if verified.get('status')!='connected':raise RuntimeError('provider verified readback failed')
        return {'credentialStored':True,'status':'connected','authenticated_inference_completed':True}
    def rollback(self):
        data=json.loads(self.journal.read_text());assert data['attempt']==self.attempt
        if data['new_owned']:
            if URN in urns(self.rt):
                self.rt.uninstall(URN,remove_backups=False)
                deadline=time.monotonic()+180
                while URN in urns(self.rt):
                    if time.monotonic()>deadline:raise RuntimeError('private provider rollback timeout')
                    time.sleep(1)
            volume=data.get('new_volume')
            if volume:
                if volume!='wizard-tinfoil-private-'+self.attempt:raise RuntimeError('provider data volume ownership differs')
                inspect=subprocess.run(['docker','volume','inspect',volume],capture_output=True)
                if inspect.returncode==0:
                    labels=json.loads(inspect.stdout)[0].get('Labels') or {}
                    if labels.get('com.docker.compose.project')!='wizard-tinfoil_private_wizardapps':raise RuntimeError('foreign provider data volume ownership')
                    subprocess.run(['docker','volume','rm',volume],check=True,capture_output=True)
            prior=data['prior_user_config'];self.rt.req('PUT','/user-config/'+URN,{'dockerCompose':prior.get('dockerCompose') or '', 'appEnv':prior.get('appEnv') or ''})
            after=self.rt.req('GET','/user-config/'+URN)
            if any((after.get(k) or '').rstrip('\n')!=(prior.get(k) or '').rstrip('\n') for k in ['dockerCompose','appEnv']):raise RuntimeError('provider rollback user-config differs')
        if data['old_present'] and data.get('old_retired') and not data.get('old_restored'):
            if not data['backup']:raise RuntimeError('prior provider snapshot absent')
            archive=Path(data['prior_image_archive'])
            if digest(archive)!=data['prior_image_sha256']:raise RuntimeError('prior provider interpreter snapshot drift')
            existing=subprocess.run(['docker','image','inspect',data['prior_image_ref']],capture_output=True)
            if existing.returncode==0 and json.loads(existing.stdout)[0]['Id']!=data['prior_image']:raise RuntimeError('foreign prior provider image tag drift')
            subprocess.run(['docker','image','load','-i',str(archive)],check=True,capture_output=True,timeout=180)
            actual=json.loads(subprocess.check_output(['docker','image','inspect',data['prior_image_ref']]))[0]['Id']
            if actual!=data['prior_image']:raise RuntimeError('prior provider interpreter restore differs')
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            raw=(self.root/'prior-provider-form.sealed').read_bytes();seal=hashlib.sha256(b'pp-provider-form-v1\0'+Path(data['form_auth_source']).read_bytes()).digest()
            plain=AESGCM(seal).decrypt(raw[:12],raw[12:],self.attempt.encode())
            if hashlib.sha256(plain).hexdigest()!=data['old_form_sha256']:raise RuntimeError('prior app form snapshot drift')
            form=json.loads(plain);del plain,seal
            # A backup does not recreate the DB row. Install through the API
            # first, then stop and restore root-owned data/config via the API.
            if OLD not in urns(self.rt):
                self.rt.install(OLD,form);self.rt.wait_status(OLD,{'running','stopped'},timeout=180)
            self.rt.stop(OLD);self.rt.wait_status(OLD,{'stopped'},timeout=180)
            self.rt.restore_backup(OLD,data['backup']);self.rt.wait_status(OLD,{'stopped'},timeout=180)
            if data['old_status']=='running':self.rt.start(OLD);self.rt.wait_status(OLD,{'running'},timeout=180)
            if config_hash(self.rt.req('GET','/user-config/'+OLD))!=data['old_user_config_sha256']:raise RuntimeError('prior app user-config restore differs')
            restored_form=(self.rt.app(OLD).get('app') or {}).get('config') or {}
            if hashlib.sha256(json.dumps(restored_form,sort_keys=True).encode()).hexdigest()!=data['old_form_sha256']:raise RuntimeError('prior app form restore differs')
            data['old_restored']=True;atomic(self.journal,json.dumps(data).encode())
        dst=self.home/'runtipi/repos/wizardapps/apps'/ID
        if data['new_owned'] and dst.exists():
            from python_rollout import tree_hash
            if tree_hash(dst)!=data.get('source_hash'):raise RuntimeError('foreign private provider source drift; cleanup refused')
            shutil.rmtree(dst)
        from wam import cli
        cli.write_registry(cli.Config(),self.rt)
        return {'provider_restored':True,'old_present':OLD in urns(self.rt),'new_absent':URN not in urns(self.rt),'original_app_form_and_user_config_restored':data.get('old_restored') is True}
