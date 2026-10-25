"""Production admission remains read-only against the older installed WAM API client."""
import hashlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import production_readiness as pr

class ProductionReadinessTests(unittest.TestCase):
    def test_old_client_uses_authenticated_get_not_new_python_method(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); source=root/'source'; source.write_bytes(b'fixture')
            digest=hashlib.sha256(source.read_bytes()).hexdigest()
            plan={'python_only_wam':True,'runtipi_daemon_unchanged':True,'home':str(root),'service_origin':'http://fixture','owner_proof_file':str(source),'legacy_source':str(source),'runtime_auth_file':str(source)}
            full={'normal_status':'passed','forced_failure_status':'rolled_back','completed_legacy_after_rollback':True,'tooling_sha256':{}}
            for name in ['service_sha','ux_sha','wam_archive_sha256','provider_archive_sha256','provider_image_archive_sha256','provider_image_id']:
                plan[name]=full[name]=digest
            for name in ['wam','provider','provider_image']:plan[name+'_archive']=str(source)
            calls=[]
            rt=SimpleNamespace(req=lambda method,url:calls.append((method,url)) or {'data':[]})
            owner=SimpleNamespace(require=lambda url:{'agent':{'privacy':'private','model':{'provider':'tinfoil'}}})
            live={'wam_sources':{'selected':{'api':{'resolved':str(root)}}}}
            with patch.object(pr,'code_hashes',return_value={}),patch.object(pr,'api',return_value=rt),patch.object(pr,'urns',return_value={pr.OLD:{}}),patch.object(pr,'user_config',return_value={}),patch.object(pr,'Owner',return_value=owner),patch.object(Path,'home',return_value=root),patch.object(pr.os,'access',return_value=True):
                self.assertEqual(pr.check(plan,{'full_live_run_all':full},live,root),[])
            self.assertEqual(calls,[('GET','/backups/'+pr.OLD+'?page=1&pageSize=1000')])

if __name__=='__main__':unittest.main()
