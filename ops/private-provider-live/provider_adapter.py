"""API-only private provider installation and exact prior-app restore.

All filesystem writes stay inside owner-writable repos/wizardapps/apps/. Generated
Runtipi files are NEVER written. No daemon image/Compose route is present here.
"""
import hashlib
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
    def snapshot(self):
        installed=urns(self.rt)
        if URN in installed:raise RuntimeError('private provider already installed by another attempt')
        before=self.rt.req('GET','/user-config/'+URN)
        if not blank_config(before):raise RuntimeError('foreign private provider user-config')
        old=installed.get(OLD)
        data={'attempt':self.attempt,'old_present':bool(old),'old_status':(old or {}).get('info',{}).get('status'),'backup':None,'new_owned':False,'prior_user_config':before}
        atomic(self.journal,json.dumps(data).encode());return {'old_present':bool(old),'new_present':False,'user_config_readback':True}
    def install(self,archive,expected_sha):
        import yaml
        from wam import cli
        if digest(archive)!=expected_sha:raise RuntimeError('provider source drift')
        data=json.loads(self.journal.read_text());assert data['attempt']==self.attempt
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
        svc=comp['services']['wizard-tinfoil'];assert comp.pop('volumes')=={'tinfoil-private-data':{'name':'wizard-tinfoil-private-data'}}
        assert svc.pop('volumes')==['tinfoil-private-data:/data']
        svc['volumes']=[str(release)+':/app:ro'];svc['ports']=['127.0.0.1:${APP_PORT}:18804']
        for n,raw in [('wizard.md',(src/'wizard.md').read_bytes()),('config.json',json.dumps(cfg).encode()),('docker-compose.yml',yaml.safe_dump(comp,sort_keys=False).encode()),('.wizard-commit',(SHA+'\n').encode()),('.wizard-source',json.dumps({'repo':'local:'+ID,'private':True}).encode())]:atomic(dst/n,raw,0o644)
        shutil.copy2(src/'runtipi/metadata/logo.jpg',dst/'metadata/logo.jpg');atomic(dst/'metadata/description.md',b'Private relay-only provider\n',0o644)
        # Prove the immutable interpreter image has identical dependencies before
        # installing source at /app; never replace the Runtipi daemon image.
        import subprocess
        p=subprocess.run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--entrypoint','python',svc['image'],'-c','from pathlib import Path;import hashlib;print(hashlib.sha256(Path("/app/requirements.lock").read_bytes()).hexdigest())'],capture_output=True,text=True,timeout=90)
        if p.returncode or p.stdout.strip()!=digest(src/'requirements.lock'):raise RuntimeError('provider interpreter dependency parity absent')
        data['source_hash']=__import__('python_rollout').tree_hash(dst)
        data['new_owned']=True;atomic(self.journal,json.dumps(data).encode())
        prior=data['prior_user_config'];env=prior.get('appEnv') or ''
        self.rt.req('PUT','/user-config/'+URN,{'dockerCompose':OVERRIDE,'appEnv':env})
        after=self.rt.req('GET','/user-config/'+URN)
        if (after.get('dockerCompose') or '').rstrip('\n')!=OVERRIDE.rstrip('\n') or (after.get('appEnv') or '').rstrip('\n')!=env.rstrip('\n'):raise RuntimeError('provider API override readback failed')
        self.rt.install(URN,FORM)
        status=self.rt.wait_status(URN,{'running','stopped'},timeout=180)
        if status!='running':raise RuntimeError('provider did not start')
        cfg=cli.Config();registry=cli.write_registry(cfg,self.rt)
        rows=[x for x in registry['apps'] if x.get('id')=='wizard-tinfoil']
        if len(rows)!=1 or rows[0].get('urn')!=URN or not rows[0].get('private_inference'):raise RuntimeError('canonical provider registry readback failed')
        return {'urn':URN,'override_api_readback':True,'status':status,'source_sha':SHA,'dependency_parity':True,'canonical_registry_unique':True}
    def connect(self,runtime_source,legacy_source):
        sys.path.insert(0,str(runtime_source))
        from agent_runtime import Agents
        failures=Agents(self.home/'.wizard-os/agents',apps_path=self.home/'.wizard-os/apps.json').providers.reconcile_installed()
        if failures:raise RuntimeError('provider egress reconciliation failed')
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
        import subprocess
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
            prior=data['prior_user_config'];self.rt.req('PUT','/user-config/'+URN,{'dockerCompose':prior.get('dockerCompose') or '', 'appEnv':prior.get('appEnv') or ''})
            after=self.rt.req('GET','/user-config/'+URN)
            if any((after.get(k) or '').rstrip('\n')!=(prior.get(k) or '').rstrip('\n') for k in ['dockerCompose','appEnv']):raise RuntimeError('provider rollback user-config differs')
        if data['old_present'] and OLD not in urns(self.rt):
            if not data['backup']:raise RuntimeError('prior provider snapshot absent')
            self.rt.restore_backup(OLD,data['backup'])
            status=self.rt.wait_status(OLD,{'running','stopped'},timeout=180)
            if data['old_status']=='running' and status!='running':self.rt.start(OLD);self.rt.wait_status(OLD,{'running'},timeout=180)
        dst=self.home/'runtipi/repos/wizardapps/apps'/ID
        if data['new_owned'] and dst.exists():
            from python_rollout import tree_hash
            if tree_hash(dst)!=data.get('source_hash'):raise RuntimeError('foreign private provider source drift; cleanup refused')
            shutil.rmtree(dst)
        from wam import cli
        cli.write_registry(cli.Config(),self.rt)
        return {'provider_restored':True,'old_present':OLD in urns(self.rt),'new_absent':URN not in urns(self.rt)}
