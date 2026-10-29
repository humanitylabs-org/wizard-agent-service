"""Service-owned provider-key injector for the sealed private runtime.

Hermes holds only the public placeholder bearer. This stdlib reverse proxy is
the sole holder of the provider key (read-only Service-owned file) and the only
client of the official attestation proxies on a separate internal network.

* One request per connection, Content-Length bodies only, fixed upstream IP and
  the same port; no CONNECT, absolute-form targets, chunked uploads or
  pipelining. Responses (including SSE streams) are relayed byte-for-byte.
* An agent that presents anything but the placeholder is refused (401): a home
  that still holds the real bearer must never be keyed a second time.
* Never logs; the Compose service also uses logging driver none.
"""
import asyncio
import hmac
import json
import os
import re

PLACEHOLDER = 'wizard-sealed-provider-key-held-by-injector'
MAX_HEAD = 16384
MAX_BODY = 8 * 1024 * 1024
IDLE = 600
# Upstream connect bound. The official proxy is a local container on the same
# internal bridge: a healthy one accepts in milliseconds. A stopped one leaves a
# stale neighbour entry whose SYNs are silently dropped, which previously held
# the agent for the full 10 s before 502 (round 10, forum). Bounded fail-closed.
CONNECT_TIMEOUT = 2.0
METHODS = {'GET', 'POST', 'DELETE'}
SAFE_PATH = re.compile(r'^/[A-Za-z0-9._~/-]*$')
TOKEN = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
BAD_VALUE = re.compile(r'[\x00-\x08\x0a-\x1f\x7f]')
# Never forwarded from the agent; authorization is replaced, not passed.
DROP = {'authorization', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade',
        'proxy-connection', 'content-length', 'transfer-encoding', 'forwarded', 'x-forwarded-for',
        'x-forwarded-host', 'x-forwarded-proto', 'cookie'}


def read_key(path):
    """Bare key or KEY=value; never logged, never returned to a client."""
    with open(path, encoding='utf-8') as fh:
        text = fh.read()
    for line in text.splitlines():
        line = line.strip()
        if line.startswith('TINFOIL_API_KEY='):
            line = line.split('=', 1)[1].strip().strip('\'"')
        elif not line or line.startswith('#') or '=' in line:
            continue
        if not line or BAD_VALUE.search(line) or ' ' in line or len(line) > 512 or line == PLACEHOLDER:
            raise ValueError('key')
        return line
    raise ValueError('key')


def parse_head(head):
    """Return (method, target, headers) or raise ValueError; strict HTTP/1.1."""
    lines = head.decode('latin-1').split('\r\n')
    method, target, version = lines[0].split(' ')
    if method not in METHODS or version != 'HTTP/1.1':
        raise ValueError('method')
    path = target.split('?', 1)[0]
    if not SAFE_PATH.fullmatch(path) or '//' in path or any(s in ('.', '..') for s in path.split('/')):
        raise ValueError('path')
    if '?' in target and not re.fullmatch(r'[A-Za-z0-9._~=&%+-]*', target.split('?', 1)[1]):
        raise ValueError('query')
    headers = []
    seen = set()
    for line in lines[1:]:
        name, sep, value = line.partition(':')
        if not sep or not TOKEN.fullmatch(name) or BAD_VALUE.search(value):
            raise ValueError('header')
        key = name.lower()
        if key in seen and key in ('authorization', 'content-length', 'transfer-encoding', 'host'):
            raise ValueError('duplicate')
        seen.add(key)
        headers.append((key, value.strip()))
    return method, target, headers


def rewrite(method, target, headers, key, length):
    names = dict(headers)
    if names.get('transfer-encoding'):
        raise ValueError('chunked')
    if not hmac.compare_digest(names.get('authorization', ''), 'Bearer ' + PLACEHOLDER):
        raise PermissionError('placeholder')
    if 'host' not in names:
        raise ValueError('host')
    out = [f'{method} {target} HTTP/1.1']
    out += [f'{k}: {v}' for k, v in headers if k not in DROP]
    out += ['Authorization: Bearer ' + key, f'Content-Length: {length}', 'Connection: close']
    return ('\r\n'.join(out) + '\r\n\r\n').encode('latin-1')


async def reply(writer, code, error):
    body = json.dumps({'error': error}).encode()
    writer.write(f'HTTP/1.1 {code} {error}\r\nContent-Type: application/json\r\n'
                 f'Content-Length: {len(body)}\r\nConnection: close\r\n\r\n'.encode() + body)
    try:
        await writer.drain()
    finally:
        writer.close()


async def pump(reader, writer):
    try:
        while data := await asyncio.wait_for(reader.read(65536), IDLE):
            writer.write(data)
            await writer.drain()
    except (asyncio.TimeoutError, ConnectionError, OSError):
        pass
    finally:
        try:
            writer.close()
        except Exception:  # noqa: BLE001
            pass


def handler(upstream_ip, port, key_file, connect_timeout=CONNECT_TIMEOUT):
    async def handle(reader, writer):
        try:
            head = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 30)
            if len(head) > MAX_HEAD:
                raise ValueError('head')
            method, target, headers = parse_head(head[:-4])
            length = int(dict(headers).get('content-length', '0'))
            if not 0 <= length <= MAX_BODY:
                raise ValueError('length')
            body = await asyncio.wait_for(reader.readexactly(length), 60) if length else b''
            try:
                key = read_key(key_file)
            except (OSError, ValueError):
                return await reply(writer, 503, 'provider_key_unavailable')
            request = rewrite(method, target, headers, key, len(body))
        except PermissionError:
            return await reply(writer, 401, 'agent_must_not_hold_provider_key')
        except (ValueError, asyncio.LimitOverrunError, asyncio.IncompleteReadError, asyncio.TimeoutError, UnicodeError):
            return await reply(writer, 400, 'request_refused')
        try:
            up_reader, up_writer = await asyncio.wait_for(asyncio.open_connection(upstream_ip, port), connect_timeout)
        except (OSError, asyncio.TimeoutError):
            return await reply(writer, 502, 'provider_unavailable')
        up_writer.write(request + body)
        await up_writer.drain()
        await pump(up_reader, writer)
        up_writer.close()
    return handle


async def main():
    listen, upstream = os.environ['LISTEN_IP'], os.environ['UPSTREAM_IP']
    key_file = os.environ.get('KEY_FILE', '/run/provider-key/key')
    read_key(key_file)   # fail at start rather than accept requests unkeyed
    ports = [int(p) for p in json.loads(os.environ.get('PORTS', '[3301]'))]
    bound = float(os.environ.get('CONNECT_TIMEOUT', CONNECT_TIMEOUT))
    if not 0 < bound <= 4:
        raise ValueError('connect_timeout')   # never configurable past the 5 s fail-closed bound
    servers = [await asyncio.start_server(handler(upstream, p, key_file, bound), listen, p, limit=MAX_HEAD * 2)
               for p in ports]
    await asyncio.gather(*(s.serve_forever() for s in servers))


if __name__ == '__main__':
    asyncio.run(main())
