"""Pure verdict logic for the synthetic sealed-runtime rehearsal (round 10b).

Importable and unit-tested (scripts/ci/test_private_seal_evidence.py). Nothing
here touches Docker, the network or any live state; the forum runner feeds it
raw synthetic observations and records what it returns.

Rules carried from the round-10 false success:
* An exit status of 0 means every REQUIRED check passed. Anything unmet,
  missing or unknown is a nonzero exit, never a quiet success.
* Plaintext is never ignored. Capture bytes are classified per TCP flow and
  per hop; the only hop allowed to carry plaintext is injector -> official
  proxy on the internal keyed network (by design: the injector adds the bearer
  there). Every provider-hop and egress byte must be a CONNECT preamble to an
  allowed host followed by well-formed TLS records, with the marker, key and
  placeholder absent. Unknown flows carrying any needle fail.
* The only key location tolerated by the data scan is the exact read-only bind
  mount of the Service key file at KEY_TARGET in the injector container, with
  content equal to the Service key. Ancestor directories created for that
  mountpoint are scanned member by member, excluding only that one path.
"""
import base64
import hashlib
import io
import ipaddress
import posixpath
import tarfile

REQUIRED_SIX = {
    'a_relay_ehbp_capture': ('passed',),
    'd_provider_key_location': ('passed',),
    'e_stopped_provider_fail_closed': ('passed_transport',),
    'f_provider_logs_data_codeword_scan': ('passed',),
}
REQUIRED_CHECKS = ('both_attested_via_injector', 'other_agents_cannot_reach_seal',
                   'other_sealed_agent_cannot_reach_host_api', 'runtipi_lifecycle_passed')
INJECTOR_ERRORS = ('provider_unavailable', 'agent_must_not_hold_provider_key', 'request_refused',
                   'provider_key_unavailable')
EXIT_PASSED, EXIT_ERROR, EXIT_UNMET = 0, 1, 2


# ---------------------------------------------------------------- exit verdict

def required_unmet(receipt):
    """Every unmet, missing or unknown required item; empty only on a full pass."""
    unmet = []
    if receipt.get('phase') != 'complete':
        unmet.append('phase:%s' % receipt.get('phase'))
    six = receipt.get('six_privacy_checks') or {}
    for name, allowed in REQUIRED_SIX.items():
        status = (six.get(name) or {}).get('status')
        if status not in allowed:
            unmet.append('six:%s:%s' % (name, status or 'missing'))
    checks = receipt.get('checks') or {}
    for name in REQUIRED_CHECKS:
        if checks.get(name) is not True:
            unmet.append('check:%s:%s' % (name, checks.get(name, 'missing')))
    if receipt.get('leftover_containers') != 0:
        unmet.append('leftover_containers:%s' % receipt.get('leftover_containers', 'missing'))
    if receipt.get('synthetic_only') is not True or receipt.get('live_touched') is not False \
            or receipt.get('real_provider_key_used') is not False:
        unmet.append('scope:not_synthetic')
    return unmet


def exit_code(receipt):
    if receipt.get('phase') != 'complete':
        return EXIT_ERROR
    return EXIT_UNMET if required_unmet(receipt) else EXIT_PASSED


# ------------------------------------------------------------ capture analysis

# Runs inside a throwaway container joined to a namespace (NET_RAW only).
# AF_PACKET recvfrom() returns (ifname, proto, pkttype, hatype, addr): the
# interface NAME is addr[0]. Round 10 keyed buckets by addr[1] (the ethertype,
# 2048), merging every hop into one bucket. Output is per TCP flow.
SNIFF = r'''import base64,json,select,socket,struct,sys,time
LIMIT=16*1024*1024
def process(data,addr,flows):
  if addr[0]=='lo' or len(data)<34 or data[12:14]!=b'\x08\x00':return
  ip=data[14:];ihl=(ip[0]&15)*4
  if ip[9]!=6:return
  total=struct.unpack('!H',ip[2:4])[0];ip=ip[:total]
  src,dst=socket.inet_ntoa(ip[12:16]),socket.inet_ntoa(ip[16:20]);tcp=ip[ihl:]
  sp,dp,seq=struct.unpack('!HHI',tcp[:8]);flags=tcp[13];pay=tcp[(tcp[12]>>4)*4:]
  a,b=(src,sp),(dst,dp)
  key=tuple(sorted([a,b]))
  f=flows.get(key)
  if f is None:
    client=a if (flags&0x12)==0x02 or sp>dp else b
    server=b if client==a else a
    f=flows[key]={'iface':addr[0],'src':client[0],'sport':client[1],'dst':server[0],'dport':server[1],'c2s':{},'s2c':{},'bytes':0,'truncated':False}
  if not pay:return
  side='c2s' if (src,sp)==(f['src'],f['sport']) else 's2c'
  if seq in f[side]:return
  if f['bytes']+len(pay)>LIMIT:f['truncated']=True;return
  f[side][seq]=pay;f['bytes']+=len(pay)
def dump(flows):
  return [{'iface':f['iface'],'src':f['src'],'sport':f['sport'],'dst':f['dst'],'dport':f['dport'],'truncated':f['truncated'],
           'c2s':[[s,base64.b64encode(p).decode()] for s,p in f['c2s'].items()],
           's2c':[[s,base64.b64encode(p).decode()] for s,p in f['s2c'].items()]} for f in flows.values()]
if __name__=='__main__':
  limit=float(sys.argv[1]) if len(sys.argv)>1 else 300
  s=socket.socket(socket.AF_PACKET,socket.SOCK_RAW,socket.ntohs(3))
  flows={};print('ready',flush=True);end=time.time()+limit
  while time.time()<end:
    r=select.select([s,sys.stdin],[],[],0.5)[0]
    if sys.stdin in r and sys.stdin.readline().strip()=='stop':
      while select.select([s],[],[],0.2)[0]:
        d,ad=s.recvfrom(65535);process(d,ad,flows)
      break
    if s in r:
      d,ad=s.recvfrom(65535);process(d,ad,flows)
  print(json.dumps(dump(flows)),flush=True)
'''


