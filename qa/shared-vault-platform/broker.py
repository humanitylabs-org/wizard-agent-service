"""Forum container fixture. Real app HTTP/Broker/Bitwarden adapter; labeled fake CLI only.
Never imports owner profiles or runs the real provider. Container has network_mode=none.
"""
import json
import os
from pathlib import Path
import runpy
import sys

root = Path(os.environ['SV_STAGE_ROOT'])
assert str(root).startswith('/srv/work/') and os.geteuid() == 10002
sys.path[:0] = ['/fixture/vault/tests', '/fixture/vault/app']
import fixtures
if '--init' in sys.argv:
    cfg = fixtures.make(root / 'broker' / 'fixture')
    (root / 'broker' / 'data').mkdir(mode=0o700)
    (root / 'broker' / 'fixture' / 'config.json').write_text(json.dumps(cfg))
else:
    os.environ.update(DATA_DIR=str(root / 'broker' / 'data'),
                      SHARED_VAULT_CONFIG=str(root / 'broker' / 'fixture' / 'config.json'), BIND='127.0.0.1')
    runpy.run_path('/fixture/vault/app/server.py', run_name='__main__')
