"""Fast synthetic host-policy tests only. Real UID/mount/dispatcher proof is a worker gate."""
import copy
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest
from unittest.mock import patch
import app_socket_grants as app
import agent_runtime as ar


class AppSocketGrants(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp()).resolve()
        self.root.chmod(0o700)
        self.path = self.root / 'grants.json'
        self.grant = {'app': 'shared-vault', 'socket': str(self.root / 'agent-a.sock'), 'broker_uid': 10002, 'edge_uid': 10003, 'agent_uid': 10000}
        self.agent = {'id': 'agent-a', 'runtime': {'isolation': 'restricted'}}
        self.doc = {'schema': 1, 'agents': {'agent-a': self.grant}}
        self.save()

    def tearDown(self):
        shutil.rmtree(self.root)

    def save(self):
        self.path.write_text(json.dumps(self.doc)); self.path.chmod(0o600)

    def test_default_and_unknown_agent_get_no_mount(self):
        self.assertIsNone(app.grant_for(None, self.agent))
        self.assertIsNone(app.grant_for(self.path, {'id': 'agent-b'}))

    def test_explicit_packaged_socket_only_compose(self):
        g = app.grant_for(self.path, self.agent, ready=False)
        doc = app.compose_override(g, home=self.root / 'home', image=ar.DEFAULT_IMAGE)['services']['agent']
        self.assertEqual(doc['user'], '10000:10000')
        self.assertEqual(doc['userns_mode'], 'host')
        self.assertEqual(doc['environment'], {'SHARED_VAULT_SOCKET': '/run/shared-vault/agent.sock'})
        mounts = doc['volumes']; self.assertEqual(len(mounts), 3)
        self.assertEqual(mounts[0]['source'], self.grant['socket'])
        self.assertTrue(all(m['read_only'] and not m['bind']['create_host_path'] for m in mounts))
        self.assertNotIn('token', json.dumps(doc))

    def test_all_uid_pairs_are_distinct_and_positive(self):
        for field, value in [('broker_uid', 10000), ('edge_uid', 10000), ('broker_uid', 10003), ('edge_uid', 0), ('agent_uid', True), ('agent_uid', 10001)]:
            with self.subTest(field=field, value=value):
                old = self.grant[field]; self.grant[field] = value; self.save()
                with self.assertRaises(ValueError): app.grant_for(self.path, self.agent, ready=False)
                self.grant[field] = old

    def test_regular_file_or_missing_socket_refused(self):
        with self.assertRaises(OSError): app.grant_for(self.path, self.agent)
        Path(self.grant['socket']).write_text('not a socket')
        with self.assertRaises(ValueError): app.grant_for(self.path, self.agent)

    def test_wrong_runtime_and_imports_refused(self):
        for a in [dict(self.agent, runtime={}), dict(self.agent, imported=True)]:
            with self.assertRaises(ValueError): app.grant_for(self.path, a, ready=False)

    def test_untrusted_metadata_and_shared_socket_refused(self):
        self.grant['owner_token'] = 'never accepted'; self.save()
        with self.assertRaises(ValueError): app.grant_for(self.path, self.agent, ready=False)
        del self.grant['owner_token']
        self.doc['agents']['agent-b'] = dict(self.grant); self.save()
        with self.assertRaises(ValueError): app.grant_for(self.path, self.agent, ready=False)

    def test_private_file_and_symlink_gate(self):
        self.path.chmod(0o644)
        with self.assertRaises(ValueError): app.grant_for(self.path, self.agent, ready=False)
        self.path.chmod(0o600)
        link = self.root / 'link.json'; link.symlink_to(self.path)
        with self.assertRaises(ValueError): app.grant_for(link, self.agent, ready=False)

    def test_source_plugin_tamper_refused(self):
        source = self.root / 'plugin.py'; source.write_text('# replacement')
        with patch.object(app, 'PLUGIN', source):
            with self.assertRaises(ValueError): app.grant_for(self.path, self.agent, ready=False)

    def record(self):
        return {'Config': {'User': '10000:10000'}, 'HostConfig': {'ReadonlyRootfs': True, 'Privileged': False, 'CapDrop': ['ALL'],
                'CapAdd': [], 'IpcMode': 'private', 'UsernsMode': 'host', 'SecurityOpt': ['no-new-privileges:true']},
                'Mounts': [
                    {'Destination': '/opt/data', 'Source': str(self.root / 'home'), 'Type': 'bind', 'RW': True},
                    {'Destination': '/opt/wizard-skills', 'Type': 'volume', 'RW': False},
                    {'Destination': app.TARGET, 'Source': self.grant['socket'], 'Type': 'bind', 'RW': False},
                    {'Destination': '/opt/data/plugins/shared-vault/__init__.py', 'Source': str(app.PLUGIN), 'Type': 'bind', 'RW': False},
                    {'Destination': '/opt/data/plugins/shared-vault/plugin.yaml', 'Source': str(app.PLUGIN.with_name('plugin.yaml')), 'Type': 'bind', 'RW': False}]}

    def test_inspect_requires_exact_socket_only_mounts_and_nonroot_namespaces(self):
        app.verify_applied(self.record(), self.grant, self.root / 'home')
        mutations = [lambda r: r['Config'].update(User='0:0'), lambda r: r['HostConfig'].update(Privileged=True),
            lambda r: r['HostConfig'].update(PidMode='host'), lambda r: r['HostConfig'].update(UsernsMode=''),
            lambda r: r['HostConfig'].update(Devices=[{}]), lambda r: r['HostConfig'].update(PortBindings={'22': [{}]}),
            lambda r: r['Mounts'].append({'Destination': '/var/run/docker.sock', 'Type': 'bind', 'RW': False}),
            lambda r: r['Mounts'][2].update(Source=str(self.root / 'agent-b.sock')),
            lambda r: r['Mounts'][2].update(RW=True), lambda r: r['Mounts'][3].update(Source='/host/source')]
        for change in mutations:
            r = self.record(); change(r)
            with self.assertRaises(ValueError): app.verify_applied(r, self.grant, self.root / 'home')

    def test_kernel_identity_namespace_uid_capability_and_nnp_gate(self):
        good = {'uid_map': ['0','0','4294967295'], 'userns': 42, 'uids': ['10000']*4, 'nnp': '1',
                'caps': dict.fromkeys(('CapInh','CapPrm','CapEff','CapBnd','CapAmb'), '0000000000000000')}
        with patch.object(Path, 'read_text', return_value='0 0 4294967295'), patch.object(app.os, 'stat', return_value=type('S', (), {'st_ino':42})()):
            app.verify_identity(good)
            for change in ({'uids':['0']*4}, {'uids':['10000','10000','0','10000']}, {'nnp':'0'}, {'userns':43}, {'uid_map':['0','100000','65536']}, {'caps':dict(good['caps'], CapEff='0000000000000001')}):
                with self.assertRaises(ValueError): app.verify_identity(dict(good, **change))
        with self.assertRaises(ValueError): app.verify_identity([])

    def test_restart_reuses_apply_and_stops_inspect_failure(self):
        agents = ar.Agents(self.root / 'agents', None)
        driver = ar.RestrictedDriver(agents, ar.RESTRICTED_DIR, '', self.path)
        result = {'ok': True, 'status_detail': 'running', 'last_error': ''}
        with patch.object(driver, 'apply', return_value=result) as apply:
            self.assertEqual(driver.start(self.agent), result); apply.assert_called_once_with(self.agent)
        calls = []
        def docker(args, **kwargs):
            calls.append(args)
            return type('R', (), {'stdout': '[{}]'})()
        with patch.object(ar, 'container_for', return_value='fixture-container'), patch.object(ar, 'docker', docker):
            with self.assertRaises(ar.RuntimeFailure): driver.verify_app_socket_runtime(self.agent, self.grant)
        self.assertIn(['stop', '-t', '1', 'fixture-container'], calls)


if __name__ == '__main__': unittest.main()