def merge_flows(*captures):
    """Merge flow lists from several sniffers (same flow seen in two namespaces)."""
    merged = {}
    for capture in captures:
        for f in capture:
            key = (f['src'], f['sport'], f['dst'], f['dport'])
            if key not in merged:
                merged[key] = {**f, 'c2s': list(f['c2s']), 's2c': list(f['s2c']), 'iface': f['iface']}
            else:
                m = merged[key]
                m['c2s'] += f['c2s']; m['s2c'] += f['s2c']
                m['truncated'] = m.get('truncated') or f.get('truncated')
                m['iface'] = ','.join(sorted(set(m['iface'].split(',')) | {f['iface']}))
    return list(merged.values())

def assemble(segments):
    """[(seq, b64 payload)] -> (bytes, gaps). Dedupes retransmits, trims overlap."""
    parts = sorted(((int(s), base64.b64decode(p)) for s, p in segments), key=lambda x: x[0])
    if not parts:
        return b'', 0
    base = parts[0][0]
    out, gaps, end = bytearray(), 0, 0
    for seq, data in parts:
        off = (seq - base) % (1 << 32)
        if off > end:
            gaps += 1
            end = off   # data lost: recorded; callers fail closed on gaps
        if off + len(data) <= end:
            continue
        out.extend(data[end - off:])
        end = off + len(data)
    return bytes(out), gaps


def _preamble(stream, request):
    """Split an HTTP CONNECT request/response preamble. Returns (line, rest) or (None, stream)."""
    head, sep, rest = stream.partition(b'\r\n\r\n')
    first = head.split(b'\r\n', 1)[0]
    if sep and ((request and first.startswith(b'CONNECT ')) or (not request and first.startswith(b'HTTP/1.'))):
        return first.decode('latin-1'), rest
    return None, stream


def tls_records(stream):
    """Parse a byte stream as TLS records. -> (records [(type, len)], ok, trailing)."""
    records, i = [], 0
    while i + 5 <= len(stream):
        ctype, major, minor = stream[i], stream[i + 1], stream[i + 2]
        length = int.from_bytes(stream[i + 3:i + 5], 'big')
        if ctype not in (20, 21, 22, 23) or major != 3 or minor not in (1, 2, 3, 4) or length > 18432:
            return records, False, len(stream) - i
        if i + 5 + length > len(stream):
            break   # record cut at capture end
        records.append((ctype, length))
        i += 5 + length
    return records, True, len(stream) - i


def client_hello_sni(stream):
    """SNI of the first ClientHello in a TLS byte stream (handshake may span records)."""
    hs, i = bytearray(), 0
    while i + 5 <= len(stream) and stream[i] == 22:
        length = int.from_bytes(stream[i + 3:i + 5], 'big')
        hs.extend(stream[i + 5:i + 5 + length]); i += 5 + length
        if len(hs) >= 4 and len(hs) >= 4 + int.from_bytes(hs[1:4], 'big'):
            break
    try:
        if hs[0] != 1:
            return None
        p = 4 + 2 + 32
        p += 1 + hs[p]
        p += 2 + int.from_bytes(hs[p:p + 2], 'big')
        p += 1 + hs[p]
        end = p + 2 + int.from_bytes(hs[p:p + 2], 'big'); p += 2
        while p + 4 <= end:
            etype, elen = int.from_bytes(hs[p:p + 2], 'big'), int.from_bytes(hs[p + 2:p + 4], 'big')
            if etype == 0:
                q = p + 4 + 2
                if hs[q] == 0:
                    n = int.from_bytes(hs[q + 1:q + 3], 'big')
                    return bytes(hs[q + 3:q + 3 + n]).decode('ascii')
            p += 4 + elen
    except (IndexError, UnicodeError):
        return None
    return None


