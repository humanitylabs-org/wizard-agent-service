"""Supported Hermes plugin: no monkey patching, no credentials in model args."""
import json
import os
import urllib.request
import urllib.error
import urllib.parse


def call(action, args, session_id=None, **kwargs):
    try:
        origin = os.environ['WIZARD_HEAVY_ORIGIN'].rstrip('/')
        parsed = urllib.parse.urlparse(origin)
        if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1'):
            return json.dumps({'error': 'heavy endpoint must be loopback'})
        token = os.environ['WIZARD_HEAVY_TOKEN']
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
        with urllib.request.urlopen(request, timeout=15) as response:
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


def register(ctx):
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
