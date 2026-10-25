#!/usr/bin/env python3
"""Package pinned source-only inputs, never data or credentials."""
import argparse,hashlib,json,subprocess,sys,tarfile
from pathlib import Path
from release_transaction import atomic
from live_sources import discover

def main():
 p=argparse.ArgumentParser(__doc__);p.add_argument('--home',type=Path,default=Path.home());p.add_argument('--provider-source',type=Path,required=True);p.add_argument('--wam-archive',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
 sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=a.provider_source,text=True).strip()
 if sha!='07eca5e30ca7873ab8cfda503175768fc55f66d4' or subprocess.check_output(['git','status','--porcelain'],cwd=a.provider_source):raise RuntimeError('provider source is not clean pinned relay-only tree')
 provider=a.output/'provider.tar'
 with provider.open('wb') as out:subprocess.run(['git','archive','HEAD'],cwd=a.provider_source,stdout=out,check=True)
 wam=a.output/'wam.tar';wam.write_bytes(a.wam_archive.read_bytes())
 with tarfile.open(wam) as tf:files={n:hashlib.sha256(tf.extractfile(n).read()).hexdigest() for n in ['wam/cli.py','wam/registry.py']}
 sources=discover(a.home);baseline=a.output/'wam-baseline.tar'
 with tarfile.open(baseline,'w') as tf:
  for route,row in sources['selected'].items():tf.add(Path(row['resolved'])/'wam',arcname=route+'/wam',filter=lambda m:None if '__pycache__' in m.name or m.name.endswith('.pyc') else m)
 result={'service_sha':'be076f491b8db8ac6963380266856f63447107f2','ux_sha':'f34c7a35a8d5f4adbca9eeb57cb83837b1664ba6','wam_sha':'0a1e01920b4700da8b4017d2bca64987e1eaebc0','wam_files':files,'provider_sha':sha}
 for name,file in [('wam',wam),('provider',provider),('wam_baseline',baseline)]:result[name+'_archive']=str(file);result[name+'_archive_sha256']=hashlib.sha256(file.read_bytes()).hexdigest()
 atomic(a.output/'assets.json',(json.dumps(result,indent=2)+'\n').encode());print(json.dumps(result,indent=2))
if __name__=='__main__':main()