def classify_capture(flows, nets, needles, allowed_hosts):
    """Per-flow, per-hop verdict.

    flows: sniffer output, list of {iface, src, sport, dst, dport, c2s, s2c}
           with c2s/s2c = [(seq, b64)] segments (client = lower-index side
           decided by the sniffer from SYN or the server port).
    nets: {'seal','provider','keyed'} -> CIDR; plus 'agent_ip', 'injector_ip'.
    needles: {'marker','key','placeholder'} -> str.
    """
    nets_ = {k: ipaddress.ip_network(v) for k, v in nets.items() if k in ('seal', 'provider', 'keyed')}
    allowed = {h + ':443' for h in allowed_hosts}
    out: dict = {'flows': [], 'failures': []}
    for f in flows:
        c2s, gap1 = assemble(f.get('c2s', []))
        s2c, gap2 = assemble(f.get('s2c', []))
        both = c2s + b'\n' + s2c
        hits = sorted(n for n, v in needles.items() if v and v.encode() in both)
        src, dst = ipaddress.ip_address(f['src']), ipaddress.ip_address(f['dst'])
        hop = 'egress'
        for name, net in nets_.items():
            if src in net and dst in net:
                hop = name
        row = {'iface': f.get('iface'), 'hop': hop, 'server': '%s:%s' % (f['dst'], f['dport']),
               'c2s_bytes': len(c2s), 's2c_bytes': len(s2c), 'gaps': gap1 + gap2, 'needles': hits}
        if hop == 'keyed':
            row['http_request_lines'] = sum(1 for line in c2s.split(b'\r\n')
                                            if line[:5] in (b'GET /', b'POST ') or line[:8] == b'DELETE /')
            row['key_in_authorization'] = bool(needles.get('key')) and (b'Bearer ' + needles['key'].encode()) in c2s
            if 'placeholder' in hits:
                out['failures'].append('keyed_hop_carried_placeholder:%s' % row['server'])
        elif hop == 'seal' and {f['src'], f['dst']} == {nets.get('agent_ip'), nets.get('injector_ip')}:
            row['agent_to_injector'] = True   # the agent's own request; not observable from proxy/edge netns
            if 'key' in hits:
                out['failures'].append('seal_hop_carried_key:%s' % row['server'])
        else:
            if hits:
                out['failures'].append('plaintext_%s_on_%s_hop:%s' % ('+'.join(hits), hop, row['server']))
            connect, c_rest = _preamble(c2s, True)
            status, s_rest = _preamble(s2c, False)
            if connect is not None:
                target = connect.split(' ')[1] if len(connect.split(' ')) > 1 else ''
                row['connect_target'] = target
                if target not in allowed:
                    out['failures'].append('connect_target_not_allowed:%s' % target)
                if status is None or not status.split(' ')[1:2] == ['200']:
                    row['tunnel'] = 'refused'
                    if c_rest or s_rest:
                        out['failures'].append('bytes_after_refused_connect:%s' % row['server'])
                    out['flows'].append(row)
                    continue
            elif hop == 'provider' and f['dport'] != 443:
                out['failures'].append('provider_hop_without_connect:%s' % row['server'])
            cr, cok, _ = tls_records(c_rest)
            sr, sok, _ = tls_records(s_rest)
            row.update({'tls_ok': cok and sok, 'tls_app_records': sum(1 for t, _ in cr + sr if t == 23),
                        'sni': client_hello_sni(c_rest) if c_rest[:1] == b'\x16' else None})
            if not (cok and sok):
                out['failures'].append('non_tls_bytes_on_%s_hop:%s' % (hop, row['server']))
            if connect is not None and row['sni'] and row['sni'] + ':443' != row.get('connect_target'):
                out['failures'].append('sni_mismatch:%s' % row['server'])
        if f.get('truncated'):
            out['failures'].append('capture_truncated_on_%s_hop:%s' % (hop, row['server']))
        if row['gaps'] and hop != 'keyed':
            out['failures'].append('capture_gap_on_%s_hop:%s' % (hop, row['server']))
        out['flows'].append(row)
    keyed = [r for r in out['flows'] if r['hop'] == 'keyed']
    provider = [r for r in out['flows'] if r['hop'] == 'provider' and r.get('tunnel') != 'refused']
    out['summary'] = {
        'keyed_flows': len(keyed),
        'keyed_key_in_authorization': any(r.get('key_in_authorization') for r in keyed),
        'keyed_marker_seen': any('marker' in r['needles'] for r in keyed),
        'keyed_placeholder_seen': any('placeholder' in r['needles'] for r in keyed),
        'provider_flows': len(provider),
        'provider_tls_app_records': sum(r.get('tls_app_records', 0) for r in provider),
        'provider_sni': sorted({r['sni'] for r in provider if r.get('sni')}),
        'provider_needles': sorted({n for r in provider for n in r['needles']}),
        'egress_flows': sum(1 for r in out['flows'] if r['hop'] == 'egress'),
        'egress_needles': sorted({n for r in out['flows'] if r['hop'] == 'egress' for n in r['needles']}),
    }
    s = out['summary']
    if not s['keyed_flows'] or not s['keyed_key_in_authorization']:
        out['failures'].append('keyed_hop_not_observed_with_injected_key')
    if not s['keyed_marker_seen']:
        out['failures'].append('marker_not_observed_on_keyed_hop')   # proves the probe actually ran
    if not s['provider_flows'] or not s['provider_tls_app_records']:
        out['failures'].append('provider_hop_tls_not_observed')
    if not {'inference.tinfoil.sh', 'websearch.tinfoil.sh'} <= set(s['provider_sni']):
        out['failures'].append('provider_handshake_sni_not_observed')
    out['passed'] = not out['failures']
    return out


