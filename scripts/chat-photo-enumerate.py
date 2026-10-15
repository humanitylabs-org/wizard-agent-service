#!/usr/bin/env python3
"""Bounded canonical candidate enumeration, metadata/session index first."""
import importlib.util
import json
import os
import pathlib
import sys
spec = importlib.util.spec_from_file_location('photo_reader', pathlib.Path(__file__).parents[1] / 'server/read-chat-photos.py')
assert spec is not None and spec.loader is not None
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
root = pathlib.Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True, mode=0o700)
state_path = root / 'enumeration-state.json'
state = json.loads(state_path.read_text()) if state_path.exists() else {'cursor': 0, 'ceiling': 0, 'batches': 0, 'counts': {}, 'done': False}
while not state['done']:
    result = reader.scan(os.environ['WIZARD_HERMES_STATE_PATH'], state['cursor'], state['ceiling'], os.environ['WIZARD_CHAT_PHOTOS_OWNER_ID'], 2000, os.environ['WIZARD_AGENTS_DIR'])
    state['batches'] += 1
    target = root / f"evidence-{state['batches']:04d}.json"
    target.write_text(json.dumps(result, separators=(',', ':')))
    target.chmod(0o600)
    for key, value in result['counts'].items():
        state['counts'][key] = state['counts'].get(key, 0) + value
    state.update(cursor=result['cursor'], ceiling=result['ceiling'], done=result['done'])
    temp = state_path.with_suffix('.tmp')
    temp.write_text(json.dumps(state)); temp.chmod(0o600); temp.replace(state_path)
print(json.dumps(state))
