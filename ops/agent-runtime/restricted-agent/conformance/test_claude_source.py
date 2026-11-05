"""App-owned Claude source resolver: metadata only, no Docker or login reads."""
import copy
import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('claude_source', Path(__file__).resolve().parents[1] / 'claude_source.py')
assert spec and spec.loader
source = importlib.util.module_from_spec(spec); spec.loader.exec_module(source)


def engine(kind='volume'):
    mount = {'Destination': '/claude', 'Type': kind, 'RW': True}
    if kind == 'volume': mount['Name'] = source.LEGACY_VOLUME
    else: mount['Source'] = '/srv/app-data/core/wizard-claude/data/claude'
    return {'Config': {'Labels': {'com.docker.compose.service': source.ENGINE_SERVICE}},
            'State': {'Running': True}, 'Mounts': [mount]}


class SourceTest(unittest.TestCase):
    def test_legacy_volume_and_compiled_share_one_resolver(self):
        for kind in ('volume', 'bind'):
            c = engine(kind); before = copy.deepcopy(c)
            resolved = source.resolve([c]); self.assertEqual(resolved['type'], kind)
            doc = source.compose_override(resolved)
            mount = doc['services']['claude-init']['volumes'][0]
            self.assertEqual(mount['target'], '/claude-app'); self.assertTrue(mount['read_only'])
            self.assertEqual(c, before)
            if kind == 'bind': self.assertFalse(mount['bind']['create_host_path'])
            else:
                self.assertTrue(doc['volumes']['claude-app-login']['external'])
                self.assertTrue(mount['volume']['nocopy'])

    def test_missing_stopped_ambiguous_or_wrong_app_denied(self):
        self.assertIsNone(source.resolve([])); self.assertIsNone(source.resolve([engine(), engine()]))
        for change in ('stopped','label','dest','source','extra'):
            c = engine()
            if change == 'stopped': c['State']['Running'] = False
            if change == 'label': c['Config']['Labels']['com.docker.compose.service'] = 'other-app'
            if change == 'dest': c['Mounts'][0]['Destination'] = '/elsewhere'
            if change == 'source': c['Mounts'][0]['Name'] = 'foreign-login'
            if change == 'extra': c['Mounts'] *= 2
            self.assertIsNone(source.resolve([c]))

    def test_unsafe_bind_source_refused(self):
        for path in ('/', '/claude', '/srv/../claude', 'relative/claude', '/srv/data/claude/.credentials.json',
                     '/.claude', '/home/.claude', '/home/u/.claude/../x', '/home/u/claude.d', '/home/u/.claude2'):
            c = engine('bind'); c['Mounts'][0]['Source'] = path
            self.assertIsNone(source.resolve([c]))

    def test_host_user_claude_dir_bind_accepted(self):
        # The Claude app on a host install binds the owner's own Claude Code login dir (/home/<user>/.claude).
        c = engine('bind'); c['Mounts'][0]['Source'] = '/home/oscar/.claude'
        resolved = source.resolve([c])
        self.assertEqual(resolved, {'type': 'bind', 'source': '/home/oscar/.claude'})
        mount = source.compose_override(resolved)['services']['claude-init']['volumes'][0]
        self.assertTrue(mount['read_only']); self.assertFalse(mount['bind']['create_host_path'])


if __name__ == '__main__': unittest.main()
