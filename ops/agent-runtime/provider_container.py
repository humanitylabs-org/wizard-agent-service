"""Trusted Docker recreation, without putting inspected app credentials in argv/logs."""
import copy
import http.client
import json
import subprocess
import threading
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
    # Keep the tunnel's write side open until Docker has finished the response.
    # communicate()/run(input=...) closes stdin immediately; dial-stdio then
    # cancels the in-flight create request, which dockerd answers with HTTP 499.
    process = subprocess.Popen(['docker', 'system', 'dial-stdio'], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    timer = threading.Timer(60, process.kill)
    timer.daemon = True
    timer.start()
    response = None
    try:
        process.stdin.write(request)
        process.stdin.flush()
        class ResponseSocket:
            def makefile(self, *args):
                return process.stdout
        response = http.client.HTTPResponse(ResponseSocket())
        response.begin()
        if response.status != 201:
            raise ValueError('provider container creation failed')
        value = json.loads(response.read())
        cid = value.get('Id')
        if not isinstance(cid, str) or len(cid) != 64 or any(c not in '0123456789abcdef' for c in cid):
            raise ValueError('provider container creation failed')
        return cid
    except (OSError, http.client.HTTPException, ValueError, TypeError, AttributeError):
        # Neither a daemon body nor stderr may expose inspected credentials.
        raise ValueError('provider container creation failed') from None
    finally:
        timer.cancel()
        if response is not None:
            response.close()
        try:
            process.stdin.close()
        except OSError:
            pass
        process.stdout.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
