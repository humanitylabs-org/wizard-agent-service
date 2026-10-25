import importlib.util
from pathlib import Path
import unittest
s=importlib.util.spec_from_file_location('stage',Path(__file__).with_name('stage-candidate.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class FeatureCatalogue(unittest.TestCase):
 def test_disjoint_ids_preserve_both_intents(self):
  base={'schema':1,'features':[{'id':'shared','policy_exemptions':[]}]}
  ours={**base,'features':[{'id':'android-shell-recording-custody','fixture':None},*base['features']]}
  theirs={**base,'features':[{'id':'private-provider-admission','fixture':'private-provider-admission'},*base['features']]}
  out=m.combine_feature_catalogue(base,ours,theirs)
  self.assertEqual(out['features'],[*ours['features'],theirs['features'][0]])
 def test_same_id_competing_answer_refused(self):
  with self.assertRaisesRegex(RuntimeError,'competing catalogue feature'):
   m.combine_feature_catalogue({'features':[{'id':'x','value':0}]},{'features':[{'id':'x','value':1}]},{'features':[{'id':'x','value':2}]})
 def test_duplicate_ids_refused(self):
  with self.assertRaisesRegex(RuntimeError,'duplicate'):
   m.combine_feature_catalogue({'features':[]},{'features':[{'id':'x'},{'id':'x'}]},{'features':[]})
 def test_nonconflicting_changed_and_deleted_records_follow_delta(self):
  base={'features':[{'id':'a','value':0},{'id':'b'}]}
  ours={'features':[{'id':'a','value':1},{'id':'b'}]}
  theirs={'features':[{'id':'a','value':0}]}
  self.assertEqual(m.combine_feature_catalogue(base,ours,theirs),{'features':[{'id':'a','value':1}]})
if __name__=='__main__':unittest.main()
