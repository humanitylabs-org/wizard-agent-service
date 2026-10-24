"""Host wrapper compile/exit tests without any SSH, VM, or credential."""
import io,sys,types,unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).parent
class HostDriverTests(unittest.TestCase):
 def test_preserves_guest_exit_and_compiles_wrapper(self):
  source=(ROOT/'legacy-host.py').read_text()
  for result in [0,19]:
   scripts=[]
   class Rig:
    def __init__(self,root):pass
    def python(self,code,**kwargs):
     compile(code,'generated-guest-wrapper','exec');scripts.append(code)
     return 'safe result\nRETURN_CODE='+str(result)+'\n'
   class Loader:
    def exec_module(self,module):module.Rig=Rig
   stdout=io.StringIO()
   with patch.object(sys,'argv',['legacy-host.py','synthetic.py','verify-migrated']),patch.object(sys,'stdin',io.TextIOWrapper(io.BytesIO(b''))),patch('importlib.util.spec_from_file_location',lambda *a:types.SimpleNamespace(loader=Loader())),patch('importlib.util.module_from_spec',lambda *a:types.SimpleNamespace()),patch.object(Path,'read_text',lambda *a,**k:'print("safe synthetic child")'),redirect_stdout(stdout):
    with self.assertRaises(SystemExit) as raised:exec(compile(source,'legacy-host.py','exec'),{'__name__':'__main__'})
   self.assertEqual(raised.exception.code,result);self.assertIn('verify-migrated',scripts[0]);self.assertIn('log.chmod(0o600)',scripts[0]);self.assertNotIn('RETURN_CODE=',stdout.getvalue())
if __name__=='__main__':unittest.main()
