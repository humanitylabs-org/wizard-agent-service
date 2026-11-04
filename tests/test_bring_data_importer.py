"""bring_data.py, Importer app side: Claude Code source, split Claude exports, sources, preview mode,
the approved "What I know about you" card (stock memory tool), personality and per-import undo.

The Claude Code fixture copies the real ~/.claude layout (inspected read-only; no real content):
CLAUDE.md, projects/<cwd slug>/<session>.jsonl + memory/{MEMORY.md,<topic>.md}, skills/synced/<bucket>/<name>/,
commands/, agents/, plus files that must never be read (.credentials.json, .claude.json, settings*.json,
history.jsonl) and folders that are never walked (plugins/, sessions/, file-history/).
"""
import builtins
import importlib.util
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('wizard_os_bring_data_app', ROOT / 'hermes-plugin/wizard-os/bring_data.py')
bd = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bd
spec.loader.exec_module(bd)

CANARY = 'sk-ant-' + 'B' * 40
NEVER_READ = ('.credentials.json', '.claude.json', 'settings.json', 'settings.local.json', 'history.jsonl')


def call(action, **args):
    return json.loads(bd.handle_app(action, args))


def jl(*events):
    return '\n'.join(json.dumps(e) for e in events) + '\n'


def claude_code_home(base: Path) -> Path:
    home = base / 'user' / '.claude'
    home.mkdir(parents=True)
    (home / 'CLAUDE.md').write_text('# Global\n\nI am Ana, a nurse in Lisbon.\nPrefer metric units.\n', 'utf-8')
    (home / '.credentials.json').write_text(json.dumps({'claudeAiOauth': {'accessToken': CANARY}}), 'utf-8')
    (home / '.claude.json').write_text(json.dumps({'oauthAccount': {'emailAddress': 'ana@example.com'}, 'k': CANARY}), 'utf-8')
    (home / 'settings.json').write_text(json.dumps({'env': {'ANTHROPIC_API_KEY': CANARY}}), 'utf-8')
    (home / 'settings.local.json').write_text(json.dumps({'permissions': {}}), 'utf-8')
    (home / 'history.jsonl').write_text(json.dumps({'display': CANARY}) + '\n', 'utf-8')
    for folder in ('plugins/market/skills/evil', 'sessions', 'file-history/x'):
        (home / folder).mkdir(parents=True)
    (home / 'plugins/market/skills/evil/SKILL.md').write_text('---\nname: evil\n---\n' + CANARY, 'utf-8')
    proj = home / 'projects/-home-ana-garden'
    (proj / 'memory').mkdir(parents=True)
    (proj / 'memory/MEMORY.md').write_text('# Memory\n\n- [Beds](beds.md) — index line\n', 'utf-8')
    (proj / 'memory/beds.md').write_text('---\nname: raised-beds\ndescription: Ana grows tomatoes in two raised beds\n'
                                         'metadata:\n  type: project\n---\n\nTwo beds of 1.2 m, clay soil.\n', 'utf-8')
    (proj / '0b1d-session.jsonl').write_text(jl(
        {'type': 'summary', 'summary': 'Tomato bed layout', 'leafUuid': 'x'},
        {'type': 'user', 'sessionId': '0b1d', 'cwd': '/home/ana/garden', 'timestamp': '2026-09-01T10:00:00Z',
         'message': {'role': 'user', 'content': 'Help me lay out tomato beds'}},
        {'type': 'assistant', 'timestamp': '2026-09-01T10:00:05Z',
         'message': {'role': 'assistant', 'content': [{'type': 'thinking', 'thinking': 'PRIVATE THOUGHT'},
                                                       {'type': 'text', 'text': 'Two beds, 1.2 m wide.'},
                                                       {'type': 'tool_use', 'name': 'Bash', 'input': {}}]}},
        {'type': 'user', 'timestamp': '2026-09-01T10:00:06Z',
         'message': {'role': 'user', 'content': [{'type': 'tool_result', 'content': 'TOOL OUTPUT'}]}},
        {'type': 'user', 'isSidechain': True, 'message': {'role': 'user', 'content': 'SUBAGENT PROMPT'}},
        {'type': 'user', 'isMeta': True, 'message': {'role': 'user', 'content': 'META'}},
        {'type': 'user', 'message': {'role': 'user', 'content': '<command-name>/clear</command-name>'}},
        'not json at all',
        {'type': 'attachment', 'attachment': {'x': 1}},
    ), 'utf-8')
    (proj / 'empty-session.jsonl').write_text(jl({'type': 'queue-operation'}), 'utf-8')
    (home / 'projects/-home-ana').mkdir()
    (home / 'projects/-home-ana/9f9f.jsonl').write_text(jl(
        {'type': 'user', 'timestamp': '2026-10-02T09:00:00Z', 'message': {'role': 'user', 'content': 'Plan my week'}},
        {'type': 'assistant', 'timestamp': '2026-10-02T09:00:03Z', 'message': {'content': [{'type': 'text', 'text': 'Mon: run.'}]}},
    ), 'utf-8')
    skill = home / 'skills/synced/bucket-1/pdf'
    skill.mkdir(parents=True)
    (skill / 'SKILL.md').write_text('---\nname: pdf\ndescription: Work with PDF files.\n---\n# PDF\n', 'utf-8')
    (home / 'skills/synced/.bucket-1/staging').mkdir(parents=True)
    (home / 'skills/synced/.bucket-1/staging/SKILL.md').write_text('---\nname: staged\n---\n', 'utf-8')
    (home / 'commands').mkdir()
    (home / 'commands/deploy.md').write_text('---\ndescription: Deploy the garden site\n---\nRun the deploy steps.\n', 'utf-8')
    (home / 'commands/leak.md').write_text(f'Use key {CANARY}\n', 'utf-8')
    (home / 'rules').mkdir()
    (home / 'rules/units.md').write_text('---\npaths: ["**"]\n---\nAlways use metric units.\n', 'utf-8')
    (home / 'agents').mkdir()
    (home / 'agents/reviewer.md').write_text('---\nname: reviewer\ndescription: Reviews my code\n---\nBe strict.\n', 'utf-8')
    return home


