import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('prep',Path(__file__).with_name('rig-prepare.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_traceback_preserves_exception_and_assertion_label(self):
  text='Traceback (most recent call last):\n  File "guest.py", line 142\n    assert key == "my-secret", key\nAssertionError: unexpected compose override\n'
  out=m.redact_diagnostic(text);self.assertIn('AssertionError: unexpected compose override',out);self.assertNotIn('my-secret',out)
 def test_secret_environment_and_bearer_and_opaque_values(self):
  for s in ['RuntimeError: TINFOIL_API_KEY=secretvalue','RuntimeError: Authorization: Bearer shortvalue','ValueError: '+('a'*40)]:
   out=m.redact_diagnostic(s);self.assertNotIn('secretvalue',out);self.assertNotIn('shortvalue',out);self.assertNotIn('a'*40,out)
 def test_product_failure_codes_remain_diagnostic(self):
  for code in ['private_provider_container_ambiguous','provider_proxy_configuration_required','provider_container_recreation_failed']:
   self.assertIn(code,m.redact_diagnostic('AssertionError: '+code))
  self.assertNotIn('tf_lowercase_secret_provider_key_opaque_value',m.redact_diagnostic('RuntimeError: tf_lowercase_secret_provider_key_opaque_value'))
 def test_multiline_environment_is_never_echoed(self):
  self.assertEqual(m.redact_diagnostic('APP_ENV=arbitrary\nOTHER_KEY=short\n'), 'nonzero exit (no safe exception diagnostic)')
if __name__=='__main__':unittest.main()
