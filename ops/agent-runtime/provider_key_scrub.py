"""Stopped-agent plaintext retirement. Receipts contain paths/counts, never credentials.

No plaintext undo copy is created. Until the registry publishes the seal, the old
record can be restarted using Agents.add_provider_keys and its host-side source.
A killed scrub leaves a pending receipt and is safe to repeat before publication.
"""
import json
import os
from pathlib import Path
import re
import secrets
import stat

ASSIGN = re.compile(rb'(?m)^[ \t]*(?:export[ \t]+)?TINFOIL_API_KEY[ \t]*=[ \t]*([^\r\n]*)')


def atomic(path, data, mode=0o600, identity=None):
    tmp = path.with_name('.wizard-scrub-' + secrets.token_hex(12))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            if identity and (os.getuid(), os.getgid()) != identity:
                os.fchown(out.fileno(), *identity)
            os.fchmod(out.fileno(), mode)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
        d = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(d)
        finally:
            os.close(d)
    finally:
        tmp.unlink(missing_ok=True)


def scrub(home, receipt, source_key):
    """Caller must hold lifecycle lock and stop all writers before calling."""
    home, receipt = Path(home), Path(receipt)
    if home.is_symlink() or not home.is_dir():
        raise ValueError('unsafe agent home')
    receipt.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    prior = json.loads(receipt.read_text()) if receipt.exists() else {}
    touched = set(prior.get('paths', []))
    def save(status):
        doc = {'schema': 1, 'status': status, 'count': len(touched), 'paths': sorted(touched)}
        atomic(receipt, (json.dumps(doc, sort_keys=True) + '\n').encode())
        return doc
    save('pending')
    paths, keys = [], {source_key.encode()} if source_key else set()
    def failed(error):
        raise error
    # Do not mutate external symlink targets (especially the host legacy source).
    # File aliases to a credential are unlinked instead. Never follow directory links.
    for directory, dirs, names in os.walk(home, followlinks=False, onerror=failed):
        for name in dirs[:]:
            p = Path(directory) / name
            if p.is_symlink():
                dirs.remove(name)
                # A directory alias can expose an arbitrary external credential tree.
                rel = str(p.relative_to(home)); touched.add(rel); save('pending'); p.unlink()
        for name in names:
            p = Path(directory) / name
            if p.is_symlink() and not p.is_file():
                continue
            if not p.is_symlink() and not stat.S_ISREG(p.lstat().st_mode):
                raise ValueError('non-regular agent home entry')
            data = p.read_bytes()
            for match in ASSIGN.finditer(data):
                key = match[1].strip().strip(b'\"\'')
                if key and key != b'[REDACTED]':
                    keys.add(key)
            paths.append(p)
    # Discover every assignment value before rewriting any file, so backups with
    # an older credential also retire byte-only copies elsewhere in this home.
    def rewrite(p, data, clean):
        if clean == data:
            return
        touched.add(str(p.relative_to(home))); save('pending')
        if p.is_symlink():
            p.unlink()
        else:
            st = p.stat()
            atomic(p, clean, stat.S_IMODE(st.st_mode), (st.st_uid, st.st_gid))
    for key in sorted(keys, key=len, reverse=True):
        existing = [p for p in paths if p.exists()]
        # Retain at least one assignment containing this value until every
        # byte-only copy is retired. A crash can rediscover it on the next pass.
        existing.sort(key=lambda p: any(key in m[1] for m in ASSIGN.finditer(p.read_bytes())))
        for p in existing:
            data = p.read_bytes()
            rewrite(p, data, data.replace(key, b'[REDACTED]'))
    for p in paths:
        if p.exists():
            data = p.read_bytes()
            rewrite(p, data, ASSIGN.sub(b'', data))
    # A second full pass is mandatory before a completed receipt is published.
    for p in paths:
        if not p.exists():
            continue
        data = p.read_bytes()
        if ASSIGN.search(data) or any(key in data for key in keys):
            raise ValueError('credential retirement incomplete')
    return save('completed')
