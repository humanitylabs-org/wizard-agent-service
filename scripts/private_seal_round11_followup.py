"""Round11e synthetic-only phase accounting and bounded safe diagnostics."""
import hashlib
import json
import re
from collections import Counter

PHASES = ('install', 'restart', 'daemon_restart_start', 'catalog_update',
          'disabled_user_config_negative', 'rollback', 'tinfoil_image_request')


def phase_record(life, name, action, persist, diagnostic):
    """An unrelated failure must not skip a subsequent explicitly invoked phase.

    Never turn recovery stop/start into a passing restart. Persist the original
    failure before attempting any diagnostics, and keep each outcome immutable.
    """
    if name in life['phase_results']:
        raise RuntimeError('phase_already_recorded:' + name)
    try:
        value = action()
        row = {'status': 'passed' if value is True else 'failed', 'value': value}
    except Exception as exc:
        row = {'status': 'failed', 'error_class': type(exc).__name__,
               'safe_error':safe_proxy_errors(str(exc)),
               'error_sha256':hashlib.sha256(str(exc).encode()).hexdigest()}
    life['phase_results'][name] = row
    life[name] = row['status'] == 'passed'
    persist()
    try:
        diagnostic(name)
    except Exception as exc:
        life.setdefault('diagnostic_errors', {})[name] = type(exc).__name__
    persist()
    return row['status'] == 'passed'


def safe_proxy_errors(text):
    """Never return arbitrary log text, URLs, headers, tokens, or request bodies."""
    words = ('attestation', 'verification', 'certificate', 'timeout', 'deadline',
             'refused', 'no such host', 'no such file', 'permission denied',
             'network is unreachable', 'unauthorized', 'forbidden', 'error')
    lines = text[-131072:].splitlines()
    counts = Counter(word for line in lines for word in words if word in line.lower())
    namespace_errors = re.findall(r'namespace path: lstat /proc/[0-9]+/ns/net: no such file or directory',text[-131072:])
    return {'category_counts': dict(counts), 'namespace_errors':sorted(set(namespace_errors)), 'lines_examined': len(lines),
            'raw_log_retained': False}


# This executes ONLY in the generated sleeping client, never an owner agent.
# The prior fixture omitted the placeholder on GET and POST: injector 401 was
# swallowed as generic readiness timeout. HTTP status and safe exception classes
# now survive; both routes are attempted under one shared deadline.
IMAGE_PROBE = '''import json,urllib.request,urllib.error,time,hashlib,collections
v=json.loads(input()); docs={}; errors={}; headers={'Authorization':'Bearer wizard-sealed-provider-key-held-by-injector'}
end=time.monotonic()+180
while time.monotonic()<end and len(docs)<2:
 for port in (3301,3302):
  if str(port) in docs:continue
  try:
   req=urllib.request.Request('http://agent-synthetic-tinfoil:'+str(port)+'/verification-document',headers=headers)
   with urllib.request.urlopen(req,timeout=4) as h:d=json.load(h)
   if d.get('securityVerified') is True:docs[str(port)]={k:d.get(k) for k in ('securityVerified','configRepo','releaseDigest')}
   else:errors.setdefault(str(port),{} )['not_security_verified']=True
  except urllib.error.HTTPError as e:errors.setdefault(str(port),{})['http_status']=e.code
  except (OSError,ValueError) as e:errors.setdefault(str(port),{})['error_class']=type(e).__name__
 if len(docs)<2:time.sleep(2)
out={'attestation':docs,'readiness_errors':errors,'auth_key_is_generated_invalid_fixture':True,'vision_semantic_success':False,'image_content_sent':False}
if len(docs)==2:
 raw=json.dumps(v).encode(); req=urllib.request.Request('http://agent-synthetic-tinfoil:3301/v1/chat/completions',raw,{**headers,'Content-Type':'application/json'})
 try:
  try:h=urllib.request.urlopen(req,timeout=60)
  except urllib.error.HTTPError as e:h=e
  out.update(http_status=h.status,request_sha256=hashlib.sha256(raw).hexdigest(),image_content_sent=True)
  h.close()
 except OSError as e:out['request_error_class']=type(e).__name__
print(json.dumps(out))
'''
