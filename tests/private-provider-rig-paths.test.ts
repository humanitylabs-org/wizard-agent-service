import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

it('rig paths require explicit approved storage and refuse sibling-prefix and symlink escapes', () => {
  const worker = fileURLToPath(new URL('../ops/private-provider-rig/worker.py', import.meta.url))
  const output = execFileSync('python3', ['-c', `
import json, os, runpy, tempfile
from pathlib import Path
validate = runpy.run_path(__import__('sys').argv[1])['validate_rig_root']
with tempfile.TemporaryDirectory() as d:
    base = Path(d).resolve()
    volume = base / 'external'; volume.mkdir()
    outside = base / 'external-other'; outside.mkdir()
    (volume / 'escape').symlink_to(outside, target_is_directory=True)
    root = volume / 'lane' / 'rig'
    assert validate(root, volume) == (root, volume)
    refused = 0
    for root, mount in [(root, None), (root, Path('relative')), (root, Path('/')),
                        (root, base / 'missing'), (volume, volume),
                        (volume / 'not-rig', volume), (outside / 'rig', volume),
                        (volume / 'escape' / 'rig', volume)]:
        try:
            validate(root, mount)
        except ValueError:
            refused += 1
        else:
            raise AssertionError('unsafe storage accepted')
    print(json.dumps({'accepted': 1, 'refused': refused}))
`, worker], { encoding: 'utf8' })
  expect(JSON.parse(output)).toEqual({ accepted: 1, refused: 8 })
})
