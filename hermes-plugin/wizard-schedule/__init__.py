"""Wizard scheduler tools: reminders and deferred work land back in the thread that asked.

Supported Hermes plugin (no core changes). Calls the Agent Service loopback route
/wizard/internal/schedules/* with the same loopback token as wizard-heavy; the thread is the
calling session, injected by Hermes, never chosen by the model.
"""
import json
import re
import urllib.error
import urllib.parse
import urllib.request

from agent.secret_scope import get_secret

ISO = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _endpoint():
    origin = (get_secret('WIZARD_HEAVY_ORIGIN') or '').rstrip('/')
    parsed = urllib.parse.urlparse(origin)
    if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1')
            or parsed.username is not None or parsed.password is not None
            or parsed.path or parsed.query or parsed.fragment):
        return None, None
    return origin, get_secret('WIZARD_HEAVY_TOKEN')


def configured():
    try:
        origin, token = _endpoint()
        return bool(origin and token)
    except Exception:
        return False


def when_value(when):
    """'morning' | 'overnight' | ISO-with-offset | 'cron: m h dom mon dow' | 'every: N' (minutes)."""
    w = str(when or '').strip()
    if w.lower() in ('morning', 'tomorrow', 'tomorrow morning', 'wake'):
        return {'at': 'morning'}
    if w.lower() in ('overnight', 'tonight', 'night'):
        return {'at': 'overnight'}
    if ISO.match(w):
        return {'once': w}
    if w.lower().startswith('cron:'):
        return {'cron': w[5:].strip()}
    if w.lower().startswith('every:'):
        try:
            return {'every': int(w[6:].strip())}
        except ValueError:
            return None
    return None


def call(action, value, session_id):
    try:
        origin, token = _endpoint()
        if not origin or not token:
            return json.dumps({'error': 'Wizard scheduler is not configured for this profile'})
        if not session_id:
            return json.dumps({'error': 'a Wizard thread (stateful session) is required'})
        request = urllib.request.Request(origin + '/wizard/internal/schedules/' + action,
            data=json.dumps({**value, 'session_id': session_id}).encode(), method='POST',
            headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect).open(request, timeout=15) as response:
            return response.read(131072).decode()
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read(4096).decode()).get('error', '')
        except Exception:
            detail = ''
        return json.dumps({'error': detail or 'schedule request refused', 'status': error.code})
    except Exception:
        return json.dumps({'error': 'Wizard scheduler unavailable; retry once, then tell the owner'})


def schedule(args, session_id=None, **kwargs):
    when = when_value(args.get('when'))
    if when is None:
        return json.dumps({'error': "when must be 'morning', 'overnight', an ISO time with offset, 'cron: <5 fields>' or 'every: <minutes>'"})
    value = {'name': args.get('name'), 'when': when, 'kind': args.get('kind', 'run'), 'text': args.get('text')}
    return call('create', value, session_id)


def schedule_list(args, session_id=None, **kwargs):
    return call('list', {'all': bool(args.get('all')), 'include_done': bool(args.get('include_done'))}, session_id)


def schedule_cancel(args, session_id=None, **kwargs):
    return call('cancel', {'schedule_id': args.get('schedule_id'), 'any_thread': bool(args.get('any_thread'))}, session_id)


GUIDE = (
    'Reminders and deferred work: use wizard_schedule, not the cronjob tool. It posts back into THIS '
    'thread at the time. "Remind me tomorrow" -> kind=remind, when=morning (08:30 owner time). '
    '"Run this overnight" -> kind=run, when=overnight (03:30-03:50, trickled with other overnight work). '
    'Exact times use an ISO timestamp with offset. Put everything the future run needs in text (it runs '
    'in this thread with its history). Name it "Project · Thing". Confirm the returned nextRun to the '
    'owner. wizard_schedule_list shows what this thread (or all=true, every thread) has pending; '
    'wizard_schedule_cancel removes one. Use cronjob only for recurring script/system jobs.'
)


def register(ctx):
    if hasattr(ctx, 'register_system_prompt_section'):
        ctx.register_system_prompt_section('wizard-schedule.usage', lambda _session: GUIDE if configured() else '',
                                           position='after_memory', max_chars=1200)
    specs = [
        ('wizard_schedule', schedule,
         'Schedule a reminder or deferred agent work back into this Wizard thread. kind "remind" = a short '
         'reminder turn; kind "run" = do the described work then. when: "morning" (next 08:30 owner time), '
         '"overnight" (next ~03:30, trickled), an ISO time with offset, "cron: m h dom mon dow" or "every: N" minutes.',
         {'name': {'type': 'string', 'description': 'Short label, "Project · Thing"'},
          'when': {'type': 'string'},
          'kind': {'type': 'string', 'enum': ['remind', 'run']},
          'text': {'type': 'string', 'description': 'Reminder text, or the full self-contained task for the future run'}},
         ['name', 'when', 'kind', 'text']),
        ('wizard_schedule_list', schedule_list,
         'List pending schedules for this thread (all=true: every thread). include_done adds finished ones.',
         {'all': {'type': 'boolean'}, 'include_done': {'type': 'boolean'}}, []),
        ('wizard_schedule_cancel', schedule_cancel,
         'Cancel one schedule by id. Schedules from another thread need any_thread=true.',
         {'schedule_id': {'type': 'string'}, 'any_thread': {'type': 'boolean'}}, ['schedule_id']),
    ]
    for name, handler, description, properties, required in specs:
        ctx.register_tool(name=name, toolset='wizard-schedule', handler=handler,
            schema={'name': name, 'description': description,
                    'parameters': {'type': 'object', 'properties': properties,
                                   'required': required, 'additionalProperties': False}})
