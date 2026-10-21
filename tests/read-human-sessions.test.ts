import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const readerPath = fileURLToPath(new URL('../server/read-human-sessions.py', import.meta.url))

describe('human session visibility', () => {
  it('ignores the synthetic empty-response nudge without hiding genuine user empty text', () => {
    const script = String.raw`
import importlib.util, json, sqlite3, sys
spec = importlib.util.spec_from_file_location("read_human_sessions", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
database = sqlite3.connect(":memory:")
database.row_factory = sqlite3.Row
database.executescript("""
CREATE TABLE messages (
  session_id TEXT, role TEXT, content TEXT, timestamp REAL,
  active INTEGER DEFAULT 1, display_kind TEXT DEFAULT ''
);
INSERT INTO messages VALUES ('preserved', 'user', '(empty)', 100, 1, '');
INSERT INTO messages VALUES (
  'preserved', 'user',
  'You just executed tool calls but returned an empty response. Please process the tool results above and continue with the task.',
  200, 1, ''
);
INSERT INTO messages VALUES (
  'synthetic-only', 'user',
  'You just executed tool calls but returned an empty response. Please process the tool results above and continue with the task.',
  300, 1, ''
);
""")
result = module.latest_visible_users(database, {
  "preserved": "thread-preserved",
  "synthetic-only": "thread-synthetic",
})
print(json.dumps(result, sort_keys=True))
`
    const output = execFileSync('python3', ['-c', script, readerPath], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    expect(JSON.parse(output)).toEqual({ 'thread-preserved': 100 })
  })

  it('hides recovery requests in the neutral and the legacy wording', () => {
    const script = String.raw`
import importlib.util, json, sqlite3, sys
spec = importlib.util.spec_from_file_location("read_human_sessions", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
database = sqlite3.connect(":memory:")
database.row_factory = sqlite3.Row
database.executescript("""
CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER DEFAULT 1, display_kind TEXT DEFAULT '');
INSERT INTO messages VALUES ('s', 'user', 'Real request', 100, 1, '');
INSERT INTO messages VALUES ('s', 'user', '[Owner requested recovery of this interrupted Helm card.] Continue.', 200, 1, '');
INSERT INTO messages VALUES ('s', 'user', '[James requested recovery of this interrupted Helm card.] Continue.', 300, 1, '');
""")
print(json.dumps(module.latest_visible_users(database, {"s": "thread-s"}), sort_keys=True))
`
    const output = execFileSync('python3', ['-c', script, readerPath], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
    expect(JSON.parse(output)).toEqual({ 'thread-s': 100 })
  })
})
