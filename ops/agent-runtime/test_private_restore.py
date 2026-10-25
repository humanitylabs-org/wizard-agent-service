"""Synthetic post-seal restore, no real containers or owner homes."""
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
import agent_runtime as ar

class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.home = self.root/'agents/probe/home'; self.home.mkdir(parents=True)
        (self.home/'.env').write_text('OTHER=retained\n')
        self.host = self.root/'host.env'; self.host.write_text('TINFOIL_API_KEY=synthetic-host-only-12345\n')
        self.agents = ar.Agents(self.root/'agents', tinfoil_key_file=self.host)
        self.attempt = 'a'*32
        self.source = {'attempt':self.attempt,'provider':'tinfoil','model':{'provider':'tinfoil'},'runtime':{'kind':'container','port':18650}}
        self.agent = {'id':'probe','model':{'provider':'wizard-tinfoil'},'runtime':{'kind':'container','port':18650,'private_client':True,'migration_source':self.source}}
        self.calls=[]
        self.legacy=SimpleNamespace(agents=self.agents,apply=lambda a:self.calls.append('legacy-apply'))
        self.sealed=SimpleNamespace(delete=self.delete)
        self.runtime=self.home.parent/'runtime'; self.runtime.mkdir()
        (self.runtime/'private-compose.json').write_text('{}')
        (self.runtime/'key-scrub.json').write_text('{}')
    def delete(self,a):
        self.assertTrue((self.runtime/'private-restore.json').exists());self.calls.append('sealed-delete')
        (self.runtime/'private-compose.json').unlink()
    def call(self,phase,attempt=None):
        return ar.unmigrate_private_provider(self.agents,self.agent,{'attempt':attempt or self.attempt,'phase':phase},self.legacy,self.sealed)
    def restore_record(self):
        self.agent['model']=self.source['model'];self.agent['runtime']={**self.source['runtime'],'private_restore_attempt':self.attempt,'private_restore_source':self.source}
    def test_stop_then_publish_then_host_restore_with_retry(self):
        self.call('prepare');self.call('prepare')
        self.assertEqual(self.calls,['sealed-delete'])
        with self.assertRaisesRegex(ar.RuntimeFailure,'private_restore_pending'):ar.lifecycle_action(self.legacy,self.agent,'start')
        self.restore_record();self.call('commit');self.call('commit')
        self.assertEqual(self.calls,['sealed-delete','legacy-apply'])
        self.assertIn('synthetic-host-only',(self.home/'.env').read_text())
        self.assertFalse((self.runtime/'key-scrub.json').exists());self.assertFalse((self.runtime/'private-restore.json').exists())
    def test_wrong_attempt_and_missing_host_source_leave_sealed_untouched(self):
        with self.assertRaisesRegex(ar.RuntimeFailure,'scope_mismatch'):self.call('prepare','b'*32)
        self.host.unlink()
        with self.assertRaisesRegex(ar.RuntimeFailure,'host_source_unavailable'):self.call('prepare')
        self.assertEqual(self.calls,[]);self.assertFalse((self.runtime/'private-restore.json').exists())
    def test_commit_before_publication_refused(self):
        self.call('prepare')
        with self.assertRaisesRegex(ar.RuntimeFailure,'scope_mismatch'):self.call('commit')
        self.assertNotIn('synthetic-host-only',(self.home/'.env').read_text())
    def test_failed_legacy_apply_retains_fence_for_retry(self):
        self.call('prepare');self.restore_record()
        with patch.object(self.legacy,'apply',side_effect=RuntimeError('fixture')):
            with self.assertRaises(RuntimeError):self.call('commit')
        self.assertTrue((self.runtime/'private-restore.json').exists());self.call('commit')
        self.assertFalse((self.runtime/'private-restore.json').exists())
    def test_status_rpc_exposes_only_counts_and_stdin_source(self):
        from email.message import Message
        import io
        self.agent['schema']=1
        (self.home.parent/'agent.json').write_text(json.dumps(self.agent))
        (self.runtime/'key-scrub.json').write_text(json.dumps({'status':'completed','count':3,'paths':['synthetic']}))
        handler=object.__new__(ar.make_handler('fixture-auth',self.agents,self.legacy,restricted_driver=self.sealed))
        handler.headers=Message();handler.headers['Authorization']='Bearer fixture-auth'
        handler.rfile=io.BytesIO();handler.path='/agents/probe/private-migration-status'
        replies=[];handler._json=lambda c,b:replies.append((c,b))
        def mocked(args,**kwargs):
            self.assertEqual(args[:2],['exec','-i'])
            self.assertNotIn('synthetic-host-only-12345',' '.join(args))
            self.assertEqual(kwargs['input_text'],'synthetic-host-only-12345')
            return SimpleNamespace(stdout=json.dumps({'files_scanned':9,'credential_matches':0}))
        with patch.object(ar,'container_for',return_value='synthetic-main'),patch.object(ar,'docker',side_effect=mocked):handler.do_POST()
        self.assertEqual(replies,[(200,{'sealed':True,'retirement_status':'completed','retired_files':3,'files_scanned':9,'credential_matches':0})])
if __name__=='__main__':unittest.main()
