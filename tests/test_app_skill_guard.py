"""App workflows belong to released apps, never an agent's private skill copy."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / 'hermes-plugin/wizard-os'
spec = importlib.util.spec_from_file_location('wizard_os_guard_test', PLUGIN / '__init__.py',
                                              submodule_search_locations=[str(PLUGIN)])
assert spec is not None and spec.loader is not None
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)


class Context:
    def __init__(self, shadows=None):
        self.hooks = {}
        self.shadows = shadows or []

    def register_system_prompt_section(self, *args, **kwargs):
        pass

    def register_tool(self, **kwargs):
        pass

    def register_hook(self, name, callback):
        self.hooks[name] = callback

    def get_config(self, key, default=None):
        return self.shadows if key == 'app_skill_guard.shadow_skills' else default


class AppSkillGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / 'owner'
        self.os_home = self.home / '.wizard-os'
        self.skills = self.os_home / 'skills'
        self.skills.mkdir(parents=True)
        self.env = patch.dict(os.environ, {'HOME': str(self.home), 'WIZARD_OS_HOME': str(self.os_home)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.registry([{'id': 'video-app', 'skill': 'SKILL.md'}, {'id': 'registry-only', 'skill': 'SKILL.md'}])
        self.skill('video-app', 'video-editing')
        self.skill('wisdom-app', 'wisdom-editing')
        self.skill('wizard-job-files', 'wizard-job-files')
        undo = plugin._app_skill_guard._undo
        undo._reset_for_tests()
        self.addCleanup(undo._reset_for_tests)
        for name, value in (('WATCH_SECONDS', 0), ('CALL_GRACE_SECONDS', 0.01)):
            patcher = patch.object(undo, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.ctx = Context()
        plugin.register(self.ctx)

    def registry(self, apps):
        (self.os_home / 'apps.json').write_text(json.dumps({'apps': apps}))

    def skill(self, app, name, root=None):
        target = (root or self.skills) / app / 'SKILL.md'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f'---\nname: {name}\ndescription: Synthetic app workflow.\n---\n')

    def call(self, tool, **args):
        self.assertIn('pre_tool_call', self.ctx.hooks, 'product must register the guard')
        return self.ctx.hooks['pre_tool_call'](tool_name=tool, args=args, task_id='synthetic')

    def blocked(self, tool, **args):
        result = self.call(tool, **args)
        self.assertEqual(result['action'], 'block')
        self.assertIn("app's source", result['message'])
        return result

    def manage(self, name, **kwargs):
        return {'operations': [{'name': name, 'action': 'patch', 'old_string': 'a', 'new_string': 'abc', **kwargs}]}

    def test_product_registers_guard_and_preserves_media_hook(self):
        self.assertIn('pre_tool_call', self.ctx.hooks)
        self.assertIn('transform_llm_output', self.ctx.hooks)

    def test_frontmatter_alias_and_app_id_are_blocked(self):
        for name in ('video-editing', 'video-app', 'registry-only', 'wisdom-editing'):
            with self.subTest(name=name):
                self.blocked('skill_manage', **self.manage(name))

    def test_all_skill_manage_mutations_and_batches_are_blocked(self):
        for action in ('create', 'patch', 'delete', 'write_file', 'remove_file'):
            with self.subTest(action=action):
                self.blocked('skill_manage', **self.manage('video-editing', action=action))
        self.blocked('skill_manage', operations=[{'name': 'unrelated', 'action': 'patch'},
                                                 {'name': 'video-app', 'action': 'delete'}])
        self.blocked('skill_manage', name='video-app', action='delete')

    def test_personal_shadows_are_opt_in_not_product_defaults(self):
        self.assertIsNone(self.call('skill_manage', **self.manage('personal-clips')))
        self.ctx.shadows = [{'name': 'personal-clips', 'app_id': 'video-app'}]
        self.blocked('skill_manage', **self.manage('personal-clips', new_string='Approved style rules'))
        self.assertIsNone(self.call('skill_manage', **self.manage('personal-clips', old_string='Long workflow rules', new_string='Use the app.')))
        for action in ('delete', 'remove_file'):
            self.assertIsNone(self.call('skill_manage', **self.manage('personal-clips', action=action)))

    def test_unrelated_and_routing_skills_allowed(self):
        for name in ('unrelated', 'wizard-job-files'):
            self.assertIsNone(self.call('skill_manage', **self.manage(name)))
        # Even a malformed registry must not turn routing-only skills into apps.
        self.registry([{'id': 'wizard-job-files', 'skill': 'SKILL.md'}])
        self.assertIsNone(self.call('skill_manage', **self.manage('wizard-job-files')))

    def test_direct_installed_and_store_edits_blocked(self):
        for tool, path in [('write_file', '~/.wizard-os/skills/video-app/SKILL.md'),
                           ('patch', self.skills / 'wisdom-app/SKILL.md'),
                           ('write_file', self.os_home / 'store/skills/video-app/SKILL.md')]:
            with self.subTest(tool=tool, path=path):
                self.blocked(tool, path=str(path), content='x', old_string='a', new_string='b')

    def test_apply_patch_file_headers_blocked(self):
        for action in ('Update', 'Add', 'Delete'):
            self.blocked('patch', mode='patch', patch=f'*** Begin Patch\n*** {action} File: {self.skills}/video-app/SKILL.md\n@@\n-a\n+b\n*** End Patch')

    def test_source_and_routing_paths_allowed(self):
        for path in (self.home / 'workspace/video-app/SKILL.md', self.skills / 'wizard-job-files/SKILL.md',
                     self.os_home / 'store/skills/wizard-job-files/SKILL.md', self.os_home / 'skills-backup/video-app/SKILL.md'):
            self.assertIsNone(self.call('write_file', path=str(path), content='x'))

    def test_shell_and_execute_code_writes_blocked_reads_allowed(self):
        commands = ["cat >> ~/.wizard-os/skills/video-app/SKILL.md <<'EOF'\nstyle\nEOF",
                    f"sed -i 's/a/b/' {self.skills}/wisdom-app/SKILL.md",
                    f"cp new.md {self.os_home}/store/skills/video-app/SKILL.md"]
        for command in commands:
            self.blocked('terminal', command=command)
        self.blocked('execute_code', code=f"from pathlib import Path; Path('{self.skills}/video-app/SKILL.md').write_text('style')")
        self.assertIsNone(self.call('terminal', command=f'diff {self.os_home}/store/skills/video-app/SKILL.md {self.skills}/video-app/SKILL.md'))
        self.assertIsNone(self.call('terminal', command='cat ~/.wizard-os/skills/video-app/SKILL.md'))
        self.assertIsNone(self.call('terminal', command='printf x > ~/.wizard-os/skills/wizard-job-files/SKILL.md'))

    def test_execute_code_multi_line_writes_blocked(self):
        # wizard-os issue 797: the path is built on one line and written on a later one.
        snippets = [
            "import os\np = os.path.expanduser('~/.wizard-os/skills/video-app/SKILL.md')\n"
            "s = open(p).read()\ns = s.replace('a', 'b')\nopen(p, 'w').write(s)",
            "from pathlib import Path\nhome = Path.home() / '.wizard-os'\nskill = home / 'skills' / 'video-app' / 'SKILL.md'\n"
            "text = skill.read_text()\nskill.write_text(text + 'style')",
            "import os\nroot = os.environ['WIZARD_OS_HOME']\np = os.path.join(root, 'skills', 'wisdom-app', 'SKILL.md')\n"
            "with open(p, mode='a') as f:\n    f.write('x')",
            f"import shutil\ndest = '{self.skills}/video-app/SKILL.md'\nshutil.copy('/tmp/new.md', dest)",
            f"from pathlib import Path\nd = Path('{self.os_home}/store/skills/video-app')\nfor f in [d / 'SKILL.md']:\n    f.unlink()",
            f"from pathlib import Path\np = Path('{self.skills}') / 'video-app' / 'SKILL.md'\nwith p.open('w') as f:\n    f.write('x')",
            f"import subprocess\nsubprocess.run(['cp', '/tmp/a', '{self.skills}/video-app/SKILL.md'])",
            "import subprocess\nsubprocess.run('printf x > ~/.wizard-os/skills/video-app/SKILL.md', shell=True)",
            f"from hermes_tools import write_file\nbase = '{self.skills}'\nwrite_file(f'{{base}}/video-app/SKILL.md', 'x')",
            f"from hermes_tools import patch\np = '{self.skills}/video-app/SKILL.md'\npatch(p, 'a', 'b')",
            f"import os\nname = 'SKILL.md'\nos.replace('/tmp/x', '{self.skills}/video-app/' + name)",
        ]
        for code in snippets:
            with self.subTest(code=code):
                self.blocked('execute_code', code=code)

    def test_execute_code_reads_and_other_writes_allowed(self):
        allowed = [
            f"from pathlib import Path\ntext = Path('{self.skills}/video-app/SKILL.md').read_text()\n"
            "text = text.replace('a', 'b')\nPath('/tmp/draft.md').write_text(text)",
            f"import shutil\nsrc = '{self.skills}/video-app/SKILL.md'\nshutil.copy(src, '/tmp/copy.md')",
            f"p = '{self.skills}/video-app/SKILL.md'\nwith open(p) as f:\n    body = f.read()\n"
            "open('/tmp/out.md', 'w').write(body)",
            f"p = '{self.skills}/wizard-job-files/SKILL.md'\nopen(p, 'w').write('pointer')",
            f"from hermes_tools import write_file\nwrite_file('/tmp/notes.md', 'see {self.skills}/video-app/SKILL.md')",
            f"import subprocess\nsubprocess.run(['cat', '{self.skills}/video-app/SKILL.md'])",
            "def broken(:\n    pass",
        ]
        for code in allowed:
            with self.subTest(code=code):
                self.assertIsNone(self.call('execute_code', code=code))

    def run_tool(self, tool, effect, **args):
        """Drive the hooks the way Hermes does around one call; `effect` is what the tool does on disk."""
        ids = {'task_id': 'synthetic', 'session_id': 's1', 'tool_call_id': f'call-{tool}'}
        verdict = self.ctx.hooks['pre_tool_call'](tool_name=tool, args=args, **ids)
        self.assertIsNone(verdict)
        effect()
        result = json.dumps({'status': 'success', 'output': 'wrote'})
        self.ctx.hooks['post_tool_call'](tool_name=tool, args=args, result=result, **ids)
        return self.ctx.hooks['transform_tool_result'](tool_name=tool, args=args, result=result, **ids)

    def test_writes_the_text_check_cannot_spell_are_undone(self):
        # wizard-os issue 797 tester cases: glob loop, os.walk, subprocess with computed path. Whatever ran, the files come back.
        skill = self.skills / 'video-app/SKILL.md'
        original = skill.read_bytes()
        store = self.os_home / 'store/skills/video-app/SKILL.md'
        store.parent.mkdir(parents=True)
        store.write_text('store copy')
        code = ("from pathlib import Path\nfor p in (Path.home() / '.wizard-os' / 'skills').glob('*/SKILL.md'):\n"
                "    p.write_text('hacked')")

        def edit():
            skill.write_text('hacked')
            store.unlink()
            (self.skills / 'video-app/extra.md').write_text('new')
            (self.skills / 'brand-new-app').mkdir()
            (self.skills / 'brand-new-app/SKILL.md').write_text('new')
        result = self.run_tool('execute_code', edit, code=code)
        self.assertEqual(skill.read_bytes(), original)
        self.assertEqual(store.read_text(), 'store copy')
        self.assertFalse((self.skills / 'video-app/extra.md').exists())
        self.assertFalse((self.skills / 'brand-new-app').exists())
        payload = json.loads(result)
        self.assertEqual(payload['output'], 'wrote')
        self.assertIn('undid', payload['app_skill_guard'])
        self.assertIn("app's source", payload['app_skill_guard'])

        result = self.run_tool('terminal', lambda: skill.write_text('x'), command='python3 /tmp/tool.py')
        self.assertEqual(skill.read_bytes(), original)
        self.assertIn('undid', json.loads(result)['app_skill_guard'])

    def bump_registry(self, version):
        self.registry([{'id': 'video-app', 'skill': 'SKILL.md', 'version': version}])
        st = (self.os_home / 'apps.json').stat()
        os.utime(self.os_home / 'apps.json', ns=(st.st_atime_ns, st.st_mtime_ns + 10**9))

    def touch_registry(self):
        st = (self.os_home / 'apps.json').stat()
        os.utime(self.os_home / 'apps.json', ns=(st.st_atime_ns, st.st_mtime_ns + 10**9))

    def test_app_updates_routing_pointers_and_reads_are_kept(self):
        skill = self.skills / 'video-app/SKILL.md'
        pointer = self.skills / 'wizard-job-files/SKILL.md'

        def wam_update():
            skill.write_text('v2')
            (self.skills / 'wisdom-app/SKILL.md').write_text('v2 too')
            self.touch_registry()
        self.assertIsNone(self.run_tool('terminal', wam_update, command='wam update video-app'))
        self.assertEqual(skill.read_text(), 'v2')

        def app_manager_update():  # e.g. the owner updates the app from the Store while the call runs
            skill.write_text('v3')
            self.bump_registry('3')
        self.assertIsNone(self.run_tool('execute_code', app_manager_update, code='print(1)'))
        self.assertEqual(skill.read_text(), 'v3')
        self.assertIsNone(self.run_tool('write_file', lambda: pointer.write_text('route'), path=str(pointer),
                                        content='route'))
        self.assertEqual(pointer.read_text(), 'route')
        self.assertIsNone(self.run_tool('execute_code', lambda: None, code='print(2)'))
        hook = self.ctx.hooks['pre_tool_call']
        self.assertIsNone(hook(tool_name='read_file', args={'path': str(skill)}, task_id='t'))
        undo = plugin._app_skill_guard._undo
        self.assertEqual(undo._calls, {})
        # Outside any call, App Manager writes the skill and then apps.json: kept, never half-reverted.
        skill.write_text('v4')
        self.assertEqual(undo.tick(), [])
        self.bump_registry('4')
        self.assertEqual(undo.tick(), [])
        self.assertEqual(skill.read_text(), 'v4')

    def test_wam_words_registry_touches_and_background_writes_are_undone(self):
        # wizard-os issue 797 tester round 2: none of these may keep an edit.
        skill = self.skills / 'video-app/SKILL.md'
        original = skill.read_bytes()
        undo = plugin._app_skill_guard._undo
        for tool, args in (('execute_code', {'code': "import subprocess\nsubprocess.run(['wam', 'list'])"}),
                           ('execute_code', {'code': "print('I will not use wam for this')"}),
                           ('terminal', {'command': 'wam list && python3 /tmp/edit.py'}),
                           ('terminal', {'command': 'echo wam; python3 /tmp/edit.py'})):
            with self.subTest(tool=tool, args=args):
                result = self.run_tool(tool, lambda: skill.write_text('emoji edit'), **args)
                self.assertEqual(skill.read_bytes(), original)
                self.assertIn('undid', json.loads(result)['app_skill_guard'])

        def touch_registry_too():
            skill.write_text('emoji edit')
            self.touch_registry()
        result = self.run_tool('execute_code', touch_registry_too, code='x = 1')
        self.assertEqual(skill.read_bytes(), original)
        self.assertIn('undid', json.loads(result)['app_skill_guard'])

        # A process the call left running writes after the call returned.
        self.assertIsNone(self.run_tool('terminal', lambda: None, command='nohup python3 /tmp/late.py &'))
        skill.write_text(skill.read_text() + 'late')
        self.assertEqual(undo.tick(), [])            # first sighting: wait one tick
        self.assertEqual(undo.tick(), [str(skill)])  # still there and unexplained: undone
        self.assertEqual(skill.read_bytes(), original)
        result = self.run_tool('execute_code', lambda: None, code='print(3)')
        self.assertIn('undid', json.loads(result)['app_skill_guard'])  # the agent is told on its next call
        # A late write the watcher has not seen yet is caught at the start of the next call.
        skill.write_text('later')
        self.run_tool('execute_code', lambda: None, code='print(4)')
        self.assertEqual(skill.read_bytes(), original)

    def test_agent_loop_order_transform_before_post_still_tells_agent(self):
        # In Hermes's agent loop transform_tool_result fires inside the call and post_tool_call after it.
        skill = self.skills / 'video-app/SKILL.md'
        original, mode = skill.read_bytes(), skill.stat().st_mode & 0o777
        ids = {'task_id': 't', 'session_id': 's', 'tool_call_id': 'loop-1'}
        args = {'code': 'print(1)'}
        self.assertIsNone(self.ctx.hooks['pre_tool_call'](tool_name='execute_code', args=args, **ids))
        skill.chmod(0o600)
        skill.write_text('edited')
        result = self.ctx.hooks['transform_tool_result'](tool_name='execute_code', args=args,
                                                         result='{"status": "success"}', **ids)
        self.ctx.hooks['post_tool_call'](tool_name='execute_code', args=args, result=result, **ids)
        self.assertIn('undid', json.loads(result)['app_skill_guard'])
        self.assertEqual(skill.read_bytes(), original)
        self.assertEqual(skill.stat().st_mode & 0o777, mode)

    def test_reads_and_verification_with_redirects_allowed(self):
        # Oscar's review: these read-only and update/verify commands must pass.
        allowed = [f'cat {self.skills}/video-app/SKILL.md 2>/dev/null',
                   f'grep -n foo {self.skills}/video-app/SKILL.md | head -5 >&2',
                   f'ls {self.skills} && wam install x/y',
                   f'sha256sum {self.skills}/video-app/SKILL.md > /tmp/a',
                   f'cmp {self.skills}/video-app/SKILL.md release/SKILL.md 2>&1',
                   f'cp {self.skills}/video-app/SKILL.md /tmp/copy.md',
                   f'wam update video-app && diff {self.skills}/video-app/SKILL.md src/SKILL.md > /tmp/d']
        for command in allowed:
            with self.subTest(command=command):
                self.assertIsNone(self.call('terminal', command=command))
        self.assertIsNone(self.call('execute_code', code=f'def f() -> str:\n    return open("{self.skills}/video-app/SKILL.md").read()'))

    def test_write_targets_still_blocked(self):
        for command in [f'echo x 2> {self.skills}/video-app/SKILL.md',
                        f'printf x >| {self.skills}/video-app/SKILL.md',
                        f'echo x | tee -a {self.skills}/video-app/SKILL.md',
                        f'mv {self.skills}/video-app/SKILL.md /tmp/x',
                        f'rm -rf {self.skills}/video-app',
                        f'rsync -a src/ {self.skills}/video-app/',
                        f'install -m644 a.md {self.skills}/video-app/SKILL.md',
                        f'cd {self.skills}/video-app && sed -i s/a/b/ SKILL.md',
                        f'cd {self.skills} && printf x > video-app/SKILL.md',
                        f"python3 -c \"open('{self.skills}/video-app/SKILL.md','w').write('x')\""]:
            with self.subTest(command=command):
                self.blocked('terminal', command=command)

    def test_destination_flags_quoted_text_and_relative_routing_writes(self):
        # Codex review on the carried fix: per-command destination flags, quoting, routing exemption after cd.
        for command in [f'cp --target-directory={self.skills}/video-app src.md',
                        f'cp --target-directory {self.skills}/video-app src.md',
                        f'cp -t {self.skills}/video-app src.md',
                        f'install -t{self.skills}/video-app a.md',
                        f'rsync -t src.md {self.skills}/video-app/']:
            with self.subTest(command=command):
                self.blocked('terminal', command=command)
        for command in [f"printf '%s' '>{self.skills}/video-app/SKILL.md'",
                        f'echo "> {self.skills}/video-app/SKILL.md" >/tmp/notes',
                        f'cd {self.skills} && printf x > wizard-job-files/SKILL.md',
                        f'rsync -t {self.skills}/video-app/SKILL.md /tmp/copy.md']:
            with self.subTest(command=command):
                self.assertIsNone(self.call('terminal', command=command))

    def test_home_resolution_is_dynamic_and_matches_kernel(self):
        custom = Path(self.tmp.name) / 'custom-wizard'
        custom.mkdir()
        with patch.dict(os.environ, {'WIZARD_OS_HOME': str(custom)}):
            self.assertEqual(plugin._kernel.os_home(), custom)
            (custom / 'apps.json').write_text(json.dumps({'apps': [{'id': 'new-app', 'skill': 'SKILL.md'}]}))
            self.blocked('skill_manage', **self.manage('new-app'))
            self.blocked('write_file', path=str(custom / 'skills/new-app/SKILL.md'))
            self.blocked('terminal', command=f'printf x > {custom}/skills/new-app/SKILL.md')
            self.blocked('terminal', command='printf x > "$WIZARD_OS_HOME/skills/new-app/SKILL.md"')
            self.blocked('execute_code', code=f"open('{custom}/skills/new-app/SKILL.md', 'w').write('x')")
        with patch.dict(os.environ, {'WIZARD_OS_HOME': ''}):
            self.blocked('write_file', path='~/.wizard-os/skills/video-app/SKILL.md')

    def test_container_mount_names_and_paths_without_registry(self):
        # No real /opt mount or owner registry is read; emulate the App Manager bind mount.
        mount = Path(self.tmp.name) / 'mounted-skills'
        self.skill('mounted-app', 'mounted-editing', root=mount)
        (self.os_home / 'apps.json').unlink()
        with patch.object(plugin._app_skill_guard, 'SKILLS_TARGET', mount):
            self.blocked('skill_manage', **self.manage('mounted-editing'))
            self.blocked('patch', path=str(mount / 'mounted-app/SKILL.md'))
            self.blocked('terminal', command=f'printf x > {mount}/mounted-app/SKILL.md')
        self.blocked('write_file', path='/opt/wizard-os/skills/video-app/SKILL.md')
        self.blocked('terminal', command='printf x > /opt/wizard-os/skills/video-app/SKILL.md')
        self.assertIsNone(self.call('write_file', path='/opt/wizard-os/skills/wizard-job-files/SKILL.md'))

    def test_missing_and_malformed_registry_does_not_disable_directory_guard(self):
        for text in ('{broken', '[]', '{"apps": null}', '{"apps": [null, 1, {}, {"id": [], "skill": true}]}'):
            (self.os_home / 'apps.json').write_text(text)
            self.blocked('skill_manage', **self.manage('video-editing'))
        (self.os_home / 'apps.json').unlink()
        self.blocked('skill_manage', **self.manage('video-editing'))

    def test_symlink_and_dotdot_paths_are_protected(self):
        alias = self.home / 'skill-alias'
        alias.symlink_to(self.skills, target_is_directory=True)
        self.blocked('patch', path=str(alias / 'video-app/SKILL.md'))
        self.blocked('write_file', path=str(self.skills / 'wizard-job-files/../video-app/SKILL.md'))

    def test_malformed_arguments_and_shadow_config_are_safe(self):
        hook = self.ctx.hooks['pre_tool_call']
        for args in (None, [], 'invalid'):
            self.assertIsNone(hook(tool_name='skill_manage', args=args))
        self.ctx.shadows = [None, {}, {'name': [], 'app_id': 'video-app'}]
        self.assertIsNone(self.call('skill_manage', operations=[None, 'invalid']))
        self.assertIsNone(self.call('skill_view', name='video-editing'))


if __name__ == '__main__':
    unittest.main()
