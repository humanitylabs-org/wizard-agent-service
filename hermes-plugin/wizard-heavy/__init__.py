"""Supported Hermes plugin: no monkey patching, no credentials in model args."""
import json
from agent.secret_scope import get_secret
import urllib.request
import urllib.error
import urllib.parse


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def call(action, args, session_id=None, **kwargs):
    try:
        origin = (get_secret('WIZARD_HEAVY_ORIGIN') or '').rstrip('/')
        parsed = urllib.parse.urlparse(origin)
        if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1'):
            return json.dumps({'error': 'heavy endpoint must be loopback'})
        token = get_secret('WIZARD_HEAVY_TOKEN')
        if not token:
            return json.dumps({'error': 'heavy service is not configured for this profile'})
        if not session_id:
            return json.dumps({'error': 'a stateful originating session is required'})
        value = {**args, 'session_id': session_id}
        if action == 'submit':
            value = {'session_id': session_id, 'key': args['key'], 'spec': {
                'cwd': args['cwd'], 'argv': args['argv'],
                'timeout_seconds': args.get('timeout_seconds', 3600)}}
        request = urllib.request.Request(origin + '/wizard/internal/heavy/' + action,
            data=json.dumps(value).encode(), method='POST', headers={
                'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
        # A slow/offline remote worker never extends this request: submission is local.
        with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
            return response.read(131072).decode()
    except urllib.error.HTTPError as error:
        return json.dumps({'error': 'heavy admission refused', 'status': error.code})
    except Exception:
        return json.dumps({'error': 'heavy service unavailable; keep the same key when retrying'})


def submit(args, **kwargs):
    return call('submit', args, **kwargs)


def status(args, **kwargs):
    return call('status', args, **kwargs)


def cancel(args, **kwargs):
    return call('cancel', args, **kwargs)


def configured():
    # Evaluated inside each turn's scope, not when the gateway imports the plugin.
    # A scoped miss must never fall back to another profile's process environment.
    try:
        origin = urllib.parse.urlparse(get_secret('WIZARD_HEAVY_ORIGIN') or '')
        return (origin.scheme == 'http' and origin.hostname in ('127.0.0.1', 'localhost', '::1')
                and bool(get_secret('WIZARD_HEAVY_TOKEN')))
    except Exception:
        return False


def register(ctx):
    if hasattr(ctx, 'register_system_prompt_section'):
        ctx.register_system_prompt_section('wizard-heavy.execution', lambda _session:
            'For authorized sustained builds/tests, stage source on Thales and use wizard_heavy_submit. '
            'Do not hold a terminal or model turn open waiting for the shared worker. For Android, use '
            'android-build-thales --prepare-only, then submit its returned argv/cwd. A durable receipt '
            'is an authorized turn boundary: acknowledge the job and finish this turn, even though the '
            'overall task is unfinished. The service resumes this same thread on completion. Never '
            'start duplicate work or poll in a loop. Use wizard_heavy_cancel for cancellation.'
            if configured() else '', position='after_memory', max_chars=1200)
    specs = [
        ('wizard_heavy_submit', submit,
         'Submit authorized sustained tests/builds to the durable Thales resource queue. '
         'Returns promptly even while another job is running. Source/work directory must already be on '
         '/Volumes/ThalesMedia; stage source first. The command runs under the shared build lock. '
         'Use a stable key per intended job; retry with the same key, never generate another to poll. '
         'No credentials in command arguments. No background/detached children. After receipt, finish '
         'this turn; do not sleep or poll. The service will resume this originating thread with evidence. '
         'For an android-build-thales prepared job, use its worker.py --worker job.json command and '
         'the inherited lock mode documented in the resource-lanes runbook.',
         {'key': {'type': 'string'}, 'cwd': {'type': 'string'},
          'argv': {'type': 'array', 'items': {'type': 'string'}},
          'timeout_seconds': {'type': 'integer', 'minimum': 1, 'maximum': 86400}},
         ['key', 'cwd', 'argv']),
        ('wizard_heavy_status', status, 'Read one durable heavy job receipt. Do not poll in a loop.',
         {'job_id': {'type': 'string'}}, ['job_id']),
        ('wizard_heavy_cancel', cancel,
         'Request cancellation of a heavy job in this thread. Returns promptly; offline cancellation '
         'remains pending until the worker acknowledges it. Suppresses its automatic continuation.',
         {'job_id': {'type': 'string'}}, ['job_id']),
    ]
    for name, handler, description, properties, required in specs:
        ctx.register_tool(name=name, toolset='wizard-heavy', handler=handler,
            schema={'name': name, 'description': description,
                    'parameters': {'type': 'object', 'properties': properties,
                                   'required': required, 'additionalProperties': False}})
