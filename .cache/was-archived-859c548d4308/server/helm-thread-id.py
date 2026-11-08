#!/usr/bin/env python3
"""Resolve the public Helm projection id for a Hermes session."""

import hashlib
import re
import sys


session_id = sys.argv[1] if len(sys.argv) == 2 else ""
if not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", session_id):
    raise SystemExit(2)
digest = hashlib.blake2s(f"helm-session:{session_id}".encode(), digest_size=6).hexdigest()
print(f"t-{digest}")