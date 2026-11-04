"""Write a crash image into <home>: rollback-journal state.db with a hot -journal.
Committed state contains wizard_secondary_committed; the interrupted (uncommitted) transaction deletes it."""
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

home = Path(sys.argv[1])
clean = len(sys.argv) > 2 and sys.argv[2] == 'clean'
for name in ('state.db', 'state.db-journal', 'state.db-wal', 'state.db-shm'):
    (home / name).unlink(missing_ok=True)
src = Path(tempfile.mkdtemp(dir=sys.argv[3] if len(sys.argv) > 3 else None))
db = sqlite3.connect(src / 'state.db', isolation_level=None)
db.execute('PRAGMA journal_mode=DELETE')
db.execute('PRAGMA cache_size=1')
db.execute('CREATE TABLE sessions(id TEXT PRIMARY KEY, pad TEXT)')
db.execute("INSERT INTO sessions VALUES('wizard_secondary_committed', '')")
db.executemany('INSERT INTO sessions VALUES(?, ?)', [(f'wizard_c{i:04d}', 'x' * 400) for i in range(300)])
if not clean:
    db.execute('BEGIN')
    db.execute("DELETE FROM sessions WHERE id='wizard_secondary_committed'")
    db.executemany('INSERT INTO sessions VALUES(?, ?)', [(f'wizard_u{i:04d}', 'y' * 400) for i in range(300)])
for p in src.iterdir():
    shutil.copy2(p, home / p.name)
db.close()
shutil.rmtree(src)
print(sorted(p.name for p in home.iterdir()))
