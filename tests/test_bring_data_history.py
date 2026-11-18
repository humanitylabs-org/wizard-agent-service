"""bring_data.py, Bring your Wizard (issue 544): an earlier Hermes agent's past as read-only History.

The Importer turns it on per scan (``history: true``, behind its ``hermes-history`` switch). The fixture is shaped
like a real ``hermes backup`` zip (the home's files at the zip root): besides the history it carries config.yaml,
.env, auth.json, plugins/, cron output and a second profile, none of which may come in. Synthetic data only.
"""
import importlib.util
import json
import os
import random
import sqlite3
import string
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('wizard_os_bring_data_history', ROOT / 'hermes-plugin/wizard-os/bring_data.py')
bd = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bd
spec.loader.exec_module(bd)

CANARY = 'CANARY-' + 'never-imported-7f3a'
SK_KEY = 'sk-' + 'proj-' + 'Q' * 6 + 'abcDEF123456ghiJKL7890'
GH_TOKEN = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
_RNG = random.Random(544)
STOCK_SKILL = '---\nname: plan\ndescription: Stock planning skill.\n---\nPlan things.\n'
RANDOM40 = ''.join(_RNG.choice(string.ascii_letters + string.digits) for _ in range(40))


def call(action, **args):
    return json.loads(bd.handle_app(action, args))


def fact_store(path: Path, facts) -> None:
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE IF NOT EXISTS facts (fact_id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL UNIQUE,
            category TEXT DEFAULT 'general', tags TEXT DEFAULT '', trust_score REAL DEFAULT 0.5,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, hrr_vector BLOB);
        CREATE TABLE IF NOT EXISTS fact_entities (fact_id INTEGER, entity_id INTEGER, PRIMARY KEY (fact_id, entity_id));
        CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(content, tags, content=facts, content_rowid=fact_id);
        CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
            INSERT INTO facts_fts(rowid, content, tags) VALUES (new.fact_id, new.content, new.tags); END;
        CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
            INSERT INTO facts_fts(facts_fts, rowid, content, tags) VALUES ('delete', old.fact_id, old.content, old.tags); END;
    """)
    con.executemany("INSERT INTO facts (content, category, trust_score, created_at) VALUES (?, ?, ?, ?)", facts)
    con.commit()
    con.close()


def state_db(path: Path, rows) -> None:
    con = sqlite3.connect(path)
    con.executescript('''
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, parent_session_id TEXT, started_at REAL NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL);
    ''')
    con.execute("INSERT INTO sessions VALUES ('s1','telegram','Garden plans',NULL,1750000000)")
    con.executemany("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s1', ?, ?, ?)", rows)
    con.commit()
    con.close()


def backup_zip(base: Path, name='hermes-backup.zip', profile_only=False, private=False) -> Path:
    """A `hermes backup` zip: the Hermes home's own files at the root."""
    home = base / ('src-' + name)
    home.mkdir()
    files = {
        'config.yaml': f'model: x\napi_key: {CANARY}\n',
        '.env': f'ANTHROPIC_API_KEY={CANARY}\n',
        'auth.json': json.dumps({'token': CANARY}),
        'plugins/evil/plugin.yaml': f'name: evil\nkey: {CANARY}\n',
        'plugins/evil/skills/evil/SKILL.md': f'---\nname: evil\n---\n{CANARY}\n',
        'cron/output/daily/2026-01-01.md': CANARY,
        'profiles/second/memories/USER.md': 'SECOND PROFILE MEMORY\n',
        'profiles/second/SOUL.md': 'SECOND PROFILE SOUL',
        'profiles/second/skills/other/SKILL.md': '---\nname: second-skill\n---\nSECOND PROFILE SKILL\n',
        'profiles/second/.env': f'K={CANARY}\n',
    }
    if not profile_only:
        files.update({
            'memories/USER.md': 'Owner is Ana.\n§\nLives in Lisbon.\n',
            'memories/MEMORY.md': f'Server key was {GH_TOKEN}\n',
            'SOUL.md': 'You are Archimedes Prime, calm and concise.',
            'skills/garden/watering/SKILL.md': '---\nname: watering\ndescription: Plan garden watering.\n---\n# Watering\n\nWater at dawn.\n',
            'skills/garden/watering/notes.md': 'Clay soil holds water.',
            'skills/stock/plan/SKILL.md': STOCK_SKILL,
            'skills/mine/notes-style/SKILL.md': '---\nname: notes-style\n---\nMY OLD WAY OF TAKING NOTES\n',
            'cron/jobs.json': json.dumps({'jobs': [
                {'id': 'brief', 'name': 'Morning brief', 'prompt': f'Summarise my garden. Token {SK_KEY}',
                 'schedule': {'kind': 'cron', 'expr': '0 8 * * *'}, 'skill': 'watering', 'skills': [GH_TOKEN]},
                {'id': 'weekly', 'name': 'Weekly review', 'prompt': 'Review the week.',
                 'schedule': {'kind': 'interval', 'minutes': 10080}},
                {'id': 'backup', 'name': 'Backup script', 'no_agent': True, 'script': 'backup.sh',
                 'schedule': {'kind': 'interval', 'minutes': 60}},
            ]}),
        })
    if private:
        files['agent.json'] = json.dumps({'schema': 1, 'id': 'secret', 'privacy': 'private'})
    for rel, text in files.items():
        (home / rel).parent.mkdir(parents=True, exist_ok=True)
        (home / rel).write_text(text, 'utf-8')
    if not profile_only:
        state_db(home / 'state.db', [
            ('user', f'My key is {SK_KEY}, plan the beds', 1750000000),
            ('tool', f'{{"output": "{RANDOM40} {CANARY}"}}', 1750000001),
            ('assistant', f'Two beds. (copied {GH_TOKEN} and {RANDOM40})', 1750000002),
        ])
        fact_store(home / 'memory_store.db', [('Lives in Lisbon.', 'user_pref', 0.8, '2025-01-02 10:00:00'),
                                              (f'API key {SK_KEY}', 'general', 0.9, '2025-01-03 10:00:00'),
                                              ('Likes tomatoes.', 'general', 0.6, '2025-02-01 09:00:00')])
    state_db(home / 'profiles/second/state.db', [('user', 'SECOND PROFILE CHAT', 1750000000)])
    target = base / 'media/Inbox' / name
    with zipfile.ZipFile(target, 'w') as zf:
        for path in sorted(home.rglob('*')):
            if path.is_file():
                zf.write(path, path.relative_to(home).as_posix())
    return target


