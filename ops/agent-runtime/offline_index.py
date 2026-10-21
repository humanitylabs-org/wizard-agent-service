"""Ids-only stopped index reader, also executed as uid 10000 in the restricted sidecar.

No transcript queries, writes, or dependencies outside the Python standard library.
"""
import contextlib
import json
import os
from pathlib import Path
import stat
import sys


NAMES = ("state.db", "state.db-wal", "state.db-shm")


def identity(st):
    return [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns]


def snapshot(home, include_ids=False):
    home = Path(home).resolve(strict=True)
    with contextlib.ExitStack() as stack:
        files, descriptors = {}, {}
        for name in NAMES:
            path = home / name
            try:
                before = path.lstat()
            except FileNotFoundError:
                files[name] = "absent"
                continue
            if not stat.S_ISREG(before.st_mode) or not path.resolve(strict=True).is_relative_to(home):
                raise ValueError("unsafe_index")
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            stack.callback(os.close, fd)
            opened = os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode) or identity(before) != identity(opened):
                raise ValueError("index_changed")
            files[name], descriptors[name] = identity(opened), fd
        result: dict = {"files": files}
        if include_ids:
            if "state.db" not in descriptors:
                raise ValueError("missing_index")
            path = home / "state.db"
            # SQLite must open with its own NOFOLLOW flag too; an agent-planted symlink
            # swapped after os.open must not redirect the SQLite open to an owner file.
            # Python's sqlite3 API does not expose SQLITE_OPEN_NOFOLLOW. The tiny C-API
            # reader below uses the stdlib extension or a shared SQLite on static builds.
            result["ids"] = read_ids(path)
        for name, expected in files.items():
            try:
                current = (home / name).lstat()
            except FileNotFoundError:
                current = None
            if ("absent" if current is None else identity(current)) != expected:
                raise ValueError("index_changed")
            if current is not None and not stat.S_ISREG(current.st_mode):
                raise ValueError("unsafe_index")
        return result


def read_ids(path):
    import ctypes as c
    import _sqlite3
    import ctypes.util
    library = getattr(_sqlite3, '__file__', None) or ctypes.util.find_library('sqlite3')
    if not library:
        raise ValueError('sqlite_nofollow_unavailable')
    lib = c.CDLL(library)
    lib.sqlite3_open_v2.argtypes = [c.c_char_p, c.POINTER(c.c_void_p), c.c_int, c.c_char_p]
    lib.sqlite3_close.argtypes = [c.c_void_p]
    lib.sqlite3_prepare_v2.argtypes = [c.c_void_p, c.c_char_p, c.c_int, c.POINTER(c.c_void_p), c.c_void_p]
    lib.sqlite3_step.argtypes = [c.c_void_p]
    lib.sqlite3_column_type.argtypes = [c.c_void_p, c.c_int]
    lib.sqlite3_column_bytes.argtypes = [c.c_void_p, c.c_int]
    lib.sqlite3_column_text.argtypes = [c.c_void_p, c.c_int]
    lib.sqlite3_column_text.restype = c.c_void_p
    lib.sqlite3_finalize.argtypes = [c.c_void_p]
    # READONLY | NOFOLLOW. Unsupported/old SQLite fails closed, never falls back.
    if lib.sqlite3_libversion_number() < 3031000:
        raise ValueError("sqlite_nofollow_unavailable")
    db, stmt = c.c_void_p(), c.c_void_p()
    try:
        # Force read-only SHM as well as DB/WAL. SQLite can reconstruct a private
        # WAL index for a stopped database without writing read marks to disk.
        uri = path.as_uri() + '?mode=ro&readonly_shm=1'
        if lib.sqlite3_open_v2(uri.encode(), c.byref(db), 0x00000001 | 0x00000040 | 0x01000000, None):
            raise ValueError("index_open_failed")
        # Deny views/triggers or virtual tables that could make the ids query read
        # a different table (including messages) from a malicious database schema.
        authorizer_type = c.CFUNCTYPE(c.c_int, c.c_void_p, c.c_int, c.c_char_p, c.c_char_p, c.c_char_p, c.c_char_p)
        def authorize(_, action, table, column, database, source):
            return 0 if action == 21 or (action == 20 and table == b"sessions" and column == b"id" and source is None) else 1
        authorizer = authorizer_type(authorize)
        lib.sqlite3_set_authorizer.argtypes = [c.c_void_p, authorizer_type, c.c_void_p]
        lib.sqlite3_set_authorizer(db, authorizer, None)
        if lib.sqlite3_prepare_v2(db, b"SELECT id FROM sessions LIMIT 100001", -1, c.byref(stmt), None):
            raise ValueError("index_query_failed")
        ids = []
        while True:
            status = lib.sqlite3_step(stmt)
            if status == 101:  # SQLITE_DONE
                return ids
            if status != 100 or len(ids) >= 100000 or lib.sqlite3_column_type(stmt, 0) != 3:
                raise ValueError("invalid_index")
            size = lib.sqlite3_column_bytes(stmt, 0)
            if size < 1 or size > 800:
                raise ValueError("invalid_id")
            sid = c.string_at(lib.sqlite3_column_text(stmt, 0), size).decode("utf-8")
            if not sid or len(sid) > 200:
                raise ValueError("invalid_id")
            ids.append(sid)
    finally:
        if stmt:
            lib.sqlite3_finalize(stmt)
        if db:
            lib.sqlite3_close(db)


if __name__ == "__main__":
    try:
        print(json.dumps(snapshot(sys.argv[1], len(sys.argv) > 2 and sys.argv[2] == "ids")))
    except Exception:
        # Never echo paths, database bytes, or exception details from an agent home.
        raise SystemExit("offline_index_unavailable") from None
