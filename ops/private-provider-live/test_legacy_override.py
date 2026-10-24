"""Execute the installer's actual override guard AST; no API or filesystem writes."""
import ast,unittest
from pathlib import Path
import yaml
root=ast.parse(Path(__file__).with_name('rehearse-guest.py').read_text())
branch=next(n for n in ast.walk(root) if isinstance(n,ast.If) and ast.unparse(n.test)=="step == 'install'")
nodes=[]
for n in branch.body:
 if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id in ['override','old_compose','old_env'] for t in n.targets):nodes.append(n)
 if isinstance(n,ast.Assert) and 'after' not in ast.unparse(n.test) and ('old_env' in ast.unparse(n.test) or 'old_compose' in ast.unparse(n.test)):nodes.append(n)
code=compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),'actual-installer-guard','exec')
class OverrideTests(unittest.TestCase):
 def guard(self,compose,env=''):
  ns={'yaml':yaml,'prior':{'dockerCompose':compose,'appEnv':env}};exec(code,ns);return ns
 def test_empty(self):self.guard('')
 def test_commented_runtipi_templates(self):self.guard('# Put compose overrides here\nservices: {}\n','# Add environment overrides here\n')
 def test_idempotent_our_bootstrap_override(self):self.guard(self.guard('')['override'])
 def test_runtipi_appended_newlines_preserve_override_tag(self):
  for ending in ['\n','\n\n']:
   self.guard(self.guard('')['override']+ending)
 def test_api_readback_normalizes_only_trailing_newlines(self):
  node=next(n for n in branch.body if isinstance(n,ast.Assert) and 'after' in ast.unparse(n.test))
  check=compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),'actual-api-readback','exec')
  ns=self.guard('');ns['after']={'dockerCompose':ns['override']+'\n','appEnv':'\n'};exec(check,ns)
  ns['after']['dockerCompose']=ns['override'].replace('!override','')
  with self.assertRaises(AssertionError):exec(check,ns)
 def test_provider_credential_mount_is_explicit_only_in_override(self):
  ns=self.guard('');self.assertIn('networks: !override',ns['override']);self.assertIn('name: wizard-tinfoil-private-data',ns['override']);self.assertIn('tinfoil-private-data:/data',ns['override'])
  nodes=[n for n in branch.body if isinstance(n,ast.Assert) and '.pop(' in ast.unparse(n.test)]
  code=compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),'actual-volume-translation','exec')
  comp={'volumes':{'tinfoil-private-data':{'name':'wizard-tinfoil-private-data'}}};svc={'volumes':['tinfoil-private-data:/data']};exec(code,{'comp':comp,'svc':svc});self.assertNotIn('volumes',comp);self.assertNotIn('volumes',svc)
  with self.assertRaises(AssertionError):exec(code,{'comp':{'volumes':{'unexpected':{}}},'svc':svc})
 def test_other_compose_rejected(self):
  with self.assertRaises(AssertionError):self.guard('services:\n  unrelated:\n    image: no\n')
 def test_noncomment_environment_rejected(self):
  with self.assertRaises(AssertionError):self.guard('','SYNTHETIC_TEST=x\n')
if __name__=='__main__':unittest.main()