class FakeMemory:
    def __init__(self):
        self.entries = []

    def module(self):
        mod = types.ModuleType('tools.memory_tool')

        def memory_tool(action=None, target='memory', content=None, old_text=None, store=None, **_):
            if action == 'add':
                self.entries.append(content)
                return json.dumps({'success': True, 'message': 'Entry added.'})
            if action == 'remove' and old_text in self.entries:
                self.entries.remove(old_text)
                return json.dumps({'success': True})
            return json.dumps({'success': False, 'error': 'No entry matched'})

        mod.memory_tool = memory_tool
        mod.load_on_disk_store = lambda: self
        return mod


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.home = self.base / 'agent'
        self.home.mkdir()
        self.files = self.base / 'media'
        (self.files / 'Inbox').mkdir(parents=True)
        keys = ('HERMES_HOME', 'WIZARD_FILES_ROOT', 'WIZARD_BRING_DATA_READ_ONLY', 'WIZARD_BRING_DATA_LOCAL_ROOTS', 'HOME',
                'WIZARD_AGENTS_DIR')
        self.env = {k: os.environ.get(k) for k in keys}
        os.environ.update(HERMES_HOME=str(self.home), WIZARD_FILES_ROOT=str(self.files), HOME=str(self.base / 'user'))
        for k in ('WIZARD_BRING_DATA_READ_ONLY', 'WIZARD_BRING_DATA_LOCAL_ROOTS', 'WIZARD_AGENTS_DIR'):
            os.environ.pop(k, None)
        (self.base / 'user').mkdir()
        self.memory = FakeMemory()
        self.saved_modules = {k: sys.modules.get(k) for k in ('tools', 'tools.memory_tool')}
        sys.modules['tools'] = types.ModuleType('tools')
        sys.modules['tools.memory_tool'] = self.memory.module()
        self.schedules, self.cancelled = [], []
        real = bd._scheduler_call

        def fake(action, value):
            if action == 'import-history':
                self.schedules.append(value)
                return {'results': [{'status': 'imported (paused)', 'scheduleId': f"sch_{value['jobs'][0]['id']}"}]}
            if action == 'cancel':
                self.cancelled.append(value['schedule_id'])
                return {'deleted': True}
            raise AssertionError(action)

        bd._scheduler_call = fake
        self.addCleanup(setattr, bd, '_scheduler_call', real)

    def tearDown(self):
        for k, v in self.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        for k, v in self.saved_modules.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    def written(self):
        out = ''
        for root in (self.files / 'Imported', self.home):
            for path in root.rglob('*') if root.exists() else []:
                if path.is_file() and path.suffix != '.db':
                    out += path.read_text('utf-8', errors='replace')
        return out

    def facts_here(self):
        con = sqlite3.connect(self.home / 'memory_store.db')
        try:
            return {c: t for c, t in con.execute('SELECT content, trust_score FROM facts')}
        finally:
            con.close()

    def scan(self, name='hermes-backup.zip', **kw):
        return call('scan', path=f'Inbox/{name}', history=True, **kw)

    def bring_all(self, schedules=('brief',)):
        scan = self.scan()
        self.assertTrue(scan['success'], scan)
        result = call('import', import_id=scan['import_id'], chats=True, skills='all', facts=True,
                      schedules=list(schedules), personality=True)
        self.assertTrue(result['success'], result)
        self.assertEqual(result['errors'], {})
        return scan, result

    # 1. a full backup zip: none of config, auth, .env, plugins, cron output or the second profile comes in
    def test_backup_zip_brings_only_the_allowlist(self):
        backup_zip(self.base)
        scan, result = self.bring_all()
        self.assertEqual(scan['kind'], 'hermes')
        blob = self.written() + json.dumps(scan) + json.dumps(result) + json.dumps(self.facts_here())
        for never in (CANARY, 'SECOND PROFILE', 'second-skill', 'evil'):
            self.assertNotIn(never, blob)
        self.assertFalse((self.home / 'skills').exists())             # no active skill, nothing from plugins/
        self.assertFalse((self.home / 'SOUL.md').exists())            # the history, not the agent
        self.assertNotIn('personality', result['done'])

    def test_a_zip_holding_only_a_second_profile_is_refused(self):
        backup_zip(self.base, 'profile.zip', profile_only=True)
        out = self.scan('profile.zip')
        self.assertFalse(out['success'])
        self.assertIn('second Hermes agent', out['error'])

    # 2. memories, facts and chats are labelled as the earlier agent's, with their dates
    def test_history_is_labelled_with_its_dates(self):
        backup_zip(self.base)
        scan, _ = self.bring_all()
        root = self.files / 'Imported/Hermes'
        chat = next(root.glob('Chats/2025/2025-06-15 Garden plans (*).md')).read_text('utf-8')
        self.assertIn('From your earlier agent (Hermes), read-only History', chat)
        self.assertIn('### Earlier agent (Hermes) · 2025-06-15', chat)
        knew = (root / 'What Hermes knew about me.md').read_text('utf-8')
        self.assertIn(f"as of {scan['history']['memories_as_of']}", knew)
        self.assertIn('Lives in Lisbon.', knew)
        self.assertIn("your Wizard's own memory wins", knew)
        self.assertIn('[Earlier agent, 2025-01-02] Lives in Lisbon.', self.facts_here())
        self.assertEqual(bd.history_note(), bd.HISTORY_NOTE)

    # 3. a conflicting imported fact ranks below the new agent's newer one; memory stays the owner's
    def test_imported_fact_loses_to_a_newer_one(self):
        fact_store(self.home / 'memory_store.db', [('Lives in Porto.', 'user_pref', 0.5, '2026-11-01 08:00:00')])
        self.memory.entries = ['Lives in Porto.']
        backup_zip(self.base)
        self.bring_all()
        facts = self.facts_here()
        old, new = facts['[Earlier agent, 2025-01-02] Lives in Lisbon.'], facts['Lives in Porto.']
        self.assertLess(old, new)
        self.assertLessEqual(max(t for c, t in facts.items() if c.startswith('[Earlier agent')), bd.HISTORY_TRUST)
        self.assertEqual(self.memory.entries, ['Lives in Porto.'])   # nothing went into always-on memory by itself

    # 4. skills are readable reference documents, never active skills
    def test_skills_are_documents_not_active_skills(self):
        backup_zip(self.base)
        _, result = self.bring_all()
        self.assertEqual(result['done']['skills']['documents'], 3)
        doc = next((self.files / 'Imported/Hermes/Skills').glob('watering (*).md')).read_text('utf-8')
        self.assertIn('This is not an active skill', doc)
        self.assertIn('Water at dawn.', doc)
        self.assertIn('notes.md', doc)
        self.assertIn('watering', (self.files / 'Imported/Hermes/Skills/Index.md').read_text('utf-8'))
        self.assertEqual(list(self.home.rglob('SKILL.md')), [])

    # 5. cron jobs are an opt-in list; only the ticked one is sent to Wizard schedules
    def test_only_ticked_cron_jobs_become_schedules(self):
        backup_zip(self.base)
        scan = self.scan()
        jobs = {j['id']: j for j in scan['history']['cron_jobs']}
        self.assertEqual(set(jobs), {'brief', 'weekly', 'backup'})
        self.assertFalse(jobs['backup']['can_import'])
        self.assertNotIn(SK_KEY, json.dumps(jobs))
        result = call('import', import_id=scan['import_id'], schedules=['brief', 'backup'])
        self.assertEqual([v['jobs'][0]['id'] for v in self.schedules], ['brief'])
        self.assertEqual(self.schedules[0]['agent'], 'main')
        self.assertNotIn(SK_KEY, json.dumps(self.schedules))
        statuses = {r['id']: r['status'] for r in result['done']['schedules']['results']}
        self.assertEqual(statuses, {'brief': 'imported (paused)', 'backup': 'not imported: runs a script from the old agent'})
        self.assertEqual(result['done']['schedules']['created'], 1)

    # 6. planted secrets never reach the index
    def test_planted_secrets_are_absent(self):
        backup_zip(self.base)
        scan, result = self.bring_all()
        blob = self.written() + json.dumps(scan) + json.dumps(self.facts_here())
        for secret in (SK_KEY, GH_TOKEN, RANDOM40):
            self.assertNotIn(secret, blob)
        self.assertIn('plan the beds', blob)
        self.assertEqual(scan['draft_facts'], ['Owner is Ana.', 'Lives in Lisbon.'])  # the key line is no fact
        self.assertNotIn('API key', json.dumps(self.facts_here()))   # a fact that was a key stays behind
        self.assertEqual(bd.scrub('a slug-like-name-that-is-long-but-only-words'), 'a slug-like-name-that-is-long-but-only-words')

    # 7. a private agent is never a source
    def test_private_agent_is_never_offered_and_refused(self):
        backup_zip(self.base, 'private.zip', private=True)
        out = self.scan('private.zip')
        self.assertFalse(out['success'])
        self.assertIn('private agent', out['error'])
        agents = self.base / 'agents'
        (agents / 'secret').mkdir(parents=True)
        (agents / 'secret/agent.json').write_text(json.dumps(
            {'schema': 1, 'id': 'secret', 'privacy': 'private', 'runtime': {'kind': 'profile', 'profile': 'secret'}}))
        os.environ['WIZARD_AGENTS_DIR'] = str(agents)
        profile = self.base / 'user/.hermes/profiles/secret'
        (profile / 'memories').mkdir(parents=True)
        (profile / 'memories/USER.md').write_text('PRIVATE MEMORY', 'utf-8')
        self.assertNotIn(str(profile), json.dumps(call('sources')))
        for history in (True, False):
            out = call('scan', path=str(profile), history=history)
            self.assertFalse(out['success'])
            self.assertIn('private agent', out['error'])

    # 8. undo removes everything the import added
    def test_undo_removes_everything(self):
        fact_store(self.home / 'memory_store.db', [('Own fact.', 'general', 0.5, '2026-11-01 08:00:00')])
        backup_zip(self.base)
        scan, _ = self.bring_all()
        undone = call('undo', import_id=scan['import_id'])
        self.assertTrue(undone['success'], undone)
        self.assertEqual(self.cancelled, ['sch_brief'])
        self.assertEqual(undone['removed_schedules'], 1)
        self.assertEqual(self.facts_here(), {'Own fact.': 0.5})
        self.assertFalse((self.files / 'Imported/Hermes').exists())
        self.assertEqual(bd.history_note(), '')

    def test_undo_removes_a_store_the_import_created(self):
        backup_zip(self.base)
        scan, _ = self.bring_all()
        self.assertTrue((self.home / 'memory_store.db').exists())
        call('undo', import_id=scan['import_id'])
        self.assertFalse((self.home / 'memory_store.db').exists())

    def test_history_needs_a_hermes_source(self):
        with zipfile.ZipFile(self.files / 'Inbox/chatgpt.zip', 'w') as zf:
            zf.writestr('conversations.json', json.dumps([{'title': 't', 'mapping': {}, 'create_time': 1}]))
        out = call('scan', path='Inbox/chatgpt.zip', history=True)
        self.assertFalse(out['success'])
        self.assertIn('earlier Hermes agent', out['error'])

    def own_skills(self):
        for rel, text in (('skills/stock/plan/SKILL.md', STOCK_SKILL),
                          ('skills/mine/notes-style/SKILL.md', '---\nname: notes-style\n---\nTHE NEW WAY\n')):
            (self.home / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.home / rel).write_text(text, 'utf-8')

    def test_a_changed_skill_of_the_same_name_comes_in_and_the_identical_stock_one_does_not(self):
        self.own_skills()
        backup_zip(self.base)
        scan = self.scan()
        self.assertEqual(sorted(s['name'] for s in scan['new_skills']), ['notes-style', 'watering'])
        result = call('import', import_id=scan['import_id'], skills='all')
        self.assertEqual(sorted(result['done']['skills']['names']), ['notes-style', 'watering'])
        self.assertIn('MY OLD WAY OF TAKING NOTES', self.written())
        self.assertEqual((self.home / 'skills/mine/notes-style/SKILL.md').read_text('utf-8').count('THE NEW WAY'), 1)

    def test_cron_skill_names_are_scrubbed_too(self):
        backup_zip(self.base)
        scan = self.scan()
        brief = next(j for j in scan['history']['cron_jobs'] if j['id'] == 'brief')
        self.assertEqual(brief['skills'], ['watering'])
        call('import', import_id=scan['import_id'], schedules=['brief'])
        self.assertNotIn(GH_TOKEN, json.dumps(self.schedules))

    def test_the_history_line_needs_history_that_came_in(self):
        backup_zip(self.base)
        scan = self.scan()
        call('import', import_id=scan['import_id'], about={'facts': ['Owner is Ana.']})
        self.assertEqual(bd.history_note(), '')
        call('import', import_id=scan['import_id'], facts=True)
        self.assertEqual(bd.history_note(), bd.HISTORY_NOTE)

    # Switch off (no history flag): the Hermes import works as before
    def test_without_the_switch_nothing_changes(self):
        backup_zip(self.base)
        scan = call('scan', path='Inbox/hermes-backup.zip')
        self.assertNotIn('history', scan)
        result = call('import', import_id=scan['import_id'], skills=['watering'], schedules=['brief'])
        self.assertEqual([i['name'] for i in result['done']['skills']['installed']], ['watering'])
        self.assertNotIn('schedules', result['done'])
        self.assertEqual(self.schedules, [])
        self.assertEqual(bd.history_note(), '')


if __name__ == '__main__':
    unittest.main()
