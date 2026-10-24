import copy
import json
import subprocess
from unittest.mock import patch
import pytest
from provider_container import engine_create, sealed_create_spec


def fixture():
    return {'Config': {'Image': 'fixture', 'Env': ['FIXTURE_VALUE=synthetic-only'], 'Labels': {'fixture': 'yes'}, 'Volumes': {'/data': {}}},
            'HostConfig': {'PortBindings': {'8090/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18090'}]}, 'PublishAllPorts': True, 'NetworkMode': 'old', 'Binds': ['/fixture:/data'], 'RestartPolicy': {'Name': 'always'}},
            'Mounts': [{'Type': 'volume', 'Name': 'recorded-anonymous-volume', 'Destination': '/data', 'RW': True}, {'Type': 'bind', 'Source': '/fixture/config', 'Destination': '/config', 'RW': False}],
            'NetworkSettings': {'Networks': {'old': {}, 'sealed': {'IPAMConfig': {'IPv4Address': '10.253.0.2'}, 'Aliases': ['fixture']}, 'relay': {'Aliases': ['fixture-relay']}}}}


def test_sealed_recreation_preserves_mount_identity_and_only_internal_endpoints():
    info = fixture(); before = copy.deepcopy(info)
    spec = sealed_create_spec(info, 'sealed', ['relay'])
    assert info == before
    assert spec['Env'] == info['Config']['Env']
    assert spec['HostConfig']['PortBindings'] == {}
    assert spec['HostConfig']['PublishAllPorts'] is False
    assert spec['HostConfig']['RestartPolicy']['Name'] == 'no'
    assert spec['HostConfig']['NetworkMode'] == 'sealed'
    assert 'Binds' not in spec['HostConfig']
    assert spec['HostConfig']['Mounts'][0]['Source'] == 'recorded-anonymous-volume'
    assert spec['HostConfig']['Mounts'][1]['ReadOnly'] is True
    assert set(spec['NetworkingConfig']['EndpointsConfig']) == {'sealed', 'relay'}


def test_unknown_mount_or_missing_internal_endpoint_fails_before_recreation():
    info = fixture(); info['Mounts'][0].pop('Name')
    with pytest.raises(ValueError): sealed_create_spec(info, 'sealed', [])
    with pytest.raises(ValueError): sealed_create_spec(fixture(), 'absent', [])


def test_engine_transport_keeps_config_out_of_argv_and_diagnostics():
    payload = json.dumps({'Id': 'a' * 64}).encode()
    wire = b'HTTP/1.1 201 Created\r\nContent-Length: ' + str(len(payload)).encode() + b'\r\n\r\n' + payload
    with patch('provider_container.subprocess.run', return_value=subprocess.CompletedProcess([], 0, wire, b'')) as run:
        assert engine_create('fixture', {'Env': ['FIXTURE_VALUE=synthetic-only']}) == 'a' * 64
    args, kwargs = run.call_args
    assert args[0] == ['docker', 'system', 'dial-stdio']
    assert b'FIXTURE_VALUE=synthetic-only' in kwargs['input']
    with patch('provider_container.subprocess.run', return_value=subprocess.CompletedProcess([], 1, b'', b'synthetic-daemon-diagnostic')):
        with pytest.raises(ValueError) as error: engine_create('fixture', {})
    assert 'synthetic-daemon-diagnostic' not in str(error.value)
