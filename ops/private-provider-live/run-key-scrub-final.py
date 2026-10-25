#!/usr/bin/env python3
"""Single final pp-key-scrub attempt under the durable worker's inherited lock."""
from pathlib import Path
import os
import stat
import subprocess
import sys

L = Path('/Volumes/ThalesMedia/AI-Wizards/private-providers/pp-launch/live')
p = L / '.pp-key-scrub-14.env'
assert Path.cwd() == L
st = p.lstat()
assert stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and stat.S_IMODE(st.st_mode) == 0o600
key = p.read_bytes()
p.unlink()
try:
    assert key and b'TINFOIL_API_KEY=' in key
    result = subprocess.run([sys.executable, str(L / 'legacy-lane.py'), '14'], input=key)
finally:
    key = b''
    p.unlink(missing_ok=True)
assert not p.exists()
print('HOST_STAGED_CREDENTIAL_ABSENT', flush=True)
sys.exit(result.returncode)
