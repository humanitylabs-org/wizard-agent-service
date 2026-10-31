"""Stopped-history metadata admission; never initialize/migrate a source SessionDB.

The caller must fence writers first. Immutable SQLite avoids creating reader WAL/SHM
files; refuse nonempty recovery sidecars rather than silently ignoring their pages.
Only the active root state.db is admitted; historical profiles remain quarantined.
"""
from contextlib import closing
from pathlib import Path
import sqlite3
import stat


class HistorySchemaFailure(ValueError):
    pass


def schema_version(home):
    path = Path(home) / 'state.db'
    if not path.exists() and not path.is_symlink():
        return None
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise HistorySchemaFailure('history_schema_not_regular')
    def sidecars_absent():
        for suffix in ('-wal', '-journal'):
            sidecar = path.with_name(path.name + suffix)
            try:
                metadata = sidecar.lstat()
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size:
                raise HistorySchemaFailure('history_schema_checkpoint_required')
    sidecars_absent()
    try:
        with closing(sqlite3.connect(path.absolute().as_uri() + '?mode=ro&immutable=1', uri=True)) as db:
            db.execute('PRAGMA trusted_schema=OFF')
            db.execute('PRAGMA query_only=ON')
            tables = db.execute("SELECT type FROM sqlite_master WHERE name='schema_version'").fetchall()
            if not tables:
                raise HistorySchemaFailure('history_schema_unknown')
            else:
                if tables != [('table',)]:
                    raise HistorySchemaFailure('history_schema_invalid')
                rows = db.execute('SELECT version FROM schema_version LIMIT 2').fetchall()
                if len(rows) != 1 or type(rows[0][0]) is not int or rows[0][0] < 0:
                    raise HistorySchemaFailure('history_schema_invalid')
                version = rows[0][0]
    except sqlite3.Error:
        raise HistorySchemaFailure('history_schema_invalid') from None
    sidecars_absent()
    after = path.lstat()
    fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
    if any(getattr(before, field) != getattr(after, field) for field in fields):
        raise HistorySchemaFailure('history_schema_changed')
    return version


def require_supported(home, target_version):
    if type(target_version) is not int or target_version <= 0:
        raise HistorySchemaFailure('runtime_history_schema_unknown')
    source_version = schema_version(home)
    if source_version is not None and source_version > target_version:
        raise HistorySchemaFailure('history_schema_newer_than_runtime')
    return source_version
