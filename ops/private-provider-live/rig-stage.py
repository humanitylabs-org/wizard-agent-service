#!/usr/bin/env python3
"""Rig-only selection of an actually tested Thales artifact, never a fake stage."""
import hashlib,json,os
from pathlib import Path
assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers'
ctx=json.loads(Path(os.environ['PP_LAUNCH_CONTEXT']).read_text());root=Path('/home/rig/pp-live-assets')
saved=json.loads((root/'stage.json').read_text());artifact=root/'candidate.tar.gz'
assert saved['status']=='passed' and saved['focused_suites_passed'] is True
assert saved['base_sha']==ctx['live']['releases']['service']['sha']
assert hashlib.sha256(artifact.read_bytes()).hexdigest()==saved['artifact_sha256']
saved.update(attempt=ctx['attempt'],operation='stage',local_artifact=str(artifact),source='actual Thales focused-suite receipt, same source/artifact')
out=Path(os.environ['PP_LAUNCH_RECEIPTS']);(out/'stage.json').write_text(json.dumps(saved,indent=2)+'\n')