def fact_store(path: Path, facts) -> None:
    """The stock holographic plugin's tables (facts with its full-text triggers, entities)."""
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE IF NOT EXISTS facts (fact_id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL UNIQUE,
            category TEXT DEFAULT 'general', tags TEXT DEFAULT '', trust_score REAL DEFAULT 0.5,
            retrieval_count INTEGER DEFAULT 0, helpful_count INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, hrr_vector BLOB);
        CREATE TABLE IF NOT EXISTS fact_entities (fact_id INTEGER, entity_id INTEGER, PRIMARY KEY (fact_id, entity_id));
        CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(content, tags, content=facts, content_rowid=fact_id);
        CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
            INSERT INTO facts_fts(rowid, content, tags) VALUES (new.fact_id, new.content, new.tags); END;
        CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
            INSERT INTO facts_fts(facts_fts, rowid, content, tags) VALUES ('delete', old.fact_id, old.content, old.tags); END;
    """)
    con.executemany("INSERT INTO facts (content, category, trust_score) VALUES (?, ?, ?)", facts)
    con.commit()
    con.close()


class FakeMemory:
    """Stand-in for Hermes' tools.memory_tool (memory_tool + load_on_disk_store) with a tiny user budget."""

    def __init__(self, limit=120, existing=()):
        self.entries = list(existing)
        self.limit = limit

    def module(self):
        mod = types.ModuleType('tools.memory_tool')

        def memory_tool(action=None, target='memory', content=None, old_text=None, store=None, **_):
            assert target == 'user' and store is self
            if action == 'add':
                if content in self.entries:
                    return json.dumps({'success': True, 'message': 'Entry already exists (no duplicate added).'})
                if len('\n§\n'.join(self.entries + [content])) > self.limit:
                    return json.dumps({'success': False, 'error': 'Memory at limit'})
                self.entries.append(content)
                return json.dumps({'success': True, 'message': 'Entry added.'})
            if action == 'remove':
                if old_text in self.entries:
                    self.entries.remove(old_text)
                    return json.dumps({'success': True})
                return json.dumps({'success': False, 'error': 'No entry matched'})
            raise AssertionError(action)

        mod.memory_tool = memory_tool
        mod.load_on_disk_store = lambda: self
        return mod


class ImporterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.home = self.base / 'agent'
        self.home.mkdir()
        self.files = self.base / 'media'
        (self.files / 'Inbox').mkdir(parents=True)
        keys = ('HERMES_HOME', 'WIZARD_FILES_ROOT', 'WIZARD_BRING_DATA_READ_ONLY', 'WIZARD_BRING_DATA_LOCAL_ROOTS', 'HOME')
        self.env = {k: os.environ.get(k) for k in keys}
        os.environ['HERMES_HOME'] = str(self.home)
        os.environ['WIZARD_FILES_ROOT'] = str(self.files)
        os.environ['HOME'] = str(self.base / 'user')
        os.environ.pop('WIZARD_BRING_DATA_READ_ONLY', None)
        os.environ.pop('WIZARD_BRING_DATA_LOCAL_ROOTS', None)
        self.memory = FakeMemory()
        tools = types.ModuleType('tools')
        self.saved_modules = {k: sys.modules.get(k) for k in ('tools', 'tools.memory_tool')}
        sys.modules['tools'] = tools
        sys.modules['tools.memory_tool'] = self.memory.module()

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
        for root in (self.files, self.home):
            for path in root.rglob('*'):
                if path.is_file():
                    out += path.read_text('utf-8', errors='replace')
        return out

    # ------------------------------------------------------------------ Claude Code
    def test_claude_code_scan_reads_only_safe_files(self):
        cc = claude_code_home(self.base)
        opened = []
        real_open = builtins.open

        def spy(file, *a, **k):
            opened.append(str(file))
            return real_open(file, *a, **k)

        builtins.open = spy
        try:
            result = call('scan', path=str(cc))
        finally:
            builtins.open = real_open
        self.assertTrue(result['success'], result)
        self.assertEqual(result['kind'], 'claude-code')
        self.assertEqual(result['source'], 'Claude Code')
        self.assertEqual(result['counts']['chats'], 2)                # empty session dropped
        self.assertEqual(result['counts']['messages'], 4)             # tool results, sidechain, meta, commands dropped
        self.assertEqual(result['counts']['memories'], 1)             # MEMORY.md is only the index
        self.assertEqual(result['counts']['custom_instructions'], 2)  # CLAUDE.md + rules/units.md
        self.assertEqual(result['counts']['projects'], 2)
        names = {s['name'] for s in result['new_skills']}
        self.assertEqual(names, {'pdf', 'deploy', 'reviewer'})        # leak.md left behind, dot dirs + plugins skipped
        self.assertIn('Ana grows tomatoes in two raised beds', result['draft_facts'])
        self.assertIn('I am Ana, a nurse in Lisbon.', result['draft_facts'])
        self.assertIn('Always use metric units.', result['draft_facts'])
        self.assertIn('2026-09-01 Tomato bed layout', result['recent_chats'][1])
        blob = json.dumps(result)
        for secret in (CANARY, 'PRIVATE THOUGHT', 'TOOL OUTPUT', 'SUBAGENT PROMPT', 'ana@example.com'):
            self.assertNotIn(secret, blob)
        touched = {Path(p).name for p in opened if str(cc) in p}
        self.assertFalse(touched & set(NEVER_READ), touched)
        self.assertFalse(any('/plugins/' in p for p in opened if str(cc) in p))

    def test_claude_code_import_and_undo(self):
        cc = claude_code_home(self.base)
        scan = call('scan', path=str(cc))
        result = call('import', import_id=scan['import_id'], chats=True, skills=['pdf', 'deploy', 'reviewer', 'leak'],
                      about={'facts': ['Ana grows tomatoes in two raised beds']})
        self.assertTrue(result['success'], result)
        self.assertEqual(result['errors'], {})
        self.assertEqual(result['done']['chats']['chats_written'], 2)
        self.assertEqual({i['name'] for i in result['done']['skills']['installed']}, {'pdf', 'deploy', 'reviewer'})
        root = self.files / 'Imported/Claude Code'
        chat = next(root.glob('Chats/2026/2026-09-01 Tomato bed layout (*).md')).read_text('utf-8')
        self.assertIn('Help me lay out tomato beds', chat)
        self.assertIn('Two beds, 1.2 m wide.', chat)
        self.assertIn('Claude Code in /home/ana/garden', chat)
        deploy = (self.home / 'skills/imported/deploy/SKILL.md').read_text('utf-8')
        self.assertIn('description: "Deploy the garden site"', deploy)
        self.assertIn('Run the deploy steps.', deploy)
        self.assertTrue((root / 'What Claude Code knew about me.md').is_file())
        self.assertTrue(any('Two beds of 1.2 m' in p.read_text('utf-8') for p in (root / 'Projects').glob('*.md')))
        self.assertEqual(self.memory.entries, ['Ana grows tomatoes in two raised beds'])
        self.assertNotIn(CANARY, self.written())

        undone = call('undo', import_id=scan['import_id'])
        self.assertTrue(undone['success'], undone)
        self.assertEqual(undone['removed_memories'], 1)
        self.assertEqual(undone['about'], 'removed')
        self.assertEqual(sorted(undone['removed_skills']), ['deploy', 'pdf', 'reviewer'])
        self.assertFalse(root.exists())
        self.assertFalse((self.files / 'Imported/About me.md').exists())
        self.assertEqual(self.memory.entries, [])
        self.assertEqual(call('status')['imports'], [])

    # ------------------------------------------------------------------ split Claude.ai export
    def test_claude_export_in_parts(self):
        conv = [{'uuid': 'c1', 'name': 'Garden', 'created_at': '2026-09-01T10:00:00Z',
                 'chat_messages': [{'sender': 'human', 'text': 'Hi', 'created_at': '2026-09-01T10:00:00Z'},
                                   {'sender': 'assistant', 'text': 'Hello', 'created_at': '2026-09-01T10:00:01Z'}]}]
        parts = []
        for name, member, data in (('conversations-000.zip', 'conversations.json', conv),
                                   ('memories-000.zip', 'memories.json', [{'conversations_memory': 'Ana likes tomatoes.'}]),
                                   ('projects-000.zip', 'projects.json', [{'uuid': 'p', 'name': 'Allotment', 'docs': []}])):
            path = self.files / 'Inbox' / name
            with zipfile.ZipFile(path, 'w') as zf:
                zf.writestr(member, json.dumps(data))
            parts.append(f'Inbox/{name}')
        result = call('scan', paths=parts)
        self.assertTrue(result['success'], result)
        self.assertEqual(result['kind'], 'claude')
        self.assertEqual((result['counts']['chats'], result['counts']['memories'], result['counts']['projects']), (1, 1, 1))
        again = call('scan', paths=list(reversed(parts)))
        self.assertEqual(again['import_id'], result['import_id'])  # order of the parts does not matter
        done = call('import', import_id=result['import_id'], chats=True)
        self.assertEqual(done['done']['chats']['chats_written'], 1)
        self.assertTrue(call('undo', import_id=result['import_id'])['success'])
        self.assertFalse((self.files / 'Imported/Claude').exists())

    # ------------------------------------------------------------------ sources
    def test_sources_lists_local_agents_and_inbox(self):
        claude_code_home(self.base)
        other = self.base / 'user/.hermes'
        (other / 'memories').mkdir(parents=True)
        (other / 'memories/USER.md').write_text('Ana\n', 'utf-8')
        (other / 'profiles/work/memories').mkdir(parents=True)
        (other / 'profiles/empty').mkdir(parents=True)
        with zipfile.ZipFile(self.files / 'Inbox/export.zip', 'w') as zf:
            zf.writestr('conversations.json', json.dumps([{'mapping': {}, 'current_node': None, 'title': 't'}]))
        (self.files / 'Inbox/notes.txt').write_text('x', 'utf-8')
        (self.files / 'Inbox/data-2026.json').write_text(json.dumps({'files': {
            'conversations': 'https://exports.example.com/conversations-000.zip?sig=1',
            'memories': 'https://exports.example.com/memories-000.zip?sig=2', 'bad': 'http://plain.example.com/x'}}), 'utf-8')
        (self.files / 'Inbox/other.json').write_text('{"no": "links"}', 'utf-8')
        result = call('sources')
        self.assertTrue(result['success'], result)
        local = {(s['kind'], s['label']) for s in result['local']}
        self.assertEqual(local, {('claude-code', 'Claude Code on this box'), ('hermes', 'This box’s main agent'),
                                 ('hermes', 'Hermes profile work')})
        self.assertEqual(result['into'], [])
        files = {f['name']: f for f in result['files']}
        self.assertEqual(set(files), {'export.zip', 'data-2026.json'})
        self.assertEqual(files['export.zip']['kind'], 'chatgpt')
        self.assertEqual([l['part'] for l in files['data-2026.json']['links']], ['conversations', 'memories'])

    def test_sources_never_offer_this_agent(self):
        os.environ['HERMES_HOME'] = str(self.base / 'user/.hermes')
        (self.base / 'user/.hermes/memories').mkdir(parents=True)
        self.assertEqual(call('sources')['local'], [])
        refused = call('scan', path=str(self.base / 'user/.hermes'))
        self.assertFalse(refused['success'])
        self.assertIn("own agent", refused['error'])

    # ------------------------------------------------------------------ other agents on this box
    def test_a_profile_inside_this_agent_is_another_agent(self):
        """The owner's box lists "Hermes profile history" (~/.hermes/profiles/history) while the engine runs in
        ~/.hermes: tapping it must scan that profile, not refuse it as this agent."""
        main = self.base / 'user/.hermes'
        os.environ['HERMES_HOME'] = str(main)
        (main / 'memories').mkdir(parents=True)
        (main / 'memories/USER.md').write_text('MAIN ONLY\n', 'utf-8')
        history = main / 'profiles/history'
        (history / 'memories').mkdir(parents=True)
        (history / 'memories/USER.md').write_text('Ana keeps bees.\n', 'utf-8')
        (history / '.env').write_text(f'ANTHROPIC_API_KEY={CANARY}\n', 'utf-8')
        listed = call('sources')['local']
        self.assertEqual([(s['label'], s['path']) for s in listed], [('Hermes profile history', str(history))])
        scan = call('scan', path=str(history))
        self.assertTrue(scan['success'], scan)
        self.assertEqual(scan['memories'], ['Ana keeps bees.'])
        self.assertNotIn(CANARY, json.dumps(scan))
        for refused in (main, main / 'memories', main / 'profiles'):
            result = call('scan', path=str(refused))
            self.assertFalse(result['success'], refused)
            self.assertIn('own agent', result['error'])

    def test_this_agent_is_never_its_own_source_without_another_agent(self):
        own = self.base / 'user/.hermes'
        os.environ['HERMES_HOME'] = str(own)
        (own / 'memories').mkdir(parents=True)
        self.assertEqual(call('sources')['local'], [])
        registry = self.registry()
        self.container_agent(registry, 'studio', 'Studio')
        result = call('sources')
        self.assertEqual(result['local'], [{'kind': 'hermes', 'self': True, 'label': 'This box’s main agent (Oscar)',
                                            'path': str(own)}])
        self.assertEqual(result['into'], [{'id': 'studio', 'label': 'Studio', 'kind': 'container', 'where': 'Inside Wizard OS'}])
        self.assertFalse(call('scan', path=str(own))['success'])  # not into itself

    def registry(self):
        registry = self.base / 'wizard-os/agents'
        registry.mkdir(parents=True)
        (registry.parent / 'settings.json').write_text(json.dumps({'agent': {'name': 'Oscar'}}), 'utf-8')
        os.environ['WIZARD_AGENTS_DIR'] = str(registry)
        self.addCleanup(os.environ.pop, 'WIZARD_AGENTS_DIR', None)
        return registry

    def container_agent(self, registry, agent_id, label, **runtime):
        folder = registry / agent_id
        (folder / 'home').mkdir(parents=True)
        (folder / 'home/config.yaml').write_text('memory:\n  provider: holographic\n', 'utf-8')
        (folder / 'agent.json').write_text(json.dumps({'schema': 1, 'id': agent_id, 'label': label, 'runtime': {
            'kind': 'container', 'app_id': f'agent-{agent_id}', 'port': 18700, **runtime}}), 'utf-8')
        return folder / 'home'

    def alongside_hermes(self):
        """This agent's own home, shaped like Oscar's: SOUL, memories, a skill, chats, a fact store, credentials."""
        own = self.base / 'user/.hermes'
        os.environ['HERMES_HOME'] = str(own)
        (own / 'memories').mkdir(parents=True)
        (own / 'memories/USER.md').write_text('Ana lives in Lisbon.\n§\nPrefers short answers.\n', 'utf-8')
        (own / 'memories/MEMORY.md').write_text('Box runs Wizard OS alongside.\n', 'utf-8')
        (own / 'SOUL.md').write_text('You are Oscar, direct and kind.\n', 'utf-8')
        (own / '.env').write_text(f'ANTHROPIC_API_KEY={CANARY}\n', 'utf-8')
        (own / 'auth.json').write_text(json.dumps({'token': CANARY}), 'utf-8')
        (own / 'config.yaml').write_text(f'model:\n  api_key: {CANARY}\n', 'utf-8')
        skill = own / 'skills/devops/box-care'
        skill.mkdir(parents=True)
        (skill / 'SKILL.md').write_text('---\nname: box-care\ndescription: Keep the box healthy.\n---\n# Box\n', 'utf-8')
        (skill / 'token.txt').write_text(CANARY, 'utf-8')
        con = sqlite3.connect(own / 'state.db')
        con.executescript("CREATE TABLE sessions (id TEXT, title TEXT, source TEXT, started_at REAL, parent_session_id TEXT);"
                          "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);")
        con.execute("INSERT INTO sessions VALUES ('s1', 'Plan the move', 'cli', 1790000000, NULL)")
        con.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s1', 'user', 'Move me into Wizard OS', 1790000001)")
        con.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s1', 'assistant', 'On it.', 1790000002)")
        con.commit(); con.close()
        fact_store(own / 'memory_store.db', [('Ana’s box is called garden-box.', 'general', 0.9),
                                             ('Ana likes plain words.', 'preference', 0.7),
                                             (f'The key is {CANARY}', 'general', 0.5)])
        return own

    def tree(self, root):
        return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob('*')) if p.is_file()}

    def test_move_this_agent_into_an_agent_inside_wizard_os(self):
        own = self.alongside_hermes()
        registry = self.registry()
        dest = self.container_agent(registry, 'oscar-os', 'Oscar in Wizard OS')
        before = self.tree(own)
        listed = call('sources')
        self.assertTrue(listed['local'][0]['self'])
        scan = call('scan', path=str(own), dest='oscar-os')
        self.assertTrue(scan['success'], scan)
        self.assertEqual(scan['into'], 'Oscar in Wizard OS')
        self.assertEqual(scan['counts']['facts'], 2)  # the key-looking fact stays behind
        self.assertEqual(scan['fact_store'], {'found': 2, 'here': None})
        self.assertEqual(scan['personality'], {'found': True, 'here': 'none'})
        self.assertEqual([s['name'] for s in scan['new_skills']], ['box-care'])
        result = call('import', import_id=scan['import_id'], dest='oscar-os', chats=True, skills='all', personality=True,
                      facts=True, about={'facts': ['Ana lives in Lisbon.']})
        self.assertTrue(result['success'], result)
        self.assertEqual(result['errors'], {})
        self.assertEqual(result['done']['facts']['facts_added'], 2)
        self.assertTrue(result['done']['facts']['provider_on'])
        self.assertEqual((dest / 'SOUL.md').read_text('utf-8'), 'You are Oscar, direct and kind.\n')
        self.assertTrue((dest / 'skills/imported/box-care/SKILL.md').is_file())
        self.assertFalse((dest / 'skills/imported/box-care/token.txt').exists())
        con = sqlite3.connect(dest / 'memory_store.db')
        self.assertEqual(sorted(r[0] for r in con.execute('SELECT content FROM facts')),
                         ['Ana likes plain words.', 'Ana’s box is called garden-box.'])
        self.assertEqual(con.execute("SELECT trust_score FROM facts WHERE category = 'preference'").fetchone()[0], 0.7)
        self.assertEqual(con.execute("SELECT count(*) FROM facts_fts WHERE facts_fts MATCH 'plain'").fetchone()[0], 1)
        con.close()
        self.assertTrue(list((self.files / 'Imported/Hermes/Chats').rglob('*Plan the move*.md')))
        self.assertTrue((dest / 'cache/bring-data/imports.json').is_file())
        self.assertEqual(self.tree(own), before)  # the source agent is only read
        self.assertNotIn(CANARY, self.written())
        for name in ('.env', 'auth.json', 'config.yaml'):
            self.assertNotIn(CANARY, (dest / name).read_text('utf-8') if (dest / name).exists() else '')
        self.assertEqual(call('status')['imports'], [])  # this agent's own list stays empty
        listed = call('status', dest='oscar-os')['imports']
        self.assertEqual([(i['facts_added'], i['personality']) for i in listed], [(2, True)])
        undone = call('undo', import_id=scan['import_id'], dest='oscar-os')
        self.assertTrue(undone['success'], undone)
        self.assertEqual(undone['removed_facts'], 2)
        self.assertEqual(undone['personality'], 'removed')
        self.assertFalse((dest / 'SOUL.md').exists())
        self.assertFalse((dest / 'skills/imported/box-care').exists())
        self.assertEqual(self.tree(own), before)

    def test_facts_merge_into_an_existing_store_and_undo_keeps_the_agents_own(self):
        own = self.alongside_hermes()
        dest = self.container_agent(self.registry(), 'studio', 'Studio')
        fact_store(dest / 'memory_store.db', [('Ana likes plain words.', 'general', 0.4), ('Studio fact.', 'general', 0.5)])
        scan = call('scan', path=str(own), dest='studio')
        self.assertEqual(scan['fact_store'], {'found': 2, 'here': 2})
        done = call('import', import_id=scan['import_id'], dest='studio', facts=True)['done']['facts']
        self.assertEqual((done['facts_added'], done['already_here']), (1, 1))
        call('undo', import_id=scan['import_id'], dest='studio')
        con = sqlite3.connect(dest / 'memory_store.db')
        self.assertEqual(sorted((r[0], r[1]) for r in con.execute('SELECT content, trust_score FROM facts')),
                         [('Ana likes plain words.', 0.4), ('Studio fact.', 0.5)])
        con.close()

    def test_fact_store_into_this_agent_from_another_hermes(self):
        other = self.alongside_hermes()
        os.environ['HERMES_HOME'] = str(self.home)
        scan = call('scan', path=str(other))
        self.assertEqual(scan['counts']['facts'], 2)
        done = call('import', import_id=scan['import_id'], facts=True)
        self.assertEqual(done['done']['facts']['facts_added'], 2)
        self.assertTrue((self.home / 'memory_store.db').is_file())

    def test_only_writable_standard_agents_are_destinations(self):
        own = self.alongside_hermes()
        registry = self.registry()
        self.container_agent(registry, 'sealed', 'Sealed', isolation='restricted')
        self.container_agent(registry, 'arriving', 'Arriving', admission='importing')
        unprepared = self.container_agent(registry, 'bare', 'Bare')
        (unprepared / 'config.yaml').unlink()
        (registry / 'Bad_Id').mkdir()
        escape = self.container_agent(registry, 'escape', 'Escape')
        shutil.rmtree(escape)
        escape.symlink_to(own, target_is_directory=True)
        self.assertEqual(call('sources')['into'], [])
        refused = call('scan', path=str(own), dest='sealed')
        self.assertFalse(refused['success'])
        self.assertIn('not on this box', refused['error'])
        self.assertFalse(call('scan', path=str(own), dest='../user')['success'])

    def test_files_not_writable_is_caught_before_and_after_and_a_rerun_brings_only_the_rest(self):
        """An owner's real Claude Code import: the Files root belongs to the Files app's user, so the agent could not create
        Files/Imported. Skills came in; chats and About me failed with a raw "[Errno 13] Permission denied: <path>"."""
        cc = claude_code_home(self.base)
        os.chmod(self.files, 0o555)
        self.addCleanup(os.chmod, self.files, 0o755)
        scan = call('scan', path=str(cc))
        self.assertEqual(set(scan['blocked']), {'chats', 'about'})
        self.assertIn('Files › Imported', scan['blocked']['chats'])
        result = call('import', import_id=scan['import_id'], chats=True, skills='all', about={'facts': ['I am Ana.']})
        self.assertTrue(result['success'], result)
        self.assertEqual(set(result['errors']), {'chats', 'about'})
        for reason in result['errors'].values():
            self.assertNotIn('Errno', reason)
            self.assertNotIn(str(self.files), reason)
            self.assertIn('Try again', reason)
        self.assertTrue(result['done']['skills']['installed'])
        self.assertEqual(result['done']['about']['memory_added'], 1)  # memory still saved without the file
        os.chmod(self.files, 0o755)
        self.assertEqual(call('scan', path=str(cc))['blocked'], {})
        again = call('import', import_id=scan['import_id'], chats=True, skills='all', about={'facts': ['I am Ana.']})
        self.assertEqual(again['errors'], {})
        self.assertEqual(again['done']['chats']['chats_written'], 2)
        self.assertEqual(again['done']['skills']['installed'], [])
        self.assertEqual((again['done']['about']['memory_added'], again['done']['about']['already_known']), (0, 1))
        self.assertTrue((self.files / 'Imported/About me.md').is_file())

    def test_allowed_paths(self):
        cc = claude_code_home(self.base)
        self.assertTrue(bd.allowed_path(str(cc)))
        self.assertTrue(bd.allowed_path('Inbox/export.zip'))
        self.assertFalse(bd.allowed_path('/etc'))
        self.assertFalse(bd.allowed_path(str(self.base / 'user')))
        self.assertFalse(bd.allowed_path('../agent'))

    # ------------------------------------------------------------------ preview mode
    def test_read_only_preview_writes_nothing(self):
        cc = claude_code_home(self.base)
        os.environ['WIZARD_BRING_DATA_READ_ONLY'] = '1'
        result = call('scan', path=str(cc))
        self.assertTrue(result['success'], result)
        self.assertTrue(result['read_only'])
        self.assertEqual(list(self.home.rglob('*')), [])  # not even the scan record
        for action, args in (('import', {'import_id': result['import_id'], 'chats': True}),
                             ('archive', {'path': str(cc)}), ('remember', {'facts': ['x']}),
                             ('undo', {'import_id': result['import_id']})):
            refused = call(action, **args)
            self.assertFalse(refused['success'], action)
            self.assertIn('preview mode', refused['error'])
        self.assertEqual(list(self.home.rglob('*')), [])
        self.assertEqual([p for p in self.files.rglob('*') if p.is_file()], [])

    # ------------------------------------------------------------------ memory card + personality
    def test_card_respects_memory_budget_and_keeps_owner_entries(self):
        self.memory.entries = ['Owner wrote this']
        cc = claude_code_home(self.base)
        scan = call('scan', path=str(cc))
        facts = ['Owner wrote this', 'Lives in Lisbon', 'A' * 120]
        result = call('import', import_id=scan['import_id'],
                      about={'facts': facts, 'text': '# About me\n\nLives in Lisbon.\n'})
        about = result['done']['about']
        self.assertEqual((about['memory_added'], about['already_known'], len(about['not_added'])), (1, 1, 1))
        self.assertIn('About me.md', about['note'])
        self.assertEqual(self.memory.entries, ['Owner wrote this', 'Lives in Lisbon'])
        call('undo', import_id=scan['import_id'])
        self.assertEqual(self.memory.entries, ['Owner wrote this'])  # the owner's own entry stays

    def test_about_me_restored_and_owner_edit_kept(self):
        (self.files / 'Imported').mkdir()
        (self.files / 'Imported/About me.md').write_text('# About me\n\nOlder text.\n', 'utf-8')
        cc = claude_code_home(self.base)
        scan = call('scan', path=str(cc))
        call('import', import_id=scan['import_id'], about={'facts': ['Lives in Lisbon']})
        self.assertNotIn('Older text', (self.files / 'Imported/About me.md').read_text('utf-8'))
        self.assertEqual(call('undo', import_id=scan['import_id'])['about'], 'restored')
        self.assertEqual((self.files / 'Imported/About me.md').read_text('utf-8'), '# About me\n\nOlder text.\n')
        scan = call('scan', path=str(cc))
        call('import', import_id=scan['import_id'], about={'facts': ['Lives in Lisbon']})
        (self.files / 'Imported/About me.md').write_text('Owner edited it', 'utf-8')
        self.assertEqual(call('undo', import_id=scan['import_id'])['about'], 'kept (changed since the import)')
        self.assertEqual((self.files / 'Imported/About me.md').read_text('utf-8'), 'Owner edited it')

    def test_personality_replaces_and_undo_restores(self):
        old = self.base / 'old-hermes'
        (old / 'memories').mkdir(parents=True)
        (old / 'SOUL.md').write_text('You are Oscar: direct and warm.', 'utf-8')
        (self.home / 'SOUL.md').write_text('You are the new agent.', 'utf-8')
        os.environ['WIZARD_BRING_DATA_LOCAL_ROOTS'] = str(self.base)
        scan = call('scan', path=str(old))
        self.assertEqual(scan['personality'], {'found': True, 'here': 'custom'})
        result = call('import', import_id=scan['import_id'], personality=True)
        self.assertEqual(result['errors'], {})
        self.assertEqual((self.home / 'SOUL.md').read_text('utf-8'), 'You are Oscar: direct and warm.\n')
        self.assertEqual(call('undo', import_id=scan['import_id'])['personality'], 'restored')
        self.assertEqual((self.home / 'SOUL.md').read_text('utf-8'), 'You are the new agent.')

    def test_undo_out_of_order_still_restores_the_original_personality(self):
        # Codex P1 on #336: undoing the older of two personality imports first dropped its backup.
        (self.home / 'SOUL.md').write_text('Owner original.', 'utf-8')
        os.environ['WIZARD_BRING_DATA_LOCAL_ROOTS'] = str(self.base)
        ids = []
        for name in ('first', 'second'):
            src = self.base / name
            (src / 'memories').mkdir(parents=True)
            (src / 'SOUL.md').write_text(f'You are {name}.', 'utf-8')
            scan = call('scan', path=str(src))
            self.assertEqual(call('import', import_id=scan['import_id'], personality=True)['errors'], {})
            ids.append(scan['import_id'])
        self.assertEqual((self.home / 'SOUL.md').read_text('utf-8'), 'You are second.\n')
        self.assertTrue(call('undo', import_id=ids[0])['personality'].startswith('kept'))
        self.assertEqual((self.home / 'SOUL.md').read_text('utf-8'), 'You are second.\n')
        self.assertEqual(call('undo', import_id=ids[1])['personality'], 'restored')
        self.assertEqual((self.home / 'SOUL.md').read_text('utf-8'), 'Owner original.')

    def test_all_skills_brings_every_new_one(self):
        cc = claude_code_home(self.base)
        scan = call('scan', path=str(cc))
        result = call('import', import_id=scan['import_id'], skills='all')
        self.assertEqual({i['name'] for i in result['done']['skills']['installed']}, {'pdf', 'deploy', 'reviewer'})
        self.assertEqual([s['name'] for s in result['done']['skills']['skipped']], ['leak'])  # key-like: left behind

    def test_import_needs_a_scan_and_a_choice(self):
        self.assertIn('Scan', call('import', import_id='nope', chats=True)['error'])
        cc = claude_code_home(self.base)
        scan = call('scan', path=str(cc))
        self.assertIn('Choose', call('import', import_id=scan['import_id'])['error'])

    def test_agent_tool_schema_is_unchanged(self):
        # The model's tool keeps its six actions; memory writes stay with the stock memory tool in chat.
        self.assertEqual(bd.SCHEMA['parameters']['properties']['action']['enum'],
                         ['scan', 'archive', 'skills', 'save_profile', 'status', 'undo'])


if __name__ == '__main__':
    unittest.main()
