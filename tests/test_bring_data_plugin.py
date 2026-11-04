"""wizard-os plugin bring_data.py: Bring my ChatGPT / Claude / Hermes.

Fixtures are synthetic and tiny, built here to match the documented export schemas (see the module
docstring); no real owner data, network, installed Hermes or live service is used.
"""
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / 'hermes-plugin/wizard-os'
spec = importlib.util.spec_from_file_location('wizard_os_bring_data', PLUGIN / 'bring_data.py')
bd = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bd
spec.loader.exec_module(bd)

CANARY = 'sk-ant-' + 'A' * 40  # key-shaped canary that must never leave the source


def call(**args):
    return json.loads(bd.handle(args))


def node(mid, parent, children, role=None, text=None, ctype='text', t=0.0, **extra):
    msg = None
    if role:
        content = {'content_type': ctype}
        if ctype in ('text', 'multimodal_text'):
            content['parts'] = text if isinstance(text, list) else [text]
        content.update(extra.pop('content', {}))
        msg = {'id': mid, 'author': {'role': role}, 'create_time': t, 'content': content,
               'metadata': extra.pop('metadata', {}), 'recipient': extra.pop('recipient', 'all')}
    return mid, {'id': mid, 'message': msg, 'parent': parent, 'children': children}


def chatgpt_export():
    trip = dict([
        node('root', None, ['sys']),
        node('sys', 'root', ['ctx'], 'system', ''),
        node('ctx', 'sys', ['mem'], 'user', ctype='user_editable_context', t=1700000000,
             content={'user_profile': 'I am Ana, a nurse in Lisbon.', 'user_instructions': 'Be brief.'}),
        node('mem', 'ctx', ['u1'], 'user', ctype='model_editable_context', t=1700000000,
             content={'model_set_context': '1. [2024-01-02]. Has a dog called Pico.\n2. [2024-02-03]. Training for a half marathon.'}),
        node('u1', 'mem', ['a-old', 'a-new'], 'user', 'Plan a trip to Porto', t=1700000001),
        node('a-old', 'u1', [], 'assistant', 'OLD BRANCH ANSWER', t=1700000002),
        node('a-new', 'u1', ['hidden'], 'assistant', 'Day 1: Ribeira.', t=1700000003),
        node('tool', 'hidden', ['img'], 'assistant', ctype='code', recipient='python', t=1700000004,
             content={'text': 'print(1)'}),
        node('hidden', 'a-new', ['tool'], 'assistant', 'HIDDEN', t=1700000004,
             metadata={'is_visually_hidden_from_conversation': True}),
        node('img', 'tool', [], 'user', ['Here is a photo', {'content_type': 'image_asset_pointer', 'asset_pointer': 'file-service://x'}],
             ctype='multimodal_text', t=1700000005),
    ])
    return [
        {'title': 'Porto trip', 'create_time': 1700000000.5, 'update_time': 1700000005.0, 'mapping': trip,
         'current_node': 'img', 'conversation_id': 'c0ffee00-1111', 'gizmo_id': None},
        {'title': 'Marathon training plan', 'create_time': 1710000000, 'update_time': 1710000100,
         'mapping': dict([node('r', None, ['q']), node('q', 'r', ['a'], 'user', 'Half marathon plan?', t=1710000000),
                          node('a', 'q', [], 'assistant', '12 weeks.', t=1710000050)]),
         'current_node': 'a', 'id': 'beef-2222'},
        {'title': 'Empty', 'create_time': 1710000000, 'mapping': {}, 'current_node': None, 'id': 'empty-3'},
    ]


