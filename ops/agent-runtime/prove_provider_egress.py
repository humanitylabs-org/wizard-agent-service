"""Disposable Docker proof. All resources pp-test-; no host firewall changes.
Run: python prove_provider_egress.py [--key-env /path/to/existing/key.env]
Images: pp-test-egress-{proxy,tinfoil,client}, built from named pushed commits.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import time
import urllib.error
import urllib.request
from provider_egress import ProviderEgress

PREFIX='pp-test-egress'
containers=[]; networks=[]

def docker(args, check=True, timeout=90):
    result=subprocess.run(['docker',*args],capture_output=True,text=True,timeout=timeout)
    if check and result.returncode:
        raise RuntimeError('docker '+args[0]+' failed: '+result.stderr[:400])
    return result

class Failure(Exception):
    def __init__(self,code,status=500): super().__init__(code); self.code=code

def request(url, data=None, method=None, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                method=method, headers={'Content-Type':'application/json',**(headers or {})}), timeout=180) as response:
        return json.load(response)

def ready(url):
    for _ in range(80):
        try: return request(url)
        except (OSError,ValueError): time.sleep(.25)
    raise RuntimeError('health timeout')

def network(name,subnet=None):
    networks.append(name)
    docker(['network','create','--internal','--opt','com.docker.network.bridge.inhibit_ipv4=true',*(['--subnet',subnet] if subnet else []),name])
    return name

def exec_python(name,code):
    result=docker(['exec',name,'python','-c',code],check=False,timeout=180)
    if result.returncode: raise RuntimeError('container probe failed: '+result.stdout[:500]+result.stderr[:500])
    print(result.stdout.strip(),flush=True)

def make_provider(app_id,local=False,real=False):
    relay=network(PREFIX+'-relay-'+app_id,'10.252.246.0/24' if local else ('10.252.247.0/24' if real else '10.252.245.0/24'))
    boot=network(PREFIX+'-boot-'+app_id)
    name=PREFIX+'-app-'+app_id; containers.append(name)
    app={'id':app_id,'private_inference':{'kind':'local' if local else 'attested-relay','relay_port':8090,
         'egress':[] if local else ['inference.tinfoil.sh','atc.tinfoil.sh'] + (['tuf-repo-cdn.sigstore.dev'] if real else [])}}
    args=['create','--name',name,'--network',boot,'--restart','no','--read-only','--cap-drop','ALL',
          '--security-opt','no-new-privileges:true','--dns','127.0.0.1','--tmpfs','/tmp:uid=1000,gid=1000',
          '--tmpfs','/data:uid=1000,gid=1000','--user','1000:1000']
    if not local: args+=['-e','HTTPS_PROXY=http://wizard-egress-proxy:3128']
    if real:
        with socket.socket() as s: s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
        origin='http://127.0.0.1:'+str(port)
        app['view']={'local':origin}
        args+=['-p',f'127.0.0.1:{port}:18804','-e','WIZARD_TRUSTED_HOSTS=127.0.0.1:'+str(port),
               '-e','WIZARD_TRUSTED_ORIGINS='+origin]
    else: origin=None
    args+=['pp-test-egress-tinfoil']
    if not real: args+=['python','-c','import time; time.sleep(1800)']
    docker(args)
    docker(['network','connect','--alias','wizard-tinfoil-relay',relay,name])
    mgr=ProviderEgress(docker,Failure,namespace='pp-test',image='pp-test-egress-proxy')
    egress='pp-test-egress-'+app_id; networks.append(egress)
    containers.extend(['pp-test-egress-proxy-'+app_id,'pp-test-provider-edge-'+app_id])
    print('RECONCILE',json.dumps(mgr.reconcile(app,name,relay)),flush=True)
    info=json.loads(docker(['inspect',name]).stdout)[0]
    assert set(info['NetworkSettings']['Networks'])=={egress,relay}
    print('PROVIDER_NETWORKS',json.dumps(list(info['NetworkSettings']['Networks'])),flush=True)
    return app,name,relay,mgr,origin

DIRECT="""
import socket
for host,port in [('1.1.1.1',443),('1.1.1.1',80),('2606:4700:4700::1111',443),('172.17.0.1',80)]:
    try:
        s=socket.create_connection((host,port),timeout=3); s.close()
        raise AssertionError('direct egress succeeded')
    except OSError: print('DIRECT_BLOCKED',host,port)
try:
    socket.getaddrinfo('example.com',443)
    raise AssertionError('external DNS escaped')
