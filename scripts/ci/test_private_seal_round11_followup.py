"""Focused Round11e regressions. Parent executes on forum, never on VPS."""
import ast
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
from private_seal_round11_followup import phase_record, safe_proxy_errors, IMAGE_PROBE, PHASES
spec=importlib.util.spec_from_file_location('injector_r11e',ROOT/'ops/agent-runtime/provider-key-injector.py')
assert spec is not None and spec.loader is not None
inj=importlib.util.module_from_spec(spec); spec.loader.exec_module(inj)


class FollowupTests(unittest.TestCase):
    def test_failed_phase_does_not_skip_next_or_become_restart_pass(self):
        life={'phase_results':{}}; persisted=[]; diagnosed=[]
        def bad(): raise RuntimeError('namespace path: lstat /proc/6592/ns/net: no such file or directory')
        def save(): persisted.append(json.loads(json.dumps(life)))
        self.assertFalse(phase_record(life,'restart',bad,save,diagnosed.append))
        self.assertTrue(phase_record(life,'rollback',lambda:True,save,diagnosed.append))
        self.assertFalse(life['restart']);self.assertTrue(life['rollback'])
        self.assertEqual(diagnosed,['restart','rollback'])
        self.assertEqual(life['phase_results']['restart']['status'],'failed')
        self.assertIn('namespace_errors',life['phase_results']['restart']['safe_error'])
        with self.assertRaisesRegex(RuntimeError,'already_recorded'):
            phase_record(life,'restart',lambda:True,save,diagnosed.append)

    def test_diagnostic_failure_does_not_erase_phase_result(self):
        life={'phase_results':{}}
        def bad(_):raise OSError('synthetic')
        self.assertTrue(phase_record(life,'install',lambda:True,lambda:None,bad))
        self.assertEqual(life['diagnostic_errors']['install'],'OSError')
        self.assertTrue(life['install'])

    def test_safe_errors_never_emit_raw_header_or_prompt(self):
        marker='SYNTHETIC-PRIVATE-NEVER-EMIT'
        value=safe_proxy_errors('Authorization: Bearer '+marker+'\nTLS certificate verification timeout\n')
        self.assertNotIn(marker,json.dumps(value))
        self.assertEqual(value['category_counts']['timeout'],1)
        self.assertFalse(value['raw_log_retained'])

    def test_routes_are_per_listener_and_default_is_backward_compatible(self):
        self.assertEqual(inj.upstream_routes([3301,3302],'10.248.91.2',{}),{3301:'10.248.91.2',3302:'10.248.91.2'})
        self.assertEqual(inj.upstream_routes([3301,3302],'10.248.91.2',{'3302':'10.248.91.4'}),
                         {3301:'10.248.91.2',3302:'10.248.91.4'})
        for value in ({'123':'10.0.0.2'},{'3302':'example.com'},{'3302':'127.0.0.1'},
                      {'3302':'0.0.0.0'},{'3302':'8.8.8.8'},{'3302':'::1'},{'3302':'224.0.0.1'}):
            with self.assertRaises(ValueError):inj.upstream_routes([3301,3302],'10.248.91.2',value)

    def test_every_phase_is_invoked_separately_and_provider_last(self):
        source=(ROOT/'scripts/private-seal-round11.py').read_text();tree=ast.parse(source)
        manager=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='manager_phase')
        calls=[n for n in manager.body if isinstance(n,ast.Expr) and isinstance(n.value,ast.Call)
               and isinstance(n.value.func,ast.Name) and n.value.func.id=='phase']
        self.assertEqual([n.value.args[0].value for n in calls],list(PHASES))
        restart=next(n for n in manager.body if isinstance(n,ast.FunctionDef) and n.name=='restart')
        self.assertIn('rt.restart(urn)',ast.unparse(restart))
        self.assertNotIn('rt.stop(',ast.unparse(restart))
        self.assertNotIn('rt.start(',ast.unparse(restart))

    def test_verification_and_image_requests_have_injector_placeholder(self):
        tree=ast.parse(IMAGE_PROBE)
        calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='Request']
        self.assertEqual(len(calls),2)
        self.assertTrue(any('headers=headers' in ast.unparse(c) for c in calls))
        self.assertTrue(any('**headers' in ast.unparse(c) for c in calls))
        self.assertIn('wizard-sealed-provider-key-held-by-injector',IMAGE_PROBE)
        self.assertNotIn('except (OSError,ValueError):pass',IMAGE_PROBE)


if __name__=='__main__':unittest.main()
