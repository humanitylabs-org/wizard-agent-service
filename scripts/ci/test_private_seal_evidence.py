"""Regressions for the round-10 false success of the synthetic sealed-runtime rehearsal.

Synthetic values only. Run: python3 -m unittest discover -s scripts/ci -p 'test_*.py'
"""
import base64
import copy
import hashlib
import io
import json
import socket
import struct
import sys
import tarfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import private_seal_evidence as ev  # noqa: E402

KEY = 'SYNTHETIC-TINFOIL-KEY-TEST-' + 'a' * 32
MARKER = 'SYNTHETIC-MARKER-TEST-' + 'b' * 32
PH = 'wizard-sealed-provider-key-held-by-injector'
NEEDLES = {'marker': MARKER, 'key': KEY, 'placeholder': PH}
NETS = {'seal': '10.246.93.0/28', 'provider': '10.247.93.0/28', 'keyed': '10.248.93.0/28',
        'agent_ip': '10.246.93.2', 'injector_ip': '10.246.93.3'}
HOSTS = ('atc.tinfoil.sh', 'github-proxy.tinfoil.sh', 'tuf-repo-cdn.sigstore.dev', 'kds-proxy.tinfoil.sh',
         'inference.tinfoil.sh', 'websearch.tinfoil.sh')


def passing_receipt():
    return {'phase': 'complete', 'synthetic_only': True, 'live_touched': False, 'real_provider_key_used': False,
            'leftover_containers': 0,
            'six_privacy_checks': {'a_relay_ehbp_capture': {'status': 'passed'}, 'd_provider_key_location': {'status': 'passed'},
                                   'e_stopped_provider_fail_closed': {'status': 'passed_transport'},
                                   'f_provider_logs_data_codeword_scan': {'status': 'passed'}},
            'checks': {k: True for k in ev.REQUIRED_CHECKS}}


class ExitSemantics(unittest.TestCase):
    def test_round10_forum_receipt_is_not_success(self):
        """The real (scrubbed) round-10 receipt exited 0 although four required items failed."""
        receipt = json.loads((HERE / 'fixtures/round10-forum-receipt.json').read_text())
        self.assertEqual(receipt['phase'], 'complete')
        unmet = ev.required_unmet(receipt)
        for item in ('six:a_relay_ehbp_capture:failed', 'six:e_stopped_provider_fail_closed:failed',
                     'six:f_provider_logs_data_codeword_scan:failed', 'check:runtipi_lifecycle_passed:False'):
            self.assertIn(item, unmet)
        self.assertNotIn('six:d_provider_key_location:passed', ' '.join(unmet))
        self.assertEqual(ev.exit_code(receipt), ev.EXIT_UNMET)

    def test_full_pass_is_zero(self):
        self.assertEqual(ev.required_unmet(passing_receipt()), [])
        self.assertEqual(ev.exit_code(passing_receipt()), 0)

    def test_missing_unknown_or_partial_is_nonzero(self):
        for mutate in (lambda r: r['checks'].pop('runtipi_lifecycle_passed'),
                       lambda r: r['six_privacy_checks'].pop('a_relay_ehbp_capture'),
                       lambda r: r['six_privacy_checks']['e_stopped_provider_fail_closed'].update(status='partial'),
                       lambda r: r['checks'].update(both_attested_via_injector='yes'),
                       lambda r: r.pop('leftover_containers'),
                       lambda r: r.update(leftover_containers=1),
                       lambda r: r.update(live_touched=True)):
            receipt = passing_receipt(); mutate(receipt)
            self.assertTrue(ev.required_unmet(receipt)); self.assertEqual(ev.exit_code(receipt), ev.EXIT_UNMET)

    def test_incomplete_run_is_error(self):
        receipt = passing_receipt(); receipt['phase'] = 'a_capture'
        self.assertEqual(ev.exit_code(receipt), ev.EXIT_ERROR)


# ------------------------------------------------------------------ capture

def record(ctype, payload, version=b'\x03\x03'):
    return bytes([ctype]) + version + len(payload).to_bytes(2, 'big') + payload


def client_hello(sni):
    name = sni.encode()
    ext_sni = (0).to_bytes(2, 'big') + (len(name) + 5).to_bytes(2, 'big') + (len(name) + 3).to_bytes(2, 'big') + b'\x00' + \
        len(name).to_bytes(2, 'big') + name
    exts = b'\x00\x2b\x00\x03\x02\x03\x04' + ext_sni   # SNI deliberately not first (Go shuffles extensions)
    body = b'\x03\x03' + b'r' * 32 + b'\x00' + b'\x00\x02\x13\x01' + b'\x01\x00' + len(exts).to_bytes(2, 'big') + exts
    hs = b'\x01' + len(body).to_bytes(3, 'big') + body
    return record(22, hs, b'\x03\x01')


