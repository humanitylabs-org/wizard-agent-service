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
            host = args.get('host', 'thales')
            if host not in ('thales', 'forum'):
                return json.dumps({'error': 'host must be thales or forum'})
            lane = args.get('lane', 'heavy')
            if lane not in ('heavy', 'light'):
                return json.dumps({'error': 'lane must be heavy or light'})
            timeout = args.get('timeout_seconds', 900 if lane == 'light' else 3600)
            spec = {'cwd': args['cwd'], 'argv': args['argv'], 'timeout_seconds': timeout}
            if host != 'thales':
                spec['host'] = host
            if lane == 'light':
                # Heavy specs stay byte-identical so existing idempotency keys still match.
                if not isinstance(timeout, int) or timeout > 900:
                    return json.dumps({'error': 'light lane jobs must finish within 900 seconds'})
                spec['lane'] = 'light'
            value = {'session_id': session_id, 'key': args['key'], 'spec': spec}
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
            'For authorized sustained builds/tests, stage source on the chosen host and use wizard_heavy_submit. '
            'Use host="forum" for Linux/amd64: scripts, acceptance rigs, Docker images, ISO/VM installs '
            'with KVM, Playwright, Android debug builds and x86_64 emulator QA. Use host="thales" '
            '(default) ONLY for macOS work, Mac VM guests, Android signed release builds and the ARM '
            'release-candidate check. Never emulate amd64 on Thales. Forum disk is scratch; preserve '
            'valuable outputs on /Volumes/ThalesMedia or R2. '
            'Do not hold a terminal or model turn open waiting for the shared worker. For Android, use '
            'android-build-thales --prepare-only, then submit its returned argv/cwd. A durable receipt '
            'is an authorized turn boundary: acknowledge the job and finish this turn, even though the '
            'overall task is unfinished. The service resumes this same thread on completion. Never '
            'start duplicate work or poll in a loop. Use wizard_heavy_cancel for cancellation. '
            'Pass lane="light" for short packaging work (Docker image packaging from prebuilt '
            'binaries, static/web app builds, canaries; 15 min max) so it does not queue behind '
            'Android, emulator or VM jobs.'
            if configured() else '', position='after_memory', max_chars=2200)
    specs = [
        ('wizard_heavy_submit', submit,
         'Submit authorized sustained tests/builds to the durable chosen-host resource queue. '
         'host=forum for Linux/amd64 scripts, acceptance rigs, Docker images, ISO/VM installs with KVM, '
         'Playwright, Android debug builds and x86_64 emulator QA. host=thales (default) only for '
         'macOS work, Mac VM guests, Android signed release builds and the ARM release-candidate check. '
         'Never emulate amd64 on Thales. Forum storage is scratch; retain outputs on /Volumes/ThalesMedia or R2. '
         'Returns promptly even while another job is running. Source/work directory must already be on '
         'the configured heavy root; stage source first. The command runs under the shared build lock. '
         'Use a stable key per intended job; retry with the same key, never generate another to poll. '
         'No credentials in command arguments. No background/detached children. After receipt, finish '
         'this turn; do not sleep or poll. The service will resume this originating thread with evidence. '
         'For an android-build-thales prepared job, use its worker.py --worker job.json command and '
         'the inherited lock mode documented in the resource-lanes runbook. '
         'lane: "heavy" (default; Android/Gradle/signing, emulators, Mac VM guests, long suites) runs '
         'under the shared Android/VM lock. "light" runs on its own packaging lock and never waits '
         'behind heavy work: Docker image packaging that reuses prebuilt binaries, static/web app '
         'builds, small canaries. Light jobs must finish within 900 seconds and cannot use the '
         'Android helper.',
         {'key': {'type': 'string'}, 'cwd': {'type': 'string'},
          'argv': {'type': 'array', 'items': {'type': 'string'}},
          'timeout_seconds': {'type': 'integer', 'minimum': 1, 'maximum': 86400},
          'lane': {'type': 'string', 'enum': ['heavy', 'light']},
          'host': {'type': 'string', 'enum': ['thales', 'forum'], 'default': 'thales'}},
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
