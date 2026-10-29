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