# -------------------------------------------------------------- data/log scan

def expected_key_mount(container, mounts, expected):
    """The one tolerated key location: exact container, destination, source, read-only."""
    for m in mounts:
        if (container == expected['container'] and m.get('Destination') == expected['destination']
                and m.get('Source') == expected['source'] and m.get('RW') is False and m.get('Type') == 'bind'):
            return m
    return None


def key_mount_findings(mounts_by_container, expected):
    """Any key-file mount other than the exact expected one is unexpected."""
    found, unexpected = [], []
    for container, mounts in sorted(mounts_by_container.items()):
        for m in mounts:
            if m.get('Source') == expected['source'] or m.get('Destination') == expected['destination']:
                if expected_key_mount(container, [m], expected):
                    found.append('%s:%s' % (container, m['Destination']))
                else:
                    unexpected.append('%s:%s<-%s:rw=%s' % (container, m.get('Destination'), m.get('Source'), m.get('RW')))
    return found, unexpected


def scan_changed_path(path, tar_bytes, needles, excluded=(), excluded_sha256=None):
    """Scan a `docker cp <c>:<path> -` tar member by member.

    excluded: absolute in-container paths that are the expected key mount; a
    member at exactly that path is tolerated only if its content hash matches
    excluded_sha256 (else it is reported). Every other member is scanned.
    -> {'hits': [...], 'excluded_seen': [...], 'unreadable': bool}
    """
    res = {'hits': [], 'excluded_seen': [], 'unreadable': False}
    parent = posixpath.dirname(path.rstrip('/')) or '/'
    try:
        tar = tarfile.open(fileobj=io.BytesIO(tar_bytes), mode='r:')
        members = tar.getmembers()
    except (tarfile.TarError, EOFError):
        res['unreadable'] = True
        if any(v and v.encode() in tar_bytes for v in needles.values()):
            res['hits'].append(path)
        return res
    for m in members:
        absolute = posixpath.normpath(posixpath.join(parent, m.name))
        if not m.isfile():
            continue
        handle = tar.extractfile(m)
        data = handle.read() if handle else b''
        if absolute in excluded:
            res['excluded_seen'].append(absolute)
            if excluded_sha256 is None or hashlib.sha256(data).hexdigest() != excluded_sha256:
                res['hits'].append(absolute + ':key_mount_content_mismatch')
            continue
        if any(v and v.encode() in data for v in needles.values()):
            res['hits'].append(absolute)
    return res


# ----------------------------------------------------- stopped-provider verdict

def stopped_provider_verdict(stopped, restored, bound_ms):
    """Transport fail-closed within the bound, then the restored route reaches the provider again."""
    problems = []
    for name, call in stopped.items():
        if not isinstance(call, dict):
            continue
        if call.get('status') != 502 or call.get('error') != 'provider_unavailable':
            problems.append('%s:status=%s' % (name, call.get('status')))
        elif not call.get('ms', bound_ms) < bound_ms:
            problems.append('%s:%sms>=%sms' % (name, call.get('ms'), bound_ms))
    if not [c for c in stopped.values() if isinstance(c, dict)]:
        problems.append('no_stopped_calls')
    if not restored.get('ready'):
        problems.append('restore_not_ready')
    calls = {k: v for k, v in restored.items() if k.endswith('_after_restore')}
    if not calls:
        problems.append('no_restore_calls')
    for name, call in calls.items():
        if not isinstance(call, dict) or not isinstance(call.get('status'), int) or call.get('error') in INJECTOR_ERRORS:
            problems.append('%s:not_reaching_provider:%s' % (name, call.get('status')))
    return problems
