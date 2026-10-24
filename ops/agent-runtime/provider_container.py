"""Trusted Docker recreation, without putting inspected app credentials in argv/logs."""
import copy
import http.client
import io
import json
import subprocess
from urllib.parse import quote


def sealed_create_spec(info, network, relays):
    config = copy.deepcopy(info['Config'])
    host = copy.deepcopy(info['HostConfig'])
    host['PortBindings'] = {}
    host['PublishAllPorts'] = False
    host['RestartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0}
    host['NetworkMode'] = network
    # Preserve anonymous volumes by their actual names, not by re-allocating Config.Volumes.
    existing = {m.get('Target'): m for m in host.get('Mounts', [])}
    mounts = []
    for mount in info.get('Mounts', []):
        kind, target = mount.get('Type'), mount['Destination']
        if kind == 'tmpfs':
            continue
        if kind not in ('bind', 'volume'):
            raise ValueError('unsupported provider mount')
        original = existing.get(target)
        if original:
            mounts.append(original)
            continue
        source = mount.get('Name') if kind == 'volume' else mount.get('Source')
        if not source:
            raise ValueError('unknown provider mount identity')
        item = {'Type': kind, 'Source': source, 'Target': target, 'ReadOnly': not mount.get('RW', True)}
        if kind == 'bind' and mount.get('Propagation'):
            item['BindOptions'] = {'Propagation': mount['Propagation']}
        mounts.append(item)
    host.pop('Binds', None)
    host['Mounts'] = mounts
    endpoints = {}
    for name, endpoint in info.get('NetworkSettings', {}).get('Networks', {}).items():
        if name not in set(relays) | {network}:
            continue
        value = {'Aliases': endpoint.get('Aliases') or []}
        if endpoint.get('IPAMConfig'):
            value['IPAMConfig'] = copy.deepcopy(endpoint['IPAMConfig'])
        endpoints[name] = value
    if network not in endpoints:
        raise ValueError('missing sealed egress endpoint')
    return {**config, 'HostConfig': host, 'NetworkingConfig': {'EndpointsConfig': endpoints}}


def engine_create(name, spec):
    """Use the active Docker context; secrets travel on stdin, never shell args or diagnostics."""
    raw = json.dumps(spec).encode()
    path = '/containers/create?name=' + quote(name, safe='')
    request = (f'POST {path} HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: {len(raw)}\r\nConnection: close\r\n\r\n').encode() + raw
    result = subprocess.run(['docker', 'system', 'dial-stdio'], input=request, capture_output=True, timeout=60)
    if result.returncode:
        raise ValueError('provider container creation failed')
    class ResponseSocket:
        def makefile(self, *args):
            return io.BytesIO(result.stdout)
    response = http.client.HTTPResponse(ResponseSocket())
    response.begin()
    if response.status != 201:
        raise ValueError('provider container creation failed')
    value = json.loads(response.read())
    cid = value.get('Id')
    if not isinstance(cid, str) or len(cid) != 64 or any(c not in '0123456789abcdef' for c in cid):
        raise ValueError('invalid provider container identity')
    return cid
