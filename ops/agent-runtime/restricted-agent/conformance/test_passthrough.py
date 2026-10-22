"""Offline parser, DNS, alias-policy, resource-bound and receipt-redaction regressions."""
import asyncio
import importlib.util
import os
from pathlib import Path
import random
import ssl
import struct
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sidecars'))
sys.path.insert(0, str(ROOT))
os.environ.setdefault('EGRESS_ALLOWLIST_HOSTS', 'api.anthropic.com platform.claude.com')
import egress as eg
import upstream_dns as dns
import passthrough
from redact import redact


def hello(name: str | None = 'api.anthropic.com'):
    ctx = ssl.create_default_context()
    if name is None:
        ctx.check_hostname = False
    incoming, outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
    obj = ctx.wrap_bio(incoming, outgoing, server_hostname=name)
    try:
        obj.do_handshake()
    except ssl.SSLWantReadError:
        pass
    return outgoing.read()


class ParserTest(unittest.TestCase):
    def test_real_clienthello_without_ech(self):
        self.assertEqual(eg.client_hello_sni(hello()[5:]), 'api.anthropic.com')

    def test_no_sni(self):
        self.assertEqual(eg.client_hello_sni(hello(None)[5:]), '')

    def test_ip_literal_has_no_sni_and_is_denied(self):
        self.assertEqual(eg.client_hello_sni(hello('1.1.1.1')[5:]), '')
        self.assertFalse(eg.passthrough_allowed('1.1.1.1'))

    def test_every_truncation(self):
        hs = hello()[5:]
        for i in range(len(hs)):
            with self.subTest(i=i), self.assertRaises(ValueError):
                eg.client_hello_sni(hs[:i])

    def test_malformed_and_fuzz(self):
        rng = random.Random(392)
        for _ in range(2000):
            data = rng.randbytes(rng.randrange(1024))
            try:
                result = eg.client_hello_sni(data)
                self.assertTrue(not result or eg.valid_hostname(result))
            except ValueError:
                pass  # No IndexError, allocation explosion or other parser exception.

    def test_structured_fuzz(self):
        rng, original = random.Random(402), hello()[5:]
        for _ in range(2000):
            value = bytearray(original)
            for _ in range(rng.randrange(1, 8)):
                value[rng.randrange(len(value))] = rng.randrange(256)
            try:
                name = eg.client_hello_sni(value)
                self.assertTrue(not name or eg.valid_hostname(name))
            except ValueError:
                pass

    def test_ech_rejected_even_with_outer_allowed_sni(self):
        hs = bytearray(hello()[5:])
        # Change an existing non-SNI extension into encrypted_client_hello.
        body = hs[4:]
        i = 34
        i += 1 + body[i]
        i += 2 + int.from_bytes(body[i:i+2], 'big')
        i += 1 + body[i]
        i += 2
        while int.from_bytes(body[i:i+2], 'big') == 0:
            i += 4 + int.from_bytes(body[i+2:i+4], 'big')
        hs[4+i:6+i] = b'\xfe\x0d'
        with self.assertRaises(ValueError):
            eg.client_hello_sni(hs)

    def test_mismatched_alias(self):
        with mock.patch.object(eg, 'PASSTHROUGH_ALIASES', {'platform.claude.com'}):
            self.assertFalse(eg.passthrough_allowed('api.anthropic.com'))
            with self.assertRaises(ValueError):
                eg.validate_passthrough()

    def test_non_passthrough_sni(self):
        self.assertFalse(eg.passthrough_allowed('example.com'))
        self.assertFalse(eg.passthrough_allowed(''))

    def test_requires_allowlist(self):
        with mock.patch.object(eg, 'EXACT', set()), mock.patch.object(eg, 'SUFFIXES', set()):
            self.assertFalse(eg.passthrough_allowed('api.anthropic.com'))
            with self.assertRaises(ValueError):
                eg.validate_passthrough()

    def test_default_policy(self):
        eg.validate_passthrough()
        self.assertTrue(eg.passthrough_allowed('api.anthropic.com'))

    def test_alias_override_is_exact_and_contains_no_secret(self):
        text = passthrough.compose_override('platform.claude.com')
        self.assertIn('aliases: !override ["platform.claude.com"]', text)
        self.assertNotIn('api.anthropic.com', text)
        self.assertNotIn('TOKEN', text)

    def test_invalid_alias_override(self):
        for value in ('', '1.1.1.1', '*.example.com', 'bad;name', '../example'):
            with self.assertRaises(ValueError):
                passthrough.compose_override(value)

    def test_redact_env_json_yaml(self):
        for text in ('CLAUDE_CODE_OAUTH_TOKEN=fixture-value',
                     '"CLAUDE_CODE_OAUTH_TOKEN": "fixture-value"',
                     'CLAUDE_CODE_OAUTH_TOKEN: fixture-value'):
            self.assertNotIn('fixture-value', redact(text))

    def test_explicit_value_redaction(self):
        self.assertNotIn('fixture-value', redact('arbitrary fixture-value', ['fixture-value']))

    def test_dns_alias_bypass_and_private_refusal(self):
        with mock.patch('upstream_dns.resolve', return_value=['1.1.1.1']), \
                mock.patch('socket.getaddrinfo', side_effect=AssertionError('must bypass Docker DNS')):
            self.assertEqual(eg.public_addresses('api.anthropic.com'), ['1.1.1.1'])
        with mock.patch('upstream_dns.resolve', return_value=['127.0.0.1']):
            with self.assertRaises(PermissionError):
                eg.public_addresses('api.anthropic.com')


