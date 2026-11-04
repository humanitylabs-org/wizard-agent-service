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
        self.assertEqual(local, {('claude-code', 'Claude Code on this box'), ('hermes', 'Hermes on this box'),
                                 ('hermes', 'Hermes profile “work”')})
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
