"""Stopped importer tree operations; never traverse symlinks or shared inodes.

Ownership itself is the durable checkpoint: a restarted pass stats each entry
and only chowns mismatches. Memory is bounded by one directory, not tree size.
The same source is sent to the existing constrained home-init Docker helper.
"""
import json
import os
import shutil
import stat
import fcntl
import signal
from contextlib import contextmanager


@contextmanager
def read_lease(fd):
    """Fence writes through ANY inode alias, not only names under the home.

    Fail closed on filesystems/platforms without kernel leases. SIGIO aborts a
    copy as soon as any writer requests a lease break; F_GETLEASE also catches
    a forced break (including while Python was inside a long blocking read).
    """
    if not hasattr(fcntl, 'F_SETLEASE'):
        raise ValueError('hardlink_read_lease_unavailable')
    def interrupted(signum, frame):
        raise ValueError('hardlink_writer_requested')
    previous = signal.signal(signal.SIGIO, interrupted)
    held = False
    try:
        fcntl.fcntl(fd, fcntl.F_SETOWN, os.getpid())
        try:
            fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_RDLCK)
            held = True
        except BlockingIOError:
            raise ValueError('hardlink_has_writers') from None
        except OSError:
            raise ValueError('hardlink_read_lease_unavailable') from None
        before = os.fstat(fd)
        yield
        after = os.fstat(fd)
        if fcntl.fcntl(fd, fcntl.F_GETLEASE) != fcntl.F_RDLCK or (
                before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('hardlink_source_changed')
    finally:
        try:
            if held:
                fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
        finally:
            signal.signal(signal.SIGIO, previous)


def walk(root):
    if stat.S_ISLNK(os.lstat(root).st_mode):
        raise ValueError('ownership_root_symlink')
    def fail(error):
        raise error
    for base, dirs, names, fd in os.fwalk(root, follow_symlinks=False, onerror=fail):
        # fwalk does not descend into symlinks. Include directory links once as
        # entries, but never their targets. Directory metadata is yielded once.
        yield '.', fd, os.stat('.', dir_fd=fd, follow_symlinks=False)
        for name in names + [d for d in dirs if stat.S_ISLNK(os.stat(d, dir_fd=fd, follow_symlinks=False).st_mode)]:
            yield name, fd, os.stat(name, dir_fd=fd, follow_symlinks=False)


def detach_hardlinks(root):
    """Atomic private copies, including aliases whose other names are outside.

    Do not seek or follow other names of the inode. Unlinking the imported name
    cannot modify the bytes/mode/ownership of an external alias. DB inodes with
    one link are untouched. An interrupted temp file is harmless passive data.
    """
    copied = 0
    for name, directory, s in walk(root):
        if not stat.S_ISREG(s.st_mode) or s.st_nlink == 1:
            continue
        src = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        temp = '.wizard-import-copy-' + os.urandom(12).hex()
        try:
            current = os.fstat(src)
            if (current.st_dev, current.st_ino) != (s.st_dev, s.st_ino):
                raise ValueError('hardlink_source_changed')
            with read_lease(src):
                dest = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                               0o600, dir_fd=directory)
                with os.fdopen(dest, 'wb') as out, os.fdopen(os.dup(src), 'rb') as incoming:
                    shutil.copyfileobj(incoming, out, 1024 * 1024)
                    out.flush()
                    os.fchmod(out.fileno(), stat.S_IMODE(s.st_mode))
                    os.utime(out.fileno(), ns=(s.st_atime_ns, s.st_mtime_ns))
                    os.fsync(out.fileno())
            os.replace(temp, name, src_dir_fd=directory, dst_dir_fd=directory)
            os.fsync(directory)
            copied += 1
        finally:
            os.close(src)
            try:
                os.unlink(temp, dir_fd=directory)
            except FileNotFoundError:
                pass
    return copied


def ownership(root, uid, gid=None, *, dry_run=False):
    """One process, fd-relative no-follow stat/chown, idempotent after death.

    The stopped home is the only bind mount; callers must exclude live runtimes.
    Shared inodes MUST be detached before this operation, even if ownership
    already matches, to prevent subsequent runtime writes through outside aliases.
    """
    if gid is None:
        gid = uid
    result = {'entries': 0, 'needs_change': 0, 'changed': 0, 'hardlinked_files': 0}
    for name, directory, s in walk(root):
        result['entries'] += 1
        shared = stat.S_ISREG(s.st_mode) and s.st_nlink > 1
        result['hardlinked_files'] += int(shared)
        if shared and not dry_run:
            raise ValueError('ownership_shared_inode')
        if (s.st_uid, s.st_gid) != (uid, gid):
            result['needs_change'] += 1
            if not dry_run:
                os.chown(name, uid, gid, dir_fd=directory, follow_symlinks=False)
                result['changed'] += 1
    return result


if __name__ == '__main__':
    import sys
    options = json.load(sys.stdin)
    print(json.dumps(ownership('/opt/data', **options)))
