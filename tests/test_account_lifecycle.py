"""Fake CLI only: this file never invokes Hermes or touches real credentials."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('lifecycle', ROOT/'hermes-plugin/wizard-os/dashboard/account_lifecycle.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
FAKE = '''import json,sys,time
from pathlib import Path
path=Path(sys.argv[1]); args=sys.argv[2:]
rows=json.loads(path.read_text())
assert args[:1]==['auth']
if args[1]=='remove':
    assert args[3]=='aa11bb'
    rows=[r for r in rows if r['id']!=args[3]]
elif args[1]=='priority':
    assert args[2]=='anthropic' and args[4]=='0' and len(args)==5
    moved=[r for r in rows if r['id']==args[3]]
    rows=moved+[r for r in rows if r['id']!=args[3]]
    for i,r in enumerate(rows): r['priority']=i
else:
    assert args[1]=='add' and '--type' in args and '--no-browser' in args
    assert '--label' not in args
    label=[a for a in args if a.startswith('--label=')][0][len('--label='):]
    if args[2]=='anthropic':
        print('https://claude.ai/oauth/authorize?response_type=code&code_challenge_method=S256&state=fixture',flush=True)
        print('Authorization code: ',end='',flush=True)
        code=input()
        assert code=='fixture#state'
    else:
        print('https://auth.openai.com/codex/device\\nEnter this code:\\nABCD-EFGH',flush=True)
    print('sk-SECRET_MUST_NOT_ESCAPE access_token refresh_token',flush=True)
    if label=='wait': time.sleep(20)
    if label=='fail': sys.exit(1)
    rows.append({'id':'cc33dd','auth_type':'oauth','source':'manual:device_code','label':label})
path.write_text(json.dumps(rows))
'''

class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.path=Path(self.tmp.name)/'pool.json'
        self.original=[{'id':'aa11bb','auth_type':'oauth','source':'manual:device_code','label':'Old'},
                       {'id':'ee55ff','auth_type':'oauth','source':'manual:device_code','label':'Other'}]
        self.path.write_text(json.dumps(self.original))
        self.cli=Path(self.tmp.name)/'fake.py'; self.cli.write_text(FAKE)
        self.b=m.Broker(read=lambda _: json.loads(self.path.read_text()), command=[sys.executable,str(self.cli),str(self.path)],ttl=2,lock_path=Path(self.tmp.name)/'broker.lock')
    def tearDown(self):
        self.b.close()
        for j in self.b.jobs.values():
            deadline=time.time()+3
            while j['status'] not in m.TERMINAL and time.time()<deadline: time.sleep(.01)
        self.tmp.cleanup()
    def wait(self,j,display=False):
        deadline=time.time()+4
        while time.time()<deadline:
            out=self.b.poll(j['provider'],j['id'])
            if out['status'] in m.TERMINAL or (display and (out['userCode'] or out['inputRequired'])): return out
            time.sleep(.01)
        self.fail('job did not settle')
    def test_add_real_subprocess_and_readback(self):
        out=self.wait(self.b.start('chatgpt','add',label='New',confirmed=True))
        self.assertEqual(out['status'],'succeeded'); self.assertEqual(out['credentialIds'],['cc33dd'])
        self.assertEqual(len(json.loads(self.path.read_text())),3)
        self.assertNotIn('SECRET',json.dumps(out))
    def test_reconnect_retains_exact_old_and_other_grants(self):
        out=self.wait(self.b.start('chatgpt','reconnect','aa11bb',confirmed=True))
        self.assertEqual(out['status'],'succeeded')
        self.assertEqual(json.loads(self.path.read_text())[:2],self.original)
    def test_remove_exact_id_not_position(self):
        out=self.wait(self.b.start('chatgpt','remove','aa11bb',confirmed=True))
        self.assertEqual(out['status'],'succeeded'); self.assertEqual(json.loads(self.path.read_text()),self.original[1:])
    def test_prefer_moves_any_exact_sign_in_first_without_loss(self):
        rows=self.original+[{'id':'cc55dd','auth_type':'oauth','source':'claude_code','label':'claude_code'}]
        for i,r in enumerate(rows): r['priority']=i
        self.path.write_text(json.dumps(rows))
        # Stock Hermes pins added anthropic grants ahead of the seeded Claude Code login: refuse, change nothing.
        with self.assertRaises(m.BrokerError): self.b.start('claude','prefer','cc55dd',confirmed=True)
        self.assertEqual(json.loads(self.path.read_text()),rows)
        out=self.wait(self.b.start('claude','prefer','ee55ff',confirmed=True))
        self.assertEqual(out['status'],'succeeded')
        after=json.loads(self.path.read_text())
        self.assertEqual([r['id'] for r in after],['ee55ff','aa11bb','cc55dd'])
        self.assertEqual(after[0]['priority'],0)
        for target in ('1','missing','claude_code',None):
            with self.assertRaises(m.BrokerError): self.b.start('claude','prefer',target,confirmed=True)
        with self.assertRaises(m.BrokerError): self.b.start('claude','prefer','aa11bb')
    def test_confirmation_and_target_validation(self):
        for target in ('1','missing','aa11bb;touch',None):
            with self.assertRaises(m.BrokerError): self.b.start('chatgpt','remove',target,confirmed=True)
        with self.assertRaises(m.BrokerError): self.b.start('chatgpt','remove','aa11bb')
        self.assertEqual(self.b.jobs,{})
    def test_external_source_refused(self):
        self.original[0]['source']='claude_code'; self.path.write_text(json.dumps(self.original))
        with self.assertRaises(m.BrokerError): self.b.start('claude','remove','aa11bb',confirmed=True)
    def test_device_handoff_and_cancel(self):
        j=self.b.start('chatgpt','add',label='wait',confirmed=True)
        out=self.wait(j,True); self.assertEqual(out['userCode'],'ABCD-EFGH')
        self.b.cancel('chatgpt',j['id']); out=self.wait(j)
        self.assertEqual(out['status'],'cancelled'); self.assertIsNone(out['userCode'])
        self.assertEqual(json.loads(self.path.read_text()),self.original)
    def test_timeout(self):
        self.b.ttl=.15
        out=self.wait(self.b.start('chatgpt','add',label='wait',confirmed=True))
        self.assertEqual(out['status'],'expired')
    def test_single_flight_and_provider_binding(self):
        j=self.b.start('chatgpt','add',label='wait',confirmed=True)
        with self.assertRaises(m.BrokerError): self.b.start('claude','add',confirmed=True)
        with self.assertRaises(m.BrokerError): self.b.cancel('claude',j['id'])
        self.b.cancel('chatgpt',j['id'])
    def test_claude_supported_pkce_stdin_handoff(self):
        j=self.b.start('claude','add',confirmed=True); out=self.wait(j,True)
        self.assertTrue(out['inputRequired']); self.assertIn('https://claude.ai/oauth/authorize?',out['url'])
        self.b.submit('claude',j['id'],'fixture#state')
        out=self.wait(j); self.assertEqual(out['status'],'succeeded'); self.assertNotIn('fixture#state',json.dumps(out))
    def test_output_errors_never_returned(self):
        out=self.wait(self.b.start('chatgpt','add',label='fail',confirmed=True))
        self.assertEqual(out['status'],'failed'); self.assertNotIn('SECRET',json.dumps(out))
    def test_url_allowlist(self):
        j=dict(provider='claude',url=None,inputRequired=False,submitted=False)
        self.b._display(j,'https://claude.ai.evil/oauth/authorize?response_type=code Authorization code:')
        self.assertIsNone(j['url']); self.assertFalse(j['inputRequired'])
    def test_second_broker_cannot_mutate_while_lease_held(self):
        j=self.b.start('chatgpt','add',label='wait',confirmed=True)
        other=m.Broker(read=self.b.read,command=self.b.command,lock_path=self.b.lock_path)
        with self.assertRaises(m.BrokerError): other.start('chatgpt','add',confirmed=True)
        self.b.cancel('chatgpt',j['id']); self.wait(j)
        self.assertEqual(other.jobs,{})
    def test_label_starting_with_dash_rejected(self):
        for bad in ('-x','--help',' -v'):
            with self.assertRaises(m.BrokerError): self.b.start('chatgpt','add',label=bad,confirmed=True)
        self.assertEqual(self.b.jobs,{})
    def test_reconnect_passes_inventory_label_as_single_argv_token(self):
        self.original[0]['label']='-dash';self.path.write_text(json.dumps(self.original))
        out=self.wait(self.b.start('chatgpt','reconnect','aa11bb',confirmed=True))
        self.assertEqual(out['status'],'succeeded')
        self.assertEqual(json.loads(self.path.read_text())[-1]['label'],'-dash')
    def test_colliding_id_label_is_not_a_fallback_target(self):
        self.original[1]['label']='aa11bb';self.path.write_text(json.dumps(self.original))
        with self.assertRaises(m.BrokerError): self.b.start('chatgpt','remove','aa11bb',confirmed=True)
        self.assertEqual(self.b.jobs,{})
    def test_code_replay_and_invalid_input_rejected(self):
        j=self.b.start('claude','add',confirmed=True);self.wait(j,True)
        with self.assertRaises(m.BrokerError):self.b.submit('claude',j['id'],'bad\ncode')
        self.b.submit('claude',j['id'],'fixture#state')
        with self.assertRaises(m.BrokerError):self.b.submit('claude',j['id'],'fixture#state')
        self.assertEqual(self.wait(j)['status'],'succeeded')
    def test_routes_reject_csrf_and_hide_secret_errors(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        s=importlib.util.spec_from_file_location('api',ROOT/'hermes-plugin/wizard-os/dashboard/plugin_api.py')
        api=importlib.util.module_from_spec(s); s.loader.exec_module(api)
        api._lifecycle.broker=self.b
        app=FastAPI(); app.include_router(api.router)
        c=TestClient(app)
        path='/provider-accounts/chatgpt/operations'
        headers={'X-Wizard-Account-Action':'1'}
        # Shipped default: account changes switched off, even with a valid request.
        os.environ.pop('WIZARD_ACCOUNT_CHANGES',None)
        self.assertEqual(c.post(path,json={'action':'add','confirmed':True},headers=headers).status_code,403)
        self.assertEqual(self.b.jobs,{})
        os.environ['WIZARD_ACCOUNT_CHANGES']='1'
        self.addCleanup(os.environ.pop,'WIZARD_ACCOUNT_CHANGES',None)
        self.assertEqual(c.post(path,json={'action':'add','confirmed':True}).status_code,403)
        headers={'X-Wizard-Account-Action':'1'}
        self.assertEqual(c.post(path,json={'action':'add'},headers=headers).status_code,409)
        self.assertEqual(c.post(path,json={'action':'add','confirmed':True},headers={**headers,'sec-fetch-site':'cross-site'}).status_code,403)
        self.assertEqual(c.post(path,json={'code':'sk-SECRET','bad':True},headers=headers).status_code,409)
        self.assertEqual(self.b.jobs,{})

    def test_listing_reports_changes_off_by_default(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        s=importlib.util.spec_from_file_location('api2',ROOT/'hermes-plugin/wizard-os/dashboard/plugin_api.py')
        api=importlib.util.module_from_spec(s); s.loader.exec_module(api)
        api._accounts.provider_accounts=lambda p:{'accounts':[{'id':'aa11bb','actions':{'reconnect':True,'remove':True}}],'actions':{'add':True},'management':{'status':'available'}}
        os.environ.pop('WIZARD_ACCOUNT_CHANGES',None)
        # Any attempt to read auth config would fail this listing: no adoption-setting precondition.
        import sys
        from types import SimpleNamespace
        with patch.dict(sys.modules, {'hermes_cli.config': SimpleNamespace(load_config_readonly=lambda: (_ for _ in ()).throw(AssertionError('config read')))}):
            app=FastAPI(); app.include_router(api.router); j=TestClient(app).get('/provider-accounts/chatgpt').json()
        self.assertEqual(j['management']['status'],'off'); self.assertEqual(j['actions'],{'add':False})
        self.assertEqual(j['accounts'][0]['actions'],{'reconnect':False,'remove':False}); self.assertEqual(j['accounts'][0]['id'],'aa11bb')

    def test_changes_can_be_on_for_chatgpt_only(self):
        """Fresh Wizard OS: WIZARD_ACCOUNT_CHANGES=chatgpt lets the ChatGPT app add sign-ins while Claude stays
        read-only (its sign-in is the Claude Code page the agent's subscription provider uses)."""
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        s=importlib.util.spec_from_file_location('api3',ROOT/'hermes-plugin/wizard-os/dashboard/plugin_api.py')
        api=importlib.util.module_from_spec(s); s.loader.exec_module(api)
        api._lifecycle.broker=self.b
        api._accounts.provider_accounts=lambda p:{'provider':p,'accounts':[],'actions':{'add':True},'management':{'contract':'wizard.account-management/1','status':'available'}}
        os.environ['WIZARD_ACCOUNT_CHANGES']='chatgpt'
        self.addCleanup(os.environ.pop,'WIZARD_ACCOUNT_CHANGES',None)
        import sys
        from types import SimpleNamespace
        with patch.dict(sys.modules, {'hermes_cli.config': SimpleNamespace(load_config_readonly=lambda: {})}):
            c=TestClient((lambda a:(a.include_router(api.router),a)[1])(FastAPI()))
            chatgpt=c.get('/provider-accounts/chatgpt').json(); claude=c.get('/provider-accounts/claude').json()
        self.assertEqual((chatgpt['management']['status'],chatgpt['actions']),('available',{'add':True}))
        self.assertEqual((claude['management']['status'],claude['actions']),('off',{'add':False}))
        headers={'X-Wizard-Account-Action':'1'}
        self.assertEqual(c.post('/provider-accounts/claude/operations',json={'action':'add','confirmed':True},headers=headers).status_code,403)
        self.assertEqual(self.b.jobs,{})
        # '1' still means every provider; anything else (e.g. '0', 'yes') means none.
        self.assertTrue(api._changes_on('claude') is False)
        os.environ['WIZARD_ACCOUNT_CHANGES']='1'; self.assertTrue(api._changes_on('claude') and api._changes_on('chatgpt'))
        os.environ['WIZARD_ACCOUNT_CHANGES']='yes'; self.assertFalse(api._changes_on('chatgpt'))

if __name__=='__main__': unittest.main()