class DNSTest(unittest.TestCase):
    question = b'\x03api\x09anthropic\x03com\x00\x00\x01\x00\x01'

    def response(self, flags=0x8180):
        return (struct.pack('!6H', 1234, flags, 1, 1, 0, 0) + self.question
                + b'\xc0\x0c' + struct.pack('!HHIH', 1, 1, 60, 4) + b'\x01\x01\x01\x01')

    def test_a_response(self):
        self.assertEqual(dns.parse_response(self.response(), 1234, self.question), ['1.1.1.1'])

    def test_dns_truncations_and_wrong_id(self):
        packet = self.response()
        for i in range(len(packet)):
            with self.assertRaises(ValueError):
                dns.parse_response(packet[:i], 1234, self.question)
        with self.assertRaises(ValueError):
            dns.parse_response(packet, 1235, self.question)

    def test_dns_truncated_flag_rcode_question(self):
        for flags in (0x8380, 0x8183, 0x0180):
            with self.assertRaises(ValueError):
                dns.parse_response(self.response(flags), 1234, self.question)
        with self.assertRaises(ValueError):
            dns.parse_response(self.response(), 1234, b'wrong')


class LimitsTest(unittest.IsolatedAsyncioTestCase):
    async def test_oversized_record(self):
        r = asyncio.StreamReader()
        r.feed_data(b'\x16\x03\x03\xff\xff')
        with self.assertRaises(ValueError):
            await eg.read_client_hello(r)

    async def test_passthrough_gate_refuses_before_upstream(self):
        for payload in (hello(None), hello('example.com'), b'GET / HTTP/1.1\r\n\r\n', hello()[:30]):
            reader, writer = asyncio.StreamReader(), mock.Mock()
            reader.feed_data(payload)
            reader.feed_eof()
            writer.drain = mock.AsyncMock()
            with mock.patch.object(eg.asyncio, 'open_connection', new_callable=mock.AsyncMock) as upstream:
                await eg.handle_passthrough(reader, writer)
                upstream.assert_not_awaited()
            writer.write.assert_called_with(eg.DENY_ALERT)
            writer.close.assert_called_once()

    async def test_alias_ip_mismatch_refuses_before_upstream(self):
        reader, writer = asyncio.StreamReader(), mock.Mock()
        reader.feed_data(hello())
        writer.drain = mock.AsyncMock()
        writer.get_extra_info.return_value = ('10.251.0.3', 443)
        loop = asyncio.get_running_loop()
        with mock.patch.object(loop, 'getaddrinfo', new_callable=mock.AsyncMock,
                               return_value=[(2, 1, 6, '', ('1.1.1.1', 443))]), \
                mock.patch.object(eg.asyncio, 'open_connection', new_callable=mock.AsyncMock) as upstream:
            await eg.handle_passthrough(reader, writer)
            upstream.assert_not_awaited()
        writer.write.assert_called_with(eg.DENY_ALERT)

    async def test_connection_cap_does_not_queue(self):
        writer, handler = mock.Mock(), mock.AsyncMock()
        with mock.patch.object(eg, 'ACTIVE_CONNECTIONS', eg.MAX_CONNECTIONS):
            await eg.bounded(handler, None, writer)
        writer.close.assert_called_once()
        handler.assert_not_awaited()

    async def test_connection_count_released_on_error(self):
        writer = mock.Mock()
        with mock.patch.object(eg, 'ACTIVE_CONNECTIONS', 0):
            with self.assertRaises(ValueError):
                await eg.bounded(mock.AsyncMock(side_effect=ValueError), None, writer)
            self.assertEqual(eg.ACTIVE_CONNECTIONS, 0)

    async def test_idle_timeout_closes_pipe(self):
        writer = mock.Mock()
        with mock.patch.object(eg, 'IDLE_TIMEOUT', 0.01):
            await eg.pipe(asyncio.StreamReader(), writer)
        writer.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
