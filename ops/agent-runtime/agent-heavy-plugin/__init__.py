"""Agent-only adapter to the existing heavy relay. No host/worker credential."""
import json
import urllib.request
import urllib.error
from agent.secret_scope import get_secret


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def call(action, args, session_id=None, **kwargs):
    if not session_id:
        return json.dumps({'error': 'a stateful originating session is required'})
    if action not in {'submit', 'status', 'cancel'}:
        return json.dumps({'error': 'invalid action'})
    token = get_secret('WIZARD_MCP_TOKEN')
    if not token:
        return json.dumps({'error': 'agent gateway is not configured'})
    value = {'session_id': session_id, **args}
    # Never accept session or agent identity from model args.
    value.pop('agent_id', None)
    value['session_id'] = session_id
    if action == 'submit':
        value = {'session_id': session_id, 'key': args['key'], 'spec': {
            'cwd': args['cwd'], 'argv': args['argv'],
            'timeout_seconds': args.get('timeout_seconds', 900), 'lane': args.get('lane', 'light')}}
    req = urllib.request.Request('http://edge:8923/wizard/v1/agent-heavy/' + action,
        data=json.dumps(value).encode(), method='POST',
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(req, timeout=15) as r:
            return r.read(131072).decode()
    except urllib.error.HTTPError as e:
        return json.dumps({'error': 'agent heavy admission refused', 'status': e.code})
    except OSError:
        return json.dumps({'error': 'agent heavy unavailable; keep the same key when retrying'})


def register(ctx):
    fields = {'key': {'type': 'string'}, 'cwd': {'type': 'string'},
              'argv': {'type': 'array', 'items': {'type': 'string'}},
              'timeout_seconds': {'type': 'integer', 'minimum': 1, 'maximum': 86400},
              'lane': {'type': 'string', 'enum': ['heavy', 'light']}}
    for action in ['submit', 'status', 'cancel']:
        name = 'wizard_heavy_' + action
        props = fields if action == 'submit' else {'job_id': {'type': 'string'}}
        required = ['key', 'cwd', 'argv'] if action == 'submit' else ['job_id']
        ctx.register_tool(name=name, toolset='wizard-agent-heavy',
            handler=lambda args, _action=action, **kw: call(_action, args, **kw),
            schema={'name': name, 'description': 'Agent-bound heavy relay. Submit only authorized work under your assigned worker staging root. After submission end this turn; the Service resumes it on completion. Never poll or repeat the job. No SSH/host-heavy credentials.',
                    'parameters': {'type': 'object', 'properties': props, 'required': required, 'additionalProperties': False}})
