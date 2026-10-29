import copy
import json
import subprocess
import sys
import threading
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


ENGINE_FIXTURE = r'''
import json,select,sys,time
headers={}
request=sys.stdin.buffer.readline()
while True:
 line=sys.stdin.buffer.readline()
 if line==b'\r\n':break
 name,value=line.split(b':',1);headers[name.lower()]=value.strip()
body=sys.stdin.buffer.read(int(headers[b'content-length']))
assert json.loads(body).get('Env')==['FIXTURE_VALUE=synthetic-only']
# Simulate dockerd cancelling a request when the tunnel prematurely sends EOF.
premature=bool(select.select([sys.stdin.buffer],[],[],0)[0])
status=499 if premature else 201
payload=json.dumps({'Id':'a'*64}).encode() if status==201 else b'synthetic-daemon-diagnostic'
sys.stdout.buffer.write(('HTTP/1.1 '+str(status)+' Status\r\nContent-Length: '+str(len(payload))+'\r\n\r\n').encode()+payload)
sys.stdout.buffer.flush()
sys.stdin.buffer.read()
'''


def test_engine_transport_keeps_stdin_open_and_config_out_of_argv():
    real_popen = subprocess.Popen
    calls=[]
    def fixture_process(args,**kwargs):
        calls.append((args,kwargs))
        return real_popen([sys.executable,'-c',ENGINE_FIXTURE],**kwargs)
    with patch('provider_container.subprocess.Popen', side_effect=fixture_process):
        assert engine_create('fixture', {'Env': ['FIXTURE_VALUE=synthetic-only']}) == 'a' * 64
    args,kwargs=calls[0]
    assert args==['docker','system','dial-stdio']
    assert kwargs['stderr']==subprocess.DEVNULL
    assert 'FIXTURE_VALUE' not in repr(args)


def test_engine_failures_do_not_echo_daemon_body():
    real_popen=subprocess.Popen
    failure=ENGINE_FIXTURE.replace('status=499 if premature else 201','status=403')
    with patch('provider_container.subprocess.Popen', side_effect=lambda args,**kw:real_popen([sys.executable,'-c',failure],**kw)):
        with pytest.raises(ValueError) as error:engine_create('fixture', {'Env':['FIXTURE_VALUE=synthetic-only']})
    assert str(error.value)=='provider container creation failed'
    assert 'synthetic-daemon-diagnostic' not in str(error.value)


def test_engine_read_deadline_kills_tunnel_and_does_not_leak_payload():
    real_popen,real_timer=subprocess.Popen,threading.Timer
    processes=[]
    def hung_process(args,**kwargs):
        p=real_popen([sys.executable,'-c','import time;time.sleep(30)'],**kwargs)
        processes.append(p);return p
    with patch('provider_container.subprocess.Popen',side_effect=hung_process),patch('provider_container.threading.Timer',side_effect=lambda seconds,fn:real_timer(.1,fn)):
        with pytest.raises(ValueError,match='^provider container creation failed$'):
            engine_create('fixture', {'Env':['FIXTURE_VALUE=synthetic-only']})
    assert all(p.poll() is not None for p in processes)
