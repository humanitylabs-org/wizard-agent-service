#!/usr/bin/env python3
"""Exact TCP grant tests use the real CONNECT handler and a recording fixed relay."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

os.environ.setdefault('EGRESS_ALLOWLIST_HOSTS', 'github.com api.github.com')
spec = importlib.util.spec_from_file_location('egress', Path(__file__).resolve().parents[1] / 'sidecars/egress.py')
eg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(eg)
ENTRY = {'alias': 'builder', 'address': '100.100.100.100', 'port': 22, 'relay_port': 18222}


class Policy(unittest.TestCase):
    def test_empty_is_default(self):
        self.assertEqual(eg.load_declared_tcp('[]', ''), {})

    def test_exact_and_invalid(self):
        good = eg.load_declared_tcp(json.dumps([ENTRY]), '10.250.0.17')
        self.assertEqual(set(good), {('builder', '22')})
        invalid = [dict(ENTRY, alias='*.builder'), dict(ENTRY, alias='localhost'),
                   dict(ENTRY, address=1684300900), dict(ENTRY, address='127.0.0.1'), dict(ENTRY, address='10.0.0.1'),
                   dict(ENTRY, address='100.100.100.100/32'), dict(ENTRY, port=True),
                   dict(ENTRY, port=443), dict(ENTRY, relay_port=22), dict(ENTRY, extra='x')]
        # localhost is syntactically an alias, not a destination or DNS lookup.
        invalid.pop(1)
        for entry in invalid:
            with self.subTest(entry=entry), self.assertRaises((ValueError, TypeError)):
                eg.load_declared_tcp(json.dumps([entry]), '10.250.0.17')
        for value in ('null', '{}', '[1]', json.dumps([ENTRY, ENTRY])):
            with self.assertRaises((ValueError, TypeError)):
                eg.load_declared_tcp(value, '10.250.0.17')
        for relay in ('127.0.0.1', '10.250.0.18', '10.251.0.17', '0.0.0.0'):
            with self.assertRaises(ValueError):
                eg.load_declared_tcp(json.dumps([ENTRY]), relay)


class Tunnel(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.received, self.targets = [], []
        async def relay(r, w):
            w.write(b'SSH-2.0-fixed-relay\r\n')
            await w.drain()
            self.received.append(await r.read(64))
            w.close()
            await w.wait_closed()
        self.relay = await asyncio.start_server(relay, '127.0.0.1', 0)
        relay_port = self.relay.sockets[0].getsockname()[1]
        real_open = asyncio.open_connection
        async def connect(host, port, **kwargs):
            self.targets.append((host, port))
            return await real_open('127.0.0.1', relay_port, **kwargs)
        self.real_open = real_open
        self.patches = [patch.object(eg, 'DECLARED_TCP', eg.load_declared_tcp(json.dumps([ENTRY]), '10.250.0.17')),
                        patch.object(eg.asyncio, 'open_connection', side_effect=connect), patch.object(eg, 'log')]
        for p in self.patches:
            p.start()
        self.gate = await asyncio.start_server(eg.handle, '127.0.0.1', 0)

    async def asyncTearDown(self):
        self.gate.close()
        self.relay.close()
        await self.gate.wait_closed()
        await self.relay.wait_closed()
        for p in reversed(self.patches):
            p.stop()

    async def request(self, target):
        r, w = await self.real_open('127.0.0.1', self.gate.sockets[0].getsockname()[1])
        w.write(f'CONNECT {target} HTTP/1.1\r\n\r\n'.encode())
        await w.drain()
        status = await asyncio.wait_for(r.readuntil(b'\r\n\r\n'), 2)
        return r, w, status

    async def test_declared_reachable(self):
        r, w, status = await self.request('builder:22')
        self.assertIn(b'200', status)
        self.assertEqual(await asyncio.wait_for(r.readline(), 2), b'SSH-2.0-fixed-relay\r\n')
        w.write(b'opaque ssh bytes')
        await w.drain()
        await asyncio.wait_for(r.read(), 2)
        w.close()
        await w.wait_closed()
        self.assertEqual(self.targets, [('10.250.0.17', 18222)])
        self.assertEqual(self.received, [b'opaque ssh bytes'])

    async def test_undeclared_never_connects(self):
        for target in ('builder:23', 'other:22', '100.100.100.101:22', '100.100.100.100:22',
                       '127.0.0.1:22', '10.250.0.17:22', 'host.docker.internal:22',
                       'builder.:22', 'BUILDER:22', 'builder:022', 'github.com:22'):
            r, w, status = await self.request(target)
            self.assertIn(b'403', status, target)
            w.close()
            await w.wait_closed()
        self.assertEqual(self.targets, [])
        self.assertEqual(self.received, [])

    def test_https_stays_separate(self):
        self.assertTrue(eg.host_allowed('github.com'))
        self.assertTrue(eg.host_allowed('api.github.com'))
        for name in ('builder', '100.100.100.100', 'localhost'):
            self.assertFalse(eg.host_allowed(name))


if __name__ == '__main__':
    unittest.main(verbosity=2)