def claude_export():
    convs = [{
        'uuid': 'aaaa1111-2222', 'name': 'Garden layout', 'summary': 'Planning raised beds.',
        'created_at': '2025-03-01T10:00:00.000000+00:00', 'updated_at': '2025-03-01T11:00:00Z',
        'account': {'uuid': 'acct'},
        'chat_messages': [
            {'uuid': 'm1', 'sender': 'human', 'text': 'fallback text', 'created_at': '2025-03-01T10:00:00Z',
             'content': [{'type': 'text', 'text': 'Help me lay out tomato beds'}],
             'attachments': [{'file_name': 'plot.txt', 'file_size': 10, 'file_type': 'txt', 'extracted_content': '4m x 2m'}],
             'files': [{'file_name': 'photo.jpg'}]},
            {'uuid': 'm2', 'sender': 'assistant', 'text': '', 'created_at': '2025-03-01T10:01:00Z',
             'content': [{'type': 'text', 'text': 'Two beds of 1.2m.'}, {'type': 'tool_use', 'name': 'x', 'input': {}}]},
        ]}]
    projects = [{'uuid': 'p1', 'name': 'Allotment', 'description': 'My veg plot', 'prompt_template': 'Use metric units.',
                 'is_starter_project': False, 'docs': [{'uuid': 'd', 'filename': 'soil.md', 'content': 'Clay soil.'}]},
                {'uuid': 'p0', 'name': 'How to use Claude', 'is_starter_project': True, 'docs': []}]
    memories = [{'conversations_memory': 'Ana grows tomatoes and prefers metric units.',
                 'project_memories': {'p1': 'Purpose: allotment planning.'}, 'account_uuid': 'acct'}]
    users = [{'uuid': 'acct', 'full_name': 'Ana Silva', 'email_address': 'ana@example.com'}]
    return convs, projects, memories, users


def hermes_home(base: Path) -> Path:
    home = base / 'old-hermes'
    (home / 'memories').mkdir(parents=True)
    (home / 'memories/USER.md').write_text('Owner is Ana; vegetarian.\n§\nLives in Lisbon.\n', 'utf-8')
    (home / 'memories/MEMORY.md').write_text('Ana\'s server is a Raspberry Pi.\n', 'utf-8')
    (home / 'SOUL.md').write_text('You are calm and concise.', 'utf-8')
    (home / '.env').write_text(f'ANTHROPIC_API_KEY={CANARY}\n', 'utf-8')
    (home / 'auth.json').write_text(json.dumps({'t': CANARY}), 'utf-8')
    (home / 'secrets').mkdir()
    (home / 'secrets/k.txt').write_text(CANARY, 'utf-8')
    skill = home / 'skills/cooking/meal-plan'
    (skill / 'references').mkdir(parents=True)
    (skill / 'SKILL.md').write_text('---\nname: meal-plan\ndescription: Plan weekly vegetarian meals.\n---\n# Meal plan\n', 'utf-8')
    (skill / 'references/recipes.md').write_text('Lentil soup.', 'utf-8')
    (skill / '.env').write_text(f'KEY={CANARY}', 'utf-8')
    (skill / 'notes.md').write_text(f'old key {CANARY}', 'utf-8')
    (home / 'skills/cooking/DESCRIPTION.md').write_text('Cooking skills', 'utf-8')
    dup = home / 'skills/existing-one'
    dup.mkdir(parents=True)
    (dup / 'SKILL.md').write_text('---\nname: existing-one\ndescription: Already here.\n---\n', 'utf-8')
    (home / 'skills/.archive/old').mkdir(parents=True)
    (home / 'skills/.archive/old/SKILL.md').write_text('---\nname: archived\n---\n', 'utf-8')
    con = sqlite3.connect(home / 'state.db')
    con.executescript('''
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, parent_session_id TEXT, started_at REAL NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL);
      INSERT INTO sessions VALUES ('s1','telegram','Bike repair',NULL,1720000000);
      INSERT INTO sessions VALUES ('s2','cli','child',  's1',1720000001);
      INSERT INTO sessions VALUES ('s3','cron','nightly',NULL,1720000002);
      INSERT INTO sessions VALUES ('wizard_17200_a','api_server','Same title',NULL,1720000010);
      INSERT INTO sessions VALUES ('wizard_17200_b','api_server','Same title',NULL,1720000011);
      INSERT INTO messages (session_id, role, content, timestamp) VALUES
        ('s1','user','My chain keeps slipping',1720000000), ('s1','tool','{"x":1}',1720000001),
        ('s1','assistant','Check the derailleur.',1720000002), ('s2','user','child text',1720000003),
        ('s3','user','cron text',1720000004),
        ('s1','user','[{"type":"text","text":"Thanks, fixed"}]',1720000005),
        ('wizard_17200_a','user','first twin',1720000010),
        ('wizard_17200_b','user','<memory-context>INJECTED</memory-context>second twin',1720000011),
        ('wizard_17200_b','assistant','ok [WIZARD_STATUS_V1]{"state":"done"}[/WIZARD_STATUS_V1]',1720000012);
    ''')
    con.commit()
    con.close()
    return home