except socket.gaierror: print('EXTERNAL_DNS_BLOCKED')
"""
PROXY="""
import http.client,ssl,socket
for host in ['inference.tinfoil.sh','atc.tinfoil.sh']:
    c=http.client.HTTPSConnection('wizard-egress-proxy',3128,timeout=30)
    c.set_tunnel(host,443); c.request('GET','/attestation' if host.startswith('atc.') else '/')
    r=c.getresponse(); print('ALLOWED_TLS',host,r.status); r.read(); c.close()
for target in ['example.com:443','1.1.1.1:443','[::1]:443','inference.tinfoil.sh:80']:
    with socket.create_connection(('wizard-egress-proxy',3128),timeout=5) as s:
        s.sendall(('CONNECT '+target+' HTTP/1.1\\r\\nHost: '+target+'\\r\\n\\r\\n').encode())
        assert b'403 Forbidden' in s.recv(1024),target
        print('REFUSED_CONNECT',target)
with socket.create_connection(('wizard-egress-proxy',3128),timeout=5) as s:
    s.sendall(b'GET http://inference.tinfoil.sh/ HTTP/1.1\\r\\n\\r\\n')
    assert b'403 Forbidden' in s.recv(1024); print('PLAIN_HTTP_REFUSED')
"""

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--key-env',type=Path); args=ap.parse_args()
    try:
        app,name,relay,mgr,origin=make_provider('standin')
        exec_python(name,DIRECT); exec_python(name,PROXY)
        print('RECONCILE_RESTART',json.dumps(mgr.reconcile(app,name,relay)),flush=True)
        exec_python(name,DIRECT); exec_python(name,PROXY)
        app,local,_,_,local_origin=make_provider('local',local=True,real=True)
        ready(local_origin+'/healthz')
        exec_python(local,"import socket; sock=socket.socket(); sock.settimeout(2); assert sock.connect_ex(('wizard-provider-ingress',3128)) != 0; sock.close(); print('LOCAL_INGRESS_NO_CONNECT_LISTENER')")
        assert docker(['inspect','pp-test-egress-proxy-local'],check=False).returncode!=0
        exec_python(local,DIRECT); print('LOCAL_NO_PROXY_PASS',flush=True)
        if args.key_env:
            app,name,relay,mgr,origin=make_provider('real',real=True)
            ready(origin+'/healthz')
            probe=docker(['exec',name,'python','-c',"from app.provider import proxy_client; proxy_client('nonsecret-probe',30)"],check=False)
            if probe.returncode:
                print('SDK_DIAGNOSTIC',probe.stderr,flush=True)
                raise RuntimeError('SDK setup failed before loading real key')
            # Isolated app's tmpfs is the only saved copy. Key never in CLI/env/docker config.
            values=dict(line.split('=',1) for line in args.key_env.read_text().splitlines() if '=' in line and not line.startswith('#'))
            os.environ['PP_TEST_KEY']=next(value.strip().strip('"').strip("'") for key,value in values.items() if 'KEY' in key)
            headers={'Origin':origin,'X-Wizard-Request':'1'}
            try:
                try:
                    result=request(origin+'/api/connect',{'apiKey':os.environ['PP_TEST_KEY']},headers=headers)
                except urllib.error.HTTPError as error:
                    print('KEY_SAVE_FAILED',error.code,error.read().decode(),flush=True)
                    check=docker(['exec',name,'python','-c',"from app.provider import run; run('verify',{'key':'nonsecret-probe'})"],check=False)
                    print('SDK_VERIFY_DIAGNOSTIC',check.stderr,flush=True)
                    raise
            finally:
                os.environ.pop('PP_TEST_KEY',None); values.clear()
            print('KEY_SAVE',json.dumps({k:v for k,v in result.items() if k in ('status','credentialStored','credentialVerified')}),flush=True)
            status=request(origin+'/api/connection'); assert status['credentialStored'] and status['models']
            token=request(origin+'/api/private-clients',{'agent':'pp-test-client'},headers=headers)['token']
            models=[m['id'] if isinstance(m,dict) else m for m in status['models']]
            print('AVAILABLE_CHAT_MODELS',json.dumps(models),flush=True)
            model=next((m for m in ('llama3-3-70b','gpt-oss-120b','deepseek-v4-1-flash','kimi-k3') if m in models),models[0])
            client=PREFIX+'-client'; containers.append(client)
            # Secret relay token goes over stdin into tmpfs, never docker args/config or host file.
            docker(['create','--name',client,'--network',relay,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true',
                    '--tmpfs','/run/wizard:uid=1000,gid=1000,mode=0700','--tmpfs','/tmp:uid=1000,gid=1000',
                    '-e','PROFILE=tinfoil','-e','RELAY_URL=http://wizard-tinfoil-relay:8090','-e','RELAY_TOKEN_FILE=/run/wizard/relay-token',
                    '-e','MODELS='+model,'--entrypoint','sh','pp-test-egress-client','-c',
                    'while [ ! -s /run/wizard/relay-token ]; do sleep 0.1; done; exec node /app/server.mjs'])
            docker(['start',client])
            result=subprocess.run(['docker','exec','-i',client,'sh','-c','umask 077; cat > /run/wizard/relay-token'],input=token,capture_output=True,text=True,timeout=30)
            assert result.returncode==0; token=None
            docker(['exec',client,'node','--input-type=module','-e',
                    "for(let i=0;i<100;i++){try{let r=await fetch('http://127.0.0.1:3301/healthz');if(r.ok)process.exit(0)}catch{} await new Promise(r=>setTimeout(r,100));}process.exit(1)"])

            codeword='PRIVPROBE-'+secrets.token_hex(12)
            # Client has no published ports: initiate within its own namespace, not from host.
            payload={'model':model,'messages':[{'role':'user','content':'Reply exactly '+codeword}], 'max_tokens':60}
            response=docker(['exec',client,'node','--input-type=module','-e',
                            "const r=await fetch('http://127.0.0.1:3301/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify("+json.dumps(payload)+")}); console.log(JSON.stringify({status:r.status,body:await r.json()}));"],timeout=180)
            parsed=json.loads(response.stdout)
            if parsed['status']!=200:
                debug=docker(['exec',client,'node','--input-type=module','-e',
                              "import {AttestedRelay,configFromEnv} from '/app/server.mjs';try{const r=await new AttestedRelay(configFromEnv()).ready();console.log('ATTESTED_ENCLAVE',r.enclave)}catch(e){console.log('ATTESTATION_DIAGNOSTIC',e.name,e.message)}"],check=False)
                print(debug.stdout,debug.stderr,flush=True)
                diagnostic=docker(['exec',client,'node','--input-type=module','-e',
                    "import {AttestedRelay,configFromEnv} from '/app/server.mjs';try{const r=await new AttestedRelay(configFromEnv()).request(JSON.stringify({model:'llama3-3-70b',messages:[{role:'user',content:'Say OK'}],max_tokens:10}));console.log('UPSTREAM_DIAGNOSTIC',r.status,!!r.headers.get('Ehbp-Response-Nonce'))}catch(e){console.log('TRANSPORT_DIAGNOSTIC',e.name,e.message)}"],check=False)
                print(diagnostic.stdout,diagnostic.stderr,flush=True)
                print('PROXY_HOST_AUDIT',docker(['logs','pp-test-egress-proxy-real']).stdout.strip(),flush=True)
            assert parsed['status']==200,parsed
            assert codeword in parsed['body']['choices'][0]['message']['content']
            print('REAL_RELAY_COMPLETION_PASS',model,flush=True)
            exec_python(name,"from app.server import worker,stored; result=worker('infer',stored()['key'],{'model':'llama3-3-70b','messages':[{'role':'user','content':'Reply exactly OK'}],'max_tokens':10}); assert 'OK' in result['choices'][0]['message']['content']; print('OFFICIAL_PYTHON_SDK_EHBP_PROXY_PASS')")
            exec_python(name,"from pathlib import Path; probe="+repr(codeword.encode())+"; assert all(probe not in p.read_bytes() for p in Path('/data').rglob('*') if p.is_file()); print('NO_CODEWORD_IN_PROVIDER_DATA')")
            for target in [name,'pp-test-egress-proxy-real']:
                logs=docker(['logs',target]).stdout+docker(['logs',target]).stderr
                assert codeword not in logs
            print('NO_CODEWORD_IN_APP_OR_PROXY_LOGS',flush=True)
            print('PROXY_HOST_AUDIT',docker(['logs','pp-test-egress-proxy-real']).stdout.strip(),flush=True)
    finally:
        for name in reversed(containers): docker(['rm','-f',name],check=False)
        for name in reversed(networks): docker(['network','rm',name],check=False)
        print('CLEANUP_COMPLETE',flush=True)

if __name__=='__main__': main()