def seg(data, seq=1000):
    return [[seq, base64.b64encode(data).decode()]]


def split(data, at, seq=1000):
    """Two TCP segments plus a retransmission of the first."""
    return [[seq, base64.b64encode(data[:at]).decode()], [seq + at, base64.b64encode(data[at:]).decode()],
            [seq, base64.b64encode(data[:at]).decode()]]


def keyed_flow(port=3301, body=MARKER):
    req = ('POST /v1/chat/completions HTTP/1.1\r\nhost: agent-synthetic-tinfoil:%d\r\nAuthorization: Bearer %s\r\n'
           'Content-Length: %d\r\n\r\n%s' % (port, KEY, len(body), body)).encode()
    return {'iface': 'eth1', 'src': '10.248.93.3', 'sport': 40000 + port, 'dst': '10.248.93.2', 'dport': port,
            'c2s': seg(req), 's2c': seg(b'HTTP/1.1 401 Unauthorized\r\n\r\n')}


def provider_flow(host, sport, app=b'\x99' * 64):
    c2s = b'CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\n\r\n' % (host.encode(), host.encode()) + client_hello(host) + record(23, app)
    s2c = b'HTTP/1.1 200 Connection Established\r\n\r\n' + record(22, b'\x02' + b'\0' * 40) + record(23, b'\x55' * 80)
    return {'iface': 'eth0', 'src': '10.247.93.2', 'sport': sport, 'dst': '10.247.93.3', 'dport': 3128,
            'c2s': split(c2s, 70), 's2c': seg(s2c, 5000)}


def good_flows():
    return [keyed_flow(3301), keyed_flow(3302, body='{"jsonrpc":"2.0"}'),
            provider_flow('inference.tinfoil.sh', 41000), provider_flow('websearch.tinfoil.sh', 41001)]