def zip_dir(src: Path, dest: Path, prefix: str = '') -> Path:
    with zipfile.ZipFile(dest, 'w') as zf:
        for path in sorted(src.rglob('*')):
            if path.is_file():
                zf.write(path, prefix + path.relative_to(src).as_posix())
    return dest


class BringDataTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.home = self.base / 'hermes'
        self.files = self.base / 'media'
        (self.files / 'Inbox').mkdir(parents=True)
        (self.home / 'skills/existing/existing-one').mkdir(parents=True)
        (self.home / 'skills/existing/existing-one/SKILL.md').write_text('---\nname: existing-one\n---\n', 'utf-8')
        self.env = {k: os.environ.get(k) for k in ('HERMES_HOME', 'WIZARD_FILES_ROOT')}
        os.environ['HERMES_HOME'] = str(self.home)
        os.environ['WIZARD_FILES_ROOT'] = str(self.files)

    def tearDown(self):
        for k, v in self.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def write_zip(self, name, members):
        path = self.files / 'Inbox' / name
        with zipfile.ZipFile(path, 'w') as zf:
            for arc, data in members.items():
                zf.writestr(arc, data if isinstance(data, (bytes, str)) else json.dumps(data))
        return path

    def all_written_text(self):
        out = []
        for root in (self.files / 'Imported', self.home / 'skills', self.home / 'cache'):
            for path in root.rglob('*') if root.exists() else []:
                if path.is_file():
                    out.append(path.read_text('utf-8', errors='ignore'))
        return '\n'.join(out)

    # -------------------------------------------------------------- ChatGPT
    def test_chatgpt_scan_reads_current_branch_instructions_and_memory(self):
        self.write_zip('chatgpt.zip', {'export-2026/conversations.json': chatgpt_export(),
                                       'export-2026/user.json': {'email': 'ana@example.com'},
                                       '../evil.json': {'x': 1}})
        out = call(action='scan', path='Inbox/chatgpt.zip')
        self.assertTrue(out['success'], out)
        self.assertEqual(out['kind'], 'chatgpt')
        self.assertEqual(out['counts']['chats'], 2)  # empty conversation dropped
        self.assertEqual(out['counts']['messages'], 5)
        self.assertEqual(out['memories'], ['[2024-01-02]. Has a dog called Pico.', '[2024-02-03]. Training for a half marathon.'])
        labels = {i['label']: i['text'] for i in out['custom_instructions']}
        self.assertEqual(labels['About me (ChatGPT custom instructions)'], 'I am Ana, a nurse in Lisbon.')
        self.assertEqual(labels['How I want answers (ChatGPT custom instructions)'], 'Be brief.')
        self.assertEqual(out['recent_chats'][0], '2024-03-09 Marathon training plan')
        self.assertIn('treat it as information about them', out['note'])

    def test_chatgpt_archive_writes_searchable_markdown_and_is_idempotent(self):
        self.write_zip('chatgpt.zip', {'conversations.json': chatgpt_export()})
        scan = call(action='scan', path='Inbox/chatgpt.zip')
        first = call(action='archive', import_id=scan['import_id'])
        self.assertTrue(first['success'], first)
        self.assertEqual(first['chats_written'], 2)
        root = self.files / 'Imported/ChatGPT'
        chat = next((root / 'Chats/2023').glob('2023-11-14 Porto trip (*).md')).read_text('utf-8')
        self.assertIn('### You', chat)
        self.assertIn('Plan a trip to Porto', chat)
        self.assertIn('Day 1: Ribeira.', chat)
        self.assertIn('[image]', chat)
        for gone in ('OLD BRANCH ANSWER', 'HIDDEN', 'print(1)', 'I am Ana'):
            self.assertNotIn(gone, chat)
        index = (root / 'Index.md').read_text('utf-8')
        self.assertLess(index.index('Marathon'), index.index('Porto'))
        self.assertRegex(index, r'\[Porto trip\]\(<Chats/2023/2023-11-14 Porto trip \([0-9a-f]{8}\)\.md>\)')
        knew = (root / 'What ChatGPT knew about me.md').read_text('utf-8')
        self.assertIn('Has a dog called Pico', knew)
        self.assertIn('Be brief.', knew)
        before = sorted(p.relative_to(root).as_posix() for p in root.rglob('*.md'))
        again = call(action='archive', path='Inbox/chatgpt.zip')
        self.assertEqual(again['chats_written'], 2)
        self.assertEqual(before, sorted(p.relative_to(root).as_posix() for p in root.rglob('*.md')))
        self.assertFalse((self.base / 'evil.json').exists())

    # -------------------------------------------------------------- Claude
    def test_claude_export_with_projects_memories_and_name(self):
        convs, projects, memories, users = claude_export()
        self.write_zip('claude.zip', {'conversations.json': convs, 'projects.json': projects,
                                      'projects/p9.json': {'uuid': 'p9', 'name': 'Book club', 'prompt_template': 'Spoiler-free.', 'docs': []},
                                      'memories.json': memories, 'users.json': users})
        out = call(action='scan', path=str(self.files / 'Inbox/claude.zip'))
        self.assertTrue(out['success'], out)
        self.assertEqual(out['kind'], 'claude')
        self.assertEqual(out['account_name'], 'Ana Silva')
        self.assertEqual(out['counts']['chats'], 1)
        self.assertEqual(out['memories'], ['Ana grows tomatoes and prefers metric units.'])
        self.assertEqual([p['name'] for p in out['projects']], ['Allotment', 'Book club'])
        self.assertEqual(out['projects'][0]['memory'], 'Purpose: allotment planning.')
        res = call(action='archive', import_id=out['import_id'])
        self.assertEqual(res['chats_written'], 1)
        root = self.files / 'Imported/Claude'
        chat = next((root / 'Chats/2025').glob('*.md')).read_text('utf-8')
        self.assertIn('Help me lay out tomato beds', chat)
        self.assertNotIn('fallback text', chat)
        self.assertIn('Attached: plot.txt', chat)
        self.assertIn('4m x 2m', chat)
        self.assertIn('File: photo.jpg', chat)
        self.assertIn('### Claude', chat)
        self.assertIn('> Planning raised beds.', chat)
        project = next((root / 'Projects').glob('Allotment (*).md')).read_text('utf-8')
        self.assertIn('Use metric units.', project)
        self.assertIn('Clay soil.', project)
        self.assertEqual(len(list((root / 'Projects').glob('How to use Claude*'))), 0)
        self.assertNotIn('ana@example.com', self.all_written_text())

    def test_projects_with_colliding_names_keep_separate_files(self):
        convs, _p, _m, _u = claude_export()
        projects = [{'uuid': 'p-a', 'name': 'A/B', 'prompt_template': 'first'},
                    {'uuid': 'p-b', 'name': 'A:B', 'prompt_template': 'second'},
                    {'uuid': 'p-c', 'name': 'A/B', 'prompt_template': 'third'}]
        self.write_zip('claude3.zip', {'conversations.json': convs, 'projects.json': projects})
        res = call(action='archive', path='Inbox/claude3.zip')
        self.assertEqual(res['other_files'], 3)
        texts = sorted(p.read_text('utf-8') for p in (self.files / 'Imported/Claude/Projects').glob('*.md'))
        self.assertEqual(len(texts), 3)
        for word in ('first', 'second', 'third'):
            self.assertTrue(any(word in t for t in texts), word)

    def test_undo_removes_only_what_that_import_wrote(self):
        older = chatgpt_export()[:1]  # Porto only
        newer = chatgpt_export()      # Porto + Marathon
        self.write_zip('old.zip', {'conversations.json': older})
        self.write_zip('new.zip', {'conversations.json': newer})
        old_id = call(action='scan', path='Inbox/old.zip')['import_id']
        new_id = call(action='scan', path='Inbox/new.zip')['import_id']
        call(action='archive', import_id=old_id)
        call(action='archive', import_id=new_id)
        root = self.files / 'Imported/ChatGPT'
        self.assertEqual((root / 'Index.md').read_text('utf-8').count('| 20'), 2)
        old_hermes = hermes_home(self.base)
        hermes_id = call(action='scan', path=str(old_hermes))['import_id']
        call(action='skills', import_id=hermes_id, names=['meal-plan'])
        call(action='save_profile', text='Ana.')

        res = call(action='undo', import_id=new_id)
        self.assertTrue(res['success'], res)
        self.assertEqual(res['removed_files'], 1)  # Marathon only: Porto is also the older import's
        self.assertEqual(len(list(root.glob('Chats/2023/*Porto*.md'))), 1)
        self.assertEqual(list(root.glob('Chats/2024/*.md')), [])
        index = (root / 'Index.md').read_text('utf-8')
        self.assertIn('Porto trip', index)
        self.assertNotIn('Marathon', index)
        self.assertTrue((self.home / 'skills/imported/meal-plan/SKILL.md').exists())  # another import's skill
        self.assertTrue((self.files / 'Imported/About me.md').exists())

        self.assertEqual(call(action='undo', import_id=hermes_id)['removed_skills'], ['meal-plan'])
        self.assertFalse((self.home / 'skills/imported/meal-plan').exists())
        self.assertEqual(call(action='undo', import_id=old_id)['removed_files'], 1)
        self.assertFalse(root.exists())  # last ChatGPT import gone: folder, index and 'what it knew' go too
        self.assertTrue((self.files / 'Imported/About me.md').exists())
        self.assertEqual(call(action='status')['imports'], [])
        self.assertFalse(call(action='undo', import_id=old_id)['success'])

    def test_claude_memories_object_form(self):
        convs, _p, _m, _u = claude_export()
        self.write_zip('claude2.zip', {'conversations.json': convs,
                                       'memories.json': {'conversations_memory': 'Prefers mornings.', 'project_memories': {}}})
        out = call(action='scan', path='Inbox/claude2.zip')
        self.assertEqual(out['memories'], ['Prefers mornings.'])

    # -------------------------------------------------------------- Hermes
    def test_hermes_folder_scan_archive_and_skills_without_secrets(self):
        old = hermes_home(self.base)
        out = call(action='scan', path=str(old))
        self.assertTrue(out['success'], out)
        self.assertEqual(out['kind'], 'hermes')
        self.assertEqual(out['memories'], ['Owner is Ana; vegetarian.', 'Lives in Lisbon.', "Ana's server is a Raspberry Pi."])
        self.assertEqual(out['soul'], 'You are calm and concise.')
        self.assertEqual(out['counts']['chats'], 3)  # child and cron sessions left out
        self.assertEqual([s['name'] for s in out['new_skills']], ['meal-plan'])
        self.assertEqual(out['skills_already_here'], 1)  # existing-one; .archive is ignored
        self.assertEqual(sorted(out['new_skills'][0]['left_behind']),
                         ['.env (looks like a key or credential file)', 'notes.md (contains what looks like a key or token)'])
        self.assertNotIn(CANARY, json.dumps(out))

        st = old.stat()
        os.utime(old, (st.st_atime, st.st_mtime + 100))  # a live Hermes home changes while we read it
        self.assertEqual(call(action='archive', path=str(old))['chats_written'], 3)
        files = sorted((self.files / 'Imported/Hermes/Chats/2024').glob('*.md'))
        self.assertEqual(len(files), 3)  # ids sharing a prefix never overwrite each other
        twins = '\n'.join(f.read_text('utf-8') for f in files if 'Same title' in f.name)
        self.assertIn('first twin', twins)
        self.assertIn('second twin', twins)
        self.assertNotIn('INJECTED', twins)
        self.assertNotIn('WIZARD_STATUS', twins)
        chat = next(f for f in files if 'Bike repair' in f.name).read_text('utf-8')
        self.assertIn('My chain keeps slipping', chat)
        self.assertIn('Thanks, fixed', chat)
        self.assertNotIn('{"x":1}', chat)

        res = call(action='skills', import_id=out['import_id'], names=['meal-plan', 'existing-one', 'nope'])
        self.assertTrue(res['success'], res)
        self.assertEqual([s['name'] for s in res['installed']], ['meal-plan'])
        self.assertEqual(res['skipped'][0]['name'], 'existing-one')
        self.assertEqual(res['not_found'], ['nope'])
        dest = self.home / 'skills/imported/meal-plan'
        self.assertTrue((dest / 'SKILL.md').exists())
        self.assertEqual((dest / 'references/recipes.md').read_text('utf-8'), 'Lentil soup.')
        self.assertFalse((dest / '.env').exists())
        self.assertFalse((dest / 'notes.md').exists())
        self.assertTrue((dest / '.imported-from.json').exists())
        self.assertNotIn(CANARY, self.all_written_text())
        again = call(action='skills', import_id=out['import_id'], names=['meal-plan'])
        self.assertEqual(again['installed'], [])
        self.assertEqual(again['skipped'][0]['reason'], 'a skill with this name is already installed')
        undone = call(action='undo', import_id=out['import_id'])
        self.assertEqual((undone['removed_files'], undone['removed_skills']), (3, ['meal-plan']))
        self.assertFalse((self.files / 'Imported/Hermes').exists())

    def test_hermes_backup_zip(self):
        old = hermes_home(self.base)
        zip_dir(old, self.files / 'Inbox/hermes-backup.zip')
        out = call(action='scan', path='Inbox/hermes-backup.zip')
        self.assertEqual(out['kind'], 'hermes')
        self.assertEqual(out['counts']['chats'], 3)
        res = call(action='skills', import_id=out['import_id'], names=['meal-plan'])
        self.assertEqual([s['name'] for s in res['installed']], ['meal-plan'])
        self.assertNotIn(CANARY, self.all_written_text())

    # -------------------------------------------------------------- profile, status, errors
    def test_save_profile_and_status(self):
        res = call(action='save_profile', text='Ana is a nurse in Lisbon.\n- Dog: Pico')
        self.assertTrue(res['success'], res)
        text = (self.files / 'Imported/About me.md').read_text('utf-8')
        self.assertTrue(text.startswith('# About me\n\nAna is a nurse'))
        self.assertIn('Reviewed and saved by you', text)
        self.write_zip('c.zip', {'conversations.json': chatgpt_export()})
        call(action='scan', path='Inbox/c.zip')
        self.assertEqual(call(action='status')['imports'][0]['kind'], 'chatgpt')

    def test_errors_are_plain(self):
        (self.files / 'Inbox/notes.txt').write_text('hello', 'utf-8')
        self.write_zip('random.zip', {'photo.jpg': b'\xff\xd8'})
        for args, words in (({'action': 'scan', 'path': 'Inbox/missing.zip'}, 'Nothing at'),
                            ({'action': 'scan', 'path': 'Inbox/notes.txt'}, 'not a zip'),
                            ({'action': 'scan', 'path': 'Inbox/random.zip'}, "doesn't look like"),
                            ({'action': 'archive', 'import_id': 'nope'}, 'Run scan first'),
                            ({'action': 'save_profile', 'text': ''}, 'profile text'),
                            ({'action': 'explode'}, 'action must be')):
            out = call(**args)
            self.assertFalse(out['success'])
            self.assertIn(words, out['error'])

    def test_plugin_registers_tool(self):
        init = importlib.util.spec_from_file_location('wizard_os_plugin_bd', PLUGIN / '__init__.py',
                                                      submodule_search_locations=[str(PLUGIN)])
        mod = importlib.util.module_from_spec(init)
        sys.modules[init.name] = mod
        init.loader.exec_module(mod)
        tools = []
        mod.register(types.SimpleNamespace(register_tool=lambda **kw: tools.append(kw),
                                           register_system_prompt_section=lambda *a, **k: None))
        names = [t['name'] for t in tools]
        self.assertEqual(names[0], 'wizard_follow_up')
        self.assertIn('wizard_bring_data', names)
        schema = next(t for t in tools if t['name'] == 'wizard_bring_data')['schema']
        self.assertEqual(schema['parameters']['properties']['action']['enum'],
                         ['scan', 'archive', 'skills', 'save_profile', 'status', 'undo'])


if __name__ == '__main__':
    unittest.main()
