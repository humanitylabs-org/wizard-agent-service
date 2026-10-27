"""Consumer status reads only metadata under the exact granted app login directory."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
spec=importlib.util.spec_from_file_location('app_owned',Path(__file__).with_name('app_owned_login.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class ConsumerReadbackTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.env={'CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR':str(self.root)}
        self.profile=SimpleNamespace(app_owned_login_contract=module.CONTRACT)
        self.cfg={'model':{'provider':module.PROVIDER}}
    def tearDown(self):self.tmp.cleanup()
    def status(self):return module.claude_status(self.env,self.profile,self.cfg)
    def seed(self):
        (self.root/'owner.json').write_text(json.dumps({'id':'a'*32}))
        (self.root/'accounts.json').write_text(json.dumps([{'id':'acct-one'},{'id':'acct-two'}]))
        for ident in ('acct-one','acct-two'):
            p=self.root/'accounts'/ident;p.mkdir(parents=True)
            (p/'.credentials.json').write_text('Not even parsed: provider secrets stay private')
    def test_two_account_granted_identity_readback_without_reading_provider_credentials(self):
        self.seed();result=self.status()
        self.assertEqual((result['status'],result['ownerId'],result['accountIds']),('mounted','a'*32,['acct-one','acct-two']))
        self.assertTrue(result['in_use']);self.assertNotIn('credentials',json.dumps(result))
    def test_missing_share_wrong_plugin_and_unrelated_token_are_not_connected(self):
        self.assertEqual(self.status()['status'],'unavailable')
        self.seed();self.profile.app_owned_login_contract='old-single-login'
        self.assertEqual(self.status()['status'],'unavailable')
        self.profile.app_owned_login_contract=module.CONTRACT;self.env['CLAUDE_CODE_OAUTH_TOKEN']='unrelated-synthetic'
        self.assertEqual(self.status()['status'],'unavailable')
    def test_revocation_logout_and_malformed_inventory_cannot_claim_agent_connected(self):
        self.seed()
        for p in self.root.glob('accounts/*/.credentials.json'):p.unlink()
        self.assertEqual(self.status()['status'],'not_connected')
        (self.root/'accounts.json').write_text('[{"id":"../outside"}]')
        self.assertEqual(self.status()['status'],'unavailable')
    def test_ready_connection_does_not_imply_default_model_selection(self):
        self.seed();self.cfg['model']['provider']='other'
        result=self.status();self.assertEqual(result['status'],'mounted');self.assertFalse(result['in_use'])


if __name__=='__main__':unittest.main(verbosity=2)