class CaptureClassification(unittest.TestCase):
    def classify(self, flows):
        return ev.classify_capture(flows, NETS, NEEDLES, HOSTS)

    def test_keyed_plaintext_with_tls_only_provider_hop_passes(self):
        out = self.classify(good_flows())
        self.assertTrue(out['passed'], out['failures'])
        self.assertEqual(out['summary']['provider_sni'], ['inference.tinfoil.sh', 'websearch.tinfoil.sh'])
        self.assertTrue(out['summary']['keyed_key_in_authorization'])
        self.assertEqual(out['summary']['provider_needles'], [])

    def test_plaintext_on_provider_hop_fails(self):
        for needle in (MARKER, KEY, PH):
            flows = good_flows()
            flows[2]['c2s'] += seg(needle.encode(), 99999)
            out = self.classify(flows)
            self.assertFalse(out['passed'])
            self.assertTrue(any(f.startswith('plaintext_') and 'provider' in f for f in out['failures']), out['failures'])

    def test_needle_hidden_in_tls_shaped_record_still_fails(self):
        flows = good_flows(); flows[3] = provider_flow('websearch.tinfoil.sh', 41001, app=MARKER.encode())
        self.assertFalse(self.classify(flows)['passed'])

    def test_non_tls_after_connect_and_disallowed_host_fail(self):
        flows = good_flows()
        flows[2]['c2s'] = seg(b'CONNECT inference.tinfoil.sh:443 HTTP/1.1\r\n\r\nGET / HTTP/1.1\r\n\r\n')
        self.assertIn('non_tls_bytes_on_provider_hop:10.247.93.3:3128', self.classify(flows)['failures'])
        flows = good_flows(); flows.append(provider_flow('evil.example.com', 41009))
        self.assertTrue(any(f.startswith('connect_target_not_allowed') for f in self.classify(flows)['failures']))

    def test_sni_must_match_connect_target(self):
        flows = good_flows()
        c2s = b'CONNECT inference.tinfoil.sh:443 HTTP/1.1\r\n\r\n' + client_hello('atc.tinfoil.sh')
        flows[2]['c2s'] = seg(c2s)
        self.assertTrue(any(f.startswith('sni_mismatch') for f in self.classify(flows)['failures']))

    def test_merged_buckets_regression_needle_on_unknown_flow_fails(self):
        """Round 10 merged every interface into bucket '2048'; per-flow classification never does."""
        flows = good_flows()
        flows.append({'iface': 'eth9', 'src': '172.18.0.5', 'sport': 50000, 'dst': '93.184.216.34', 'dport': 80,
                      'c2s': seg(('GET /?q=%s HTTP/1.1\r\n\r\n' % MARKER).encode()), 's2c': []})
        out = self.classify(flows)
        self.assertFalse(out['passed']); self.assertTrue(any('egress' in f for f in out['failures']))

    def test_missing_handshake_truncation_or_gap_fails_closed(self):
        flows = good_flows()[:2]
        self.assertIn('provider_hop_tls_not_observed', self.classify(flows)['failures'])
        flows = good_flows(); flows[2]['truncated'] = True
        self.assertTrue(any(f.startswith('capture_truncated') for f in self.classify(flows)['failures']))
        flows = good_flows(); flows[2]['c2s'] = flows[2]['c2s'][1:2]   # first segment lost
        self.assertFalse(self.classify(flows)['passed'])

    def test_placeholder_on_keyed_hop_fails(self):
        flows = good_flows(); flows[0]['c2s'] += seg(PH.encode(), 77777)
        self.assertIn('keyed_hop_carried_placeholder:10.248.93.2:3301', self.classify(flows)['failures'])

    def test_sniffer_keys_flows_by_interface_name_not_ethertype(self):
        ns = {'__name__': 'sniff'}
        exec(ev.SNIFF, ns)   # noqa: S102 - our own constant, exercised with a synthetic frame

        def frame(src, dst, sp, dp, seq, flags, payload):
            tcp = struct.pack('!HHIIBBHHH', sp, dp, seq, 0, 5 << 4, flags, 1024, 0, 0) + payload
            ip = struct.pack('!BBHHHBBH4s4s', 0x45, 0, 20 + len(tcp), 0, 0, 64, 6, 0, socket.inet_aton(src), socket.inet_aton(dst))
            return b'\0' * 12 + b'\x08\x00' + ip + tcp
        flows = {}
        ns['process'](frame('10.248.93.3', '10.248.93.2', 40001, 3301, 7, 0x18, b'POST / HTTP/1.1\r\n\r\n'),
                      ('eth1', 0x0800, 0, 1, b''), flows)
        ns['process'](frame('10.247.93.2', '10.247.93.3', 41000, 3128, 9, 0x18, b'\x17\x03\x03\x00\x01x'),
                      ('eth0', 0x0800, 0, 1, b''), flows)
        ns['process'](frame('127.0.0.1', '127.0.0.1', 1, 2, 1, 0x18, b'loop'), ('lo', 0x0800, 4, 772, b''), flows)
        dumped = ns['dump'](flows)
        self.assertEqual(sorted(f['iface'] for f in dumped), ['eth0', 'eth1'])
        self.assertNotIn('2048', json.dumps(dumped))
        keyed = [f for f in dumped if f['iface'] == 'eth1'][0]
        self.assertEqual((keyed['src'], keyed['dport']), ('10.248.93.3', 3301))

    def test_merge_flows_dedupes_two_namespaces(self):
        a = provider_flow('inference.tinfoil.sh', 41000)
        b = copy.deepcopy(a); b['iface'] = 'eth2'
        merged = ev.merge_flows([a], [b])
        self.assertEqual(len(merged), 1); self.assertEqual(merged[0]['iface'], 'eth0,eth2')
        self.assertTrue(self.classify(merged + good_flows()[:2] + [provider_flow('websearch.tinfoil.sh', 41001)])['passed'])


# --------------------------------------------------------------------- scan

def tar_of(entries):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as tar:
        for name, data in entries:
            if data is None:
                info = tarfile.TarInfo(name); info.type = tarfile.DIRTYPE; tar.addfile(info)
            else:
                info = tarfile.TarInfo(name); info.size = len(data); tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


KEYSRC = '/srv/work/x/service/tinfoil.key'
EXPECTED = {'container': 'p-agent-synthetic-key-1', 'destination': '/run/provider-key/key', 'source': KEYSRC}
GOOD_MOUNT = {'Type': 'bind', 'Source': KEYSRC, 'Destination': '/run/provider-key/key', 'RW': False}
KEY_SHA = hashlib.sha256((KEY + '\n').encode()).hexdigest()


