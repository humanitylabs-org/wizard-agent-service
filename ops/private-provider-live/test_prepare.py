#!/usr/bin/env python3
"""Synthetic orchestration tests; no Docker, SSH or credentials."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rig_prepare',Path(__file__).with_name('rig-prepare.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.live = self.root/'pp-launch/live'
        (self.live/'sources').mkdir(parents=True)
        (self.live/'guest-saved').mkdir()
        (self.live/'guest-saved/INVENTORY.json').write_text(json.dumps({'marker':'pp-private-providers','uid':1000}))
        self.manifest = {}
        for name in m.ARCHIVES:
            blob = ('synthetic '+name).encode()
            (self.live/'sources'/name).write_bytes(blob)
            self.manifest[name] = {'sha256':hashlib.sha256(blob).hexdigest()}
        (self.live/'SOURCE-MANIFEST.json').write_text(json.dumps(self.manifest))
        (self.live/'live-ownership.json').write_text(json.dumps({'uid':1000,'rows':[{'path':'app-data','uid':0,'gid':0,'mode':493,'writable':False}]}))
        p = patch.object(m,'DEFAULT_ROOT',self.root)
        p.start(); self.addCleanup(p.stop)

    def test_validate_is_read_only(self):
        before = {str(p):p.read_bytes() for p in self.live.rglob('*') if p.is_file()}
        m.validate(self.root)
        self.assertEqual(before,{str(p):p.read_bytes() for p in self.live.rglob('*') if p.is_file()})

    def test_refuses_source_drift_before_vm_access(self):
        (self.live/'sources/service.tar').write_bytes(b'changed')
        with patch.object(m,'Rig') as rig:
            with self.assertRaisesRegex(ValueError,'source archive drift'):
                m.prepare(self.root)
            rig.assert_not_called()

    def test_requires_saved_guest_before_reset(self):
        (self.live/'guest-saved/INVENTORY.json').unlink()
        with self.assertRaises(FileNotFoundError):m.validate(self.root)

    def test_refuses_parity_escape(self):
        (self.live/'live-ownership.json').write_text(json.dumps({'uid':1000,'rows':[{'path':'../escape'}]}))
        with self.assertRaisesRegex(ValueError,'unsafe parity path'):m.validate(self.root)

    def state(self,**kw):
        return dict(wam_image_id=m.WAM.split('@')[1],wam_main_sha256=m.WAM_MAIN,
                    provider_key_present=False,provider_volumes=[],apps=[],**kw)

    def fake(self,state):
        class Fake:
            calls=[]
            def __init__(self,root):pass
            def python(self,script,**kw):
                self.calls.append((script,kw))
                return json.dumps(state) if script == m.OWNER_VERIFY else ''
            def put(self,*args):self.calls.append(('put',args))
            def run(self,*args,**kw):self.calls.append((args,kw));return ''
        return Fake

    def test_success_is_prepared_never_acceptance(self):
        fake = self.fake(self.state())
        with patch.object(m,'Rig',fake):self.assertEqual(m.prepare(self.root),0)
        out=json.loads((self.live/'RIG-PREPARATION.json').read_text())
        self.assertEqual(out['status'],'prepared')
        self.assertTrue(out['blockers'])
        self.assertEqual(sum(1 for s,k in fake.calls if s==m.ROOT_SETUP and k.get('root')),1)
        self.assertIn('six privacy checks',out['blockers'][0])

    def test_failure_keeps_blocked_receipt(self):
        state=self.state();state['wam_main_sha256']='wrong'
        with patch.object(m,'Rig',self.fake(state)):
            with self.assertRaises(AssertionError):m.prepare(self.root)
        out=json.loads((self.live/'RIG-PREPARATION.json').read_text())
        self.assertEqual(out['status'],'blocked')
        self.assertIn('failure',out)

    def test_secret_or_volume_prevents_prepared(self):
        for field,value in [('provider_key_present',True),('provider_volumes',['synthetic']),('apps',[{}])]:
            state=self.state();state[field]=value
            with self.subTest(field=field),patch.object(m,'Rig',self.fake(state)):
                with self.assertRaises(AssertionError):m.prepare(self.root)
            self.assertEqual(json.loads((self.live/'RIG-PREPARATION.json').read_text())['status'],'blocked')


if __name__=='__main__':unittest.main()
