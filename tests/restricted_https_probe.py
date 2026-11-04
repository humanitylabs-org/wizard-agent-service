#!/usr/bin/env python3
"""Public HTTPS positive controls through an already-built egress image (no auth)."""
import argparse
import subprocess

CODE = r'''
import asyncio,http.client,json,os,ssl,sys
sys.path.insert(0,'/srv')
import egress

def request(host,port):
 c=http.client.HTTPSConnection('127.0.0.1',port,timeout=20,context=ssl.create_default_context())
 c.set_tunnel(host,443)
 c.request('GET','/',headers={'User-Agent':'wizard-restricted-egress-acceptance'})
 r=c.getresponse(); status=r.status; r.read(4096); c.close()
 assert status==200,(host,status)
 return {'host':host,'status':status,'tls_verified':True,'credentials_used':False}

async def main():
 server=await asyncio.start_server(egress.handle,'127.0.0.1',0)
 async with server:
  for host in ('github.com','api.github.com'):
   print(json.dumps(await asyncio.to_thread(request,host,server.sockets[0].getsockname()[1])),flush=True)
asyncio.run(main())
'''

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--image', required=True)
    a = p.parse_args()
    result = subprocess.run(['docker', 'run', '--rm', '-i', '--network', 'bridge', '--read-only',
                             '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                             '--user', '65534:65534', '--pids-limit', '32', '--memory', '128m',
                             '-e', 'EGRESS_ALLOWLIST_HOSTS=github.com api.github.com',
                             '--entrypoint', 'python3', a.image, '-'], input=CODE, text=True, timeout=60)
    raise SystemExit(result.returncode)