class DataScan(unittest.TestCase):
    def test_round10_hits_are_the_exact_expected_mount_only(self):
        """docker diff /run, /run/provider-key, /run/provider-key/key: tolerated member by member, nothing broader."""
        excluded = {'/run/provider-key/key'}
        for path, entries in (('/run', [('run', None), ('run/provider-key', None), ('run/provider-key/key', (KEY + '\n').encode())]),
                              ('/run/provider-key', [('provider-key', None), ('provider-key/key', (KEY + '\n').encode())]),
                              ('/run/provider-key/key', [('key', (KEY + '\n').encode())])):
            res = ev.scan_changed_path(path, tar_of(entries), NEEDLES, excluded, KEY_SHA)
            self.assertEqual(res['hits'], [], path); self.assertEqual(res['excluded_seen'], ['/run/provider-key/key'])

    def test_extra_copy_beside_expected_mount_is_a_hit(self):
        entries = [('run', None), ('run/provider-key/key', (KEY + '\n').encode()), ('run/provider-key/key.bak', KEY.encode()),
                   ('run/cache.log', ('x' + MARKER).encode())]
        res = ev.scan_changed_path('/run', tar_of(entries), NEEDLES, {'/run/provider-key/key'}, KEY_SHA)
        self.assertEqual(sorted(res['hits']), ['/run/cache.log', '/run/provider-key/key.bak'])

    def test_mount_content_mismatch_and_no_exclusion_elsewhere(self):
        res = ev.scan_changed_path('/run/provider-key/key', tar_of([('key', b'other-key\n')]), NEEDLES,
                                   {'/run/provider-key/key'}, KEY_SHA)
        self.assertEqual(res['hits'], ['/run/provider-key/key:key_mount_content_mismatch'])
        res = ev.scan_changed_path('/run', tar_of([('run/provider-key/key', KEY.encode())]), NEEDLES, set(), KEY_SHA)
        self.assertEqual(res['hits'], ['/run/provider-key/key'])

    def test_only_exact_readonly_bind_in_injector_is_expected(self):
        self.assertTrue(ev.expected_key_mount('p-agent-synthetic-key-1', [GOOD_MOUNT], EXPECTED))
        for container, mount in (('p-agent-synthetic-1', GOOD_MOUNT), ('p-agent-synthetic-key-1', {**GOOD_MOUNT, 'RW': True}),
                                 ('p-agent-synthetic-key-1', {**GOOD_MOUNT, 'Destination': '/tmp/key'}),
                                 ('p-agent-synthetic-key-1', {**GOOD_MOUNT, 'Type': 'volume'})):
            self.assertIsNone(ev.expected_key_mount(container, [mount], EXPECTED))
        found, unexpected = ev.key_mount_findings({'p-agent-synthetic-key-1': [GOOD_MOUNT],
                                                   'p-agent-synthetic-1': [{**GOOD_MOUNT, 'Destination': '/opt/data/k'}]}, EXPECTED)
        self.assertEqual(found, ['p-agent-synthetic-key-1:/run/provider-key/key']); self.assertEqual(len(unexpected), 1)

    def test_unreadable_tar_with_needle_is_a_hit(self):
        res = ev.scan_changed_path('/x', b'garbage' + KEY.encode(), NEEDLES)
        self.assertTrue(res['unreadable']); self.assertEqual(res['hits'], ['/x'])


class StoppedProvider(unittest.TestCase):
    def call(self, status=502, error='provider_unavailable', ms=40):
        return {'status': status, 'error': error, 'ms': ms}

    def test_round10_values_fail(self):
        stopped = {'inference_while_stopped': self.call(ms=10017), 'search_while_stopped': self.call(ms=3084),
                   'edge_connect_from_agent': 'refused:ConnectionRefusedError'}
        restored = {'inference_after_restore': self.call(ms=8)}
        problems = ev.stopped_provider_verdict(stopped, restored, 5000)
        self.assertIn('inference_while_stopped:10017ms>=5000ms', problems)
        self.assertIn('restore_not_ready', problems)
        self.assertIn('inference_after_restore:not_reaching_provider:502', problems)

    def test_bounded_and_restored_passes(self):
        stopped = {'inference_while_stopped': self.call(ms=2004), 'search_while_stopped': self.call(ms=11)}
        restored = {'ready': True, 'readiness': {'ms': 30000}, 'inference_after_restore': self.call(401, 'dict', 600),
                    'search_after_restore': self.call(401, 'dict', 500)}
        self.assertEqual(ev.stopped_provider_verdict(stopped, restored, 5000), [])

    def test_no_calls_is_not_a_pass(self):
        self.assertTrue(ev.stopped_provider_verdict({}, {'ready': True}, 5000))


if __name__ == '__main__':
    unittest.main()
