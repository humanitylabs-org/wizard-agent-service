"""Hash-closed reuse of Round11c fixture evidence, never fresh/attested inference."""
import ast
import hashlib
import json
from pathlib import Path

OLD_SOURCE = '6bca5abbac1cb393ec5c9c439fe6f6a5c2bfd048'
OLD_MANIFEST = 'ff952f793bb086a295f3fd006baf48357167f6c9e9d8ccf6dd9737be54cff67f'
OLD_LOG = '8c80078a6f952240be5a7fca71b4045aee2735ec4bd5a90f2dc9824a7009ef92'
OLD_CONTROL = '0372679aac3e5436a4e14e1e3ed88cd578033db988af4cea87ed0d5d36b3116b'
OLD_RUNTIME = '5044f936c247fe3322512323a65a9744e1fe828bb2cef835eac3f6faa5b8c155'
CHANGED = 'scripts/private-seal-round11.py'
STOCK_FUNCTIONS = ('run','save','docker','wait','container','json_http','synthetic_image_request','stock_phase')


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def function_closure(source):
    tree = ast.parse(source)
    functions = {n.name:ast.dump(n, include_attributes=False) for n in tree.body if isinstance(n, ast.FunctionDef)}
    return {name:functions[name] for name in STOCK_FUNCTIONS}


def validate_inheritance(root):
    root = Path(root)
    old = root / 'inherited/round11c'
    inventory = json.loads((old/'SHA256.json').read_text())
    for name, expected in inventory.items():
        path = (old/name).resolve()
        assert path.is_relative_to(old.resolve()) and digest(path) == expected, 'inherited_bytes_drift:' + name
    assert digest(old/'SOURCE.json') == OLD_MANIFEST
    previous = json.loads((old/'SOURCE.json').read_text())
    assert previous['source_head'] == OLD_SOURCE
    assert digest(old/'worker.log') == OLD_LOG
    worker = json.loads((old/'worker-receipt.json').read_text())
    assert worker['job_id'] == 'heavy_067f607ea7b146b3ae0b3c316ec710ed' and worker['log_sha256'] == OLD_LOG
    assert worker['exit_code'] == 2 and worker['state'] == 'failed'
    assert digest(old/'qa/round11c-control/receipt.json') == OLD_CONTROL
    assert digest(old/'qa/round11c/receipt.json') == OLD_RUNTIME
    # Broad unchanged-source/dependency closure: EVERY old staged file except
    # the deliberately repaired manager monolith. Includes all production code,
    # WAM dependencies, package files, image archive and original gateway tests.
    closure = {}
    for name, expected in previous['files'].items():
        if name == CHANGED: continue
        path = (root/name).resolve()
        assert path.is_relative_to(root.resolve()) and digest(path) == expected, 'dependency_drift:' + name
        closure[name] = expected
    assert digest(old/'stock-source.py') == previous['files'][CHANGED]
    assert function_closure((root/CHANGED).read_text()) == function_closure((old/'stock-source.py').read_text()), 'stock_function_drift'
    control = json.loads((old/'qa/round11c-control/receipt.json').read_text())
    runtime = json.loads((old/'qa/round11c/receipt.json').read_text())
    assert control['source_head'] == runtime['source_head'] == OLD_SOURCE
    assert control['manifest_sha256'] == OLD_MANIFEST and control['setup_proven'] is True
    for value in (control,runtime):
        assert value['synthetic_only'] is True and value['live_touched'] is False and value['leftover_containers'] == 0
        assert value['checks']['owned_resources_cleaned'] is True and value['checks']['synthetic_secret_work_removed'] is True
    assert control['leftover_networks'] == 0 and control['migration_admitted'] is False
    reports = {}
    for phase, count in (('gateway',2),('socket-preflight',4)):
        report = json.loads((old/f'qa/round11c-control/{phase}-vitest.json').read_text())
        assert report['success'] is True and report['numPassedTests'] == count and report['numFailedTests'] == 0
        # Carry original per-file/per-case results, not regenerated pass totals.
        reports[phase] = {'sha256':digest(old/f'qa/round11c-control/{phase}-vitest.json'), 'report':report}
    checks = {key:runtime['checks'][key] for key in ('stock_setup_ready','stock_stopped_provider_no_completion',
               'stock_provider_recovery_completed','synthetic_image_content_request')}
    assert all(value is True for value in checks.values())
    return {'scope':'Inherited synthetic fixture evidence only; not attested real inference or terminal provider failure.',
            'source_head':OLD_SOURCE,'worker_log_sha256':OLD_LOG,'control_receipt_sha256':OLD_CONTROL,
            'runtime_receipt_sha256':OLD_RUNTIME,'dependency_hashes':closure,'unchanged_stock_functions':list(STOCK_FUNCTIONS),
            'checks':checks,'reports':reports,'images':control['images']}
