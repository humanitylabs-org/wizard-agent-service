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
INSERT INTO messages VALUES ('s', 'user', '  [Agent-to-agent owner clearance] Reply JSON', 400, 1, '');
""")
print(json.dumps(module.latest_visible_users(database, {"s": "thread-s"}), sort_keys=True))
`
    const output = execFileSync('python3', ['-c', script, readerPath], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
    expect(JSON.parse(output)).toEqual({ 'thread-s': 100 })
  })

  // Issue 612: the Telegram chat after a /new (parent ended session_reset) lists on the state.db path too.
  it('lists the conversation after a /new or a /branch, never a compression continuation or a sub-agent run', () => {
    const script = String.raw`
import importlib.util, json, os, sqlite3, sys, tempfile, time
spec = importlib.util.spec_from_file_location("read_human_sessions", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
folder = tempfile.mkdtemp()
path = os.path.join(folder, "state.db")
database = sqlite3.connect(path)
database.executescript("""
CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, title TEXT, started_at REAL, ended_at REAL,
  end_reason TEXT, message_count INTEGER, parent_session_id TEXT, last_activity_at REAL, pinned INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, chat_id TEXT, thread_id TEXT, model_config TEXT);
CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER DEFAULT 1, display_kind TEXT DEFAULT '');
""")
now = time.time()
rows = [
  ("old", "session_reset", None, None),
  ("after_new", "compression", "old", '{"_reset_from": "old"}'),
  ("after_new_tip", None, "after_new", '{"_reset_from": "old"}'),
  ("branch", None, "far", '{"_branched_from": "far"}'),
  ("far", None, None, None),
  ("helper", None, "far", '{"_delegate_from": "far"}'),
]
for n, (sid, end, parent, config) in enumerate(rows):
  database.execute("INSERT INTO sessions (id, source, end_reason, message_count, parent_session_id, last_activity_at, started_at, model_config) VALUES (?, 'telegram', ?, 2, ?, ?, ?, ?)", (sid, end, parent, now - n, now - n, config))
database.commit()
database.close()
print(json.dumps(sorted(row["id"] for row in module.read_sessions(path, ""))))
`
    const output = execFileSync('python3', ['-c', script, readerPath], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    expect(JSON.parse(output)).toEqual(['after_new', 'branch', 'far', 'old'])
  })
})
