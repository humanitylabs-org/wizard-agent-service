"""Extend WAM's registry projection for an installed private-local provider.

The physical _private URN avoids catalogue materialization. Preserve that exact
URN but project the canonical wizard.md identity. This consumes only real rows
returned by the authenticated installed-app API; it never admits a missing app.
"""
import copy
from contextlib import contextmanager
URN='wizard-tinfoil_private:wizardapps'
LOCAL_ID='wizard-tinfoil_private'
CANONICAL='wizard-tinfoil'

@contextmanager
def projection(registry):
 original_build=registry.build;original_meta=registry.app_meta
 def build(installed,store,host,runtipi_root):
  rows=copy.deepcopy(installed);found=False;meta=None
  for row in rows:
   info=row.get('info') or {}
   if info.get('urn')!=URN:continue
   if found:raise ValueError('duplicate physical private-local provider')
   meta=original_meta(runtipi_root,'wizardapps',LOCAL_ID)
   if not meta or meta.get('repo')!='local:'+LOCAL_ID or not meta.get('private') or meta['w'].get('id')!=CANONICAL or not meta['w'].get('private_inference'):raise ValueError('invalid private-local provider provenance/capability')
   found=True;info['urn']=CANONICAL+':wizardapps'
  def app_meta(root,st,name):
   return original_meta(root,st,LOCAL_ID if found and st=='wizardapps' and name==CANONICAL else name)
  registry.app_meta=app_meta
  try:result=original_build(rows,store,host,runtipi_root)
  finally:registry.app_meta=original_meta
  if found:
   assert meta is not None
   projected=[a for a in result['apps'] if a['id']==CANONICAL]
   if len(projected)!=1:raise ValueError('canonical private-local provider projection missing/ambiguous')
   projected[0]['urn']=URN
   projected[0]['private_inference']=meta['w']['private_inference']
  return result
 registry.build=build
 try:yield
 finally:registry.build=original_build;registry.app_meta=original_meta
