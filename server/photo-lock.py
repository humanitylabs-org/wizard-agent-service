#!/usr/bin/env python3
"""OS-released flock. Parent pipe EOF releases it even after SIGKILL."""
import fcntl
import os
import sys
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(75)
print('locked', flush=True)
sys.stdin.buffer.read()
os.close(fd)
