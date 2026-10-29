"""Backward compatible runtime selection; synthetic records only, no Docker."""
import copy
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parent))
import agent_runtime as ar


def test_legacy_no_app_does_not_change_record_or_driver():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        folder = root / 'private'
        folder.mkdir()
        agent = {'schema': 1, 'id': 'private', 'privacy': 'private', 'model': {'provider': 'tinfoil'},
                 'runtime': {'kind': 'container', 'app_id': 'agent-private', 'port': 18650}}
        original = json.dumps(agent)
        (folder / 'agent.json').write_text(original)
        agents = ar.Agents(root)
        loaded = agents.read('private')
        assert loaded == agent
        assert (folder / 'agent.json').read_text() == original
        assert not agents.providers.is_private(loaded)
        plain, sealed = object(), object()
        assert ar.driver_for(loaded, plain, sealed) is plain
        doc = json.loads(ar.compose_doc(loaded, image='fixture', proxy_image=ar.DEFAULT_PROXY_IMAGE,
                                      home_source='/synthetic/home', uid=1234, gid=1235, ports=True))
        assert 'agent-private-tinfoil' in doc['services']
        assert doc['services']['agent-private']['ports'] == ['127.0.0.1:18650:8642']
        assert doc['services']['agent-private-tinfoil']['image'] == ar.DEFAULT_PROXY_IMAGE


def test_app_installation_alone_never_marks_legacy_agent():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        apps = root / 'apps.json'
        apps.write_text(json.dumps({'apps': [{'id': 'wizard-tinfoil', 'status': 'running', 'private_inference': {'kind': 'attested-relay', 'relay_port': 8090}}]}))
        agents = ar.Agents(root / 'agents', apps_path=apps)
        legacy = {'id': 'private', 'privacy': 'private', 'model': {'provider': 'tinfoil'}, 'runtime': {}}
        assert not agents.providers.is_private(legacy)
        migrated = copy.deepcopy(legacy)
        migrated['runtime']['private_client'] = True
        assert agents.providers.is_private(migrated)
        apps.write_text('{"apps":[]}')
        assert agents.providers.is_private(migrated)
        plain, sealed = Mock(), Mock()
        assert ar.driver_for(migrated, plain, sealed) is sealed
        with patch.object(agents.providers, 'docker', side_effect=AssertionError('must reject before Docker')):
            try:
                agents.providers.prepare(migrated)
            except ar.RuntimeFailure as error:
                assert (error.code, error.status) == ('private_provider_unavailable', 503)
            else:
                raise AssertionError('missing app admitted migrated agent')
