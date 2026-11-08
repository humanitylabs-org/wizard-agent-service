import hashlib, json, os, sys
from pathlib import Path
root=Path.cwd()
d=json.loads((root/'source-manifest.json').read_text())
for name,expected in d['files'].items():
    if '--after-deps' in sys.argv and name=='node_modules': continue
    p=root/name
    data=os.readlink(p).encode() if p.is_symlink() else p.read_bytes()
    assert hashlib.sha256(data).hexdigest()==expected,name
print(f"PASS source manifest: {d['repository']} {d['commit']}; {len(d['files'])} tracked entries (dependency symlink excepted only after provisioning)")
