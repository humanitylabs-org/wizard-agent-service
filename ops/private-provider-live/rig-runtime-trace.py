#!/usr/bin/env python3
"""Fixture-only passive diagnostics; preserve subprocess results unchanged."""
import json,os,re,runpy,subprocess,sys
from pathlib import Path
assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers' and os.geteuid()==1000
original=subprocess.run

def traced(*args,**kwargs):
    result=original(*args,**kwargs)
    argv=args[0] if args else kwargs.get('args',[])
    if result.returncode and isinstance(argv,list) and argv and Path(str(argv[0])).name in ('docker','sg'):
        text=result.stderr or ''
        if isinstance(text,bytes):text=text.decode(errors='replace')
        for k,v in (kwargs.get('env') or {}).items():
            if v and re.search('key|token|secret',k,re.I):text=text.replace(v,'[redacted]')
        source=Path('/home/rig/pp-launch-3/legacy-key.env')
        if source.exists():
            for line in source.read_text().splitlines():
                if line.startswith('TINFOIL_API_KEY='):
                    value=line.split('=',1)[1].strip().strip('\"\'')
                    if value:text=text.replace(value,'[redacted]')
        safe='\n'.join(x for x in text.splitlines() if not re.search('key|token|secret',x,re.I))[-4000:]
        root=Path('/home/rig/pp-live-receipts');root.mkdir(exist_ok=True)
        with (root/'docker-diagnostics.jsonl').open('a') as f:f.write(json.dumps({'returncode':result.returncode,'stderr':safe})+'\n')
    return result
subprocess.run=traced
sys.argv=sys.argv[1:]
sys.path.insert(0,str(Path(sys.argv[0]).resolve().parent))
runpy.run_path(sys.argv[0],run_name='__main__')
