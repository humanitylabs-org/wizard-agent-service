"""Resolve only individually reviewed, byte-identical candidate merge hunks.

No ours/theirs fallback: an unreviewed hunk or path blocks staging before writes.
The reviewed choices retain live chat layout/agent-owned Spaces/status filing,
provider admission/pending steer replay, and stricter calendar validation.
"""
import hashlib
import json
import re
from pathlib import Path

BLOCK = re.compile(r'^<<<<<<< HEAD\n(.*?)^=======\n(.*?)^>>>>>>> ([0-9a-f]{40})\n', re.M | re.S)


def resolve(root, paths, manifest=None):
    root = Path(root).resolve()
    data = json.loads((Path(manifest) if manifest else Path(__file__).with_name('merge-resolutions.json')).read_text())
    approved = {(row['path'], row['sha256']): row['replacement'] for row in data['resolutions']}
    pending = {}
    used = []
    for name in paths:
        target = root / name
        if not target.resolve().is_relative_to(root) or target.is_symlink():
            raise ValueError('unsafe conflicted path')
        text = target.read_text()
        count = 0
        def replace(match):
            nonlocal count
            digest = hashlib.sha256(match.group().encode()).hexdigest()
            if match.group(3) != data['provider_sha'] or (name, digest) not in approved:
                raise ValueError('unreviewed merge hunk: ' + name)
            count += 1
            used.append({'path': name, 'sha256': digest})
            return approved[name, digest]
        updated = BLOCK.sub(replace, text)
        if not count or any(re.search(r'^' + re.escape(marker), updated, re.M) for marker in ('<<<<<<< ', '=======', '>>>>>>> ')):
            raise ValueError('unreviewed merge conflict: ' + name)
        pending[target] = updated
    for target, updated in pending.items():
        target.write_text(updated)
    return used
