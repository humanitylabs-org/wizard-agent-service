import copy,types,unittest
from local_projection import projection,URN,LOCAL_ID
class Tests(unittest.TestCase):
 def registry(self,meta=None):
  meta=meta or {'repo':'local:'+LOCAL_ID,'private':True,'w':{'id':'wizard-tinfoil','private_inference':{'kind':'attested-relay','relay_port':8090}}}
  obj=types.SimpleNamespace(app_meta=lambda root,store,name:copy.deepcopy(meta) if name==LOCAL_ID else None)
  def build(rows,store,host,root):
   apps=[]
   for row in rows:
    name,_,st=row['info']['urn'].partition(':')
    if '_' in name:continue
    got=obj.app_meta(root,st,name)
    if got:apps.append({'id':name,'urn':row['info']['urn'],'status':row['app']['status'],'repo':got['repo']})
   return {'apps':apps}
  obj.build=build;return obj
 def test_only_projects_actual_installed_row_and_keeps_physical_urn(self):
  r=self.registry();rows=[{'info':{'urn':URN},'app':{'status':'running'}}];before=copy.deepcopy(rows);old=r.build
  with projection(r):
   result=r.build(rows,'wizardapps','localhost','root');self.assertEqual(result['apps'][0]['id'],'wizard-tinfoil');self.assertEqual(result['apps'][0]['urn'],URN);self.assertIn('private_inference',result['apps'][0])
  self.assertIs(r.build,old);self.assertEqual(rows,before)
 def test_absent_app_never_synthesizes_an_entry(self):
  r=self.registry()
  with projection(r):self.assertEqual(r.build([],'wizardapps','host','root'),{'apps':[]})
 def test_wrong_source_rejected(self):
  r=self.registry({'repo':'https://invalid','private':True,'w':{'id':'wizard-tinfoil','private_inference':{}}})
  with projection(r):
   with self.assertRaises(ValueError):r.build([{'info':{'urn':URN},'app':{}}],'wizardapps','host','root')
 def test_duplicate_physical_row_rejected(self):
  r=self.registry();row={'info':{'urn':URN},'app':{'status':'running'}}
  with projection(r):
   with self.assertRaises(ValueError):r.build([row,row],'wizardapps','host','root')
if __name__=='__main__':unittest.main()
