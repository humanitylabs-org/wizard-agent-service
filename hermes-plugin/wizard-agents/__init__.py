"""Read-only cross-agent reads for the main agent.

Supported Hermes plugin (no core changes). Calls the Agent Service loopback route
/wizard/internal/agents/* with the same loopback token as wizard-heavy. The service applies the
live sharing seals (private and siloed agents refuse); nothing here can write another agent's state.
"""
import json
import re
import urllib.error
import urllib.parse
import urllib.request

from agent.secret_scope import get_secret


# 64 KiB raw content can expand up to 6x when JSON-escaped twice; bound with headroom.
MAX_RESPONSE = 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# The `wizard` MCP URL: http://wizard-agent-service:8787/wizard/mcp (fresh box) or http://127.0.0.1:<port>/wizard/mcp
_GATEWAY = re.compile(r'(https?://[A-Za-z0-9.\-]+(?::\d{1,5})?|http://\[::1\](?::\d{1,5})?)/wizard/mcp/?')


def _gateway():
    """This Hermes's own `wizard` MCP entry: (Service origin, gateway key), or (None, None).

    No standard install sets the heavy-lane pair (issue 577), but every linked main Hermes has this entry
    (WAM agent_link on a fresh box, `wizard link` alongside). The key only goes to the origin Hermes already sends it to.
    """
    try:
        from hermes_cli.config import load_config_readonly

        server = ((load_config_readonly() or {}).get('mcp_servers') or {}).get('wizard') or {}
        url = server.get('url') if isinstance(server, dict) else None
    except Exception:  # noqa: BLE001 - outside Hermes, or no config yet
        url = None
    match = _GATEWAY.fullmatch(url) if isinstance(url, str) else None
    token = str(get_secret('WIZARD_MCP_TOKEN') or '').strip()
    return (match.group(1), token) if match and token else (None, None)


def _endpoint():
    """The heavy-lane loopback pair where a box has one, else this Hermes's own gateway (issue 577)."""
    origin = (get_secret('WIZARD_HEAVY_ORIGIN') or '').rstrip('/')
    parsed = urllib.parse.urlparse(origin)
    token = get_secret('WIZARD_HEAVY_TOKEN')
    if (token and parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost', '::1')
            and parsed.username is None and parsed.password is None
            and not parsed.path and not parsed.query and not parsed.fragment):
        return origin, token
    return _gateway()


def configured():
    try:
        origin, token = _endpoint()
        return bool(origin and token)
    except Exception:
        return False


def call(tool, value):
    try:
        origin, token = _endpoint()
        if not origin or not token:
            return json.dumps({'error': 'Wizard agent sharing is not configured for this profile'})
        request = urllib.request.Request(origin + '/wizard/internal/agents/' + tool,
            data=json.dumps(value).encode(), method='POST',
            headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect).open(request, timeout=15) as response:
            body = response.read(MAX_RESPONSE + 1)
            if len(body) > MAX_RESPONSE:
                return json.dumps({'error': 'agent read response too large'})
            payload = json.loads(body.decode())
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read(4096).decode())
        except Exception:
            return json.dumps({'error': 'agent read refused', 'status': error.code})
    except Exception:
        return json.dumps({'error': 'Wizard Agent Service unavailable; retry once, then tell the owner'})
    parts = payload.get('content') if isinstance(payload, dict) else None
    text = parts[0].get('text', '') if parts else json.dumps(payload)
    if payload.get('isError'):
        return json.dumps({'error': text})
    return text


def tool(name, keys):
    return lambda args, **kwargs: call(name, {k: args.get(k) for k in keys if args.get(k) is not None})


GUIDE = (
    'Other Wizard agents (e.g. Philosopher) are readable on demand with wizard_agents_* tools: '
    'read-only, source-labelled, never copied into your own memory. Use them when the owner refers '
    'to another agent\'s work or views. Private and siloed agents refuse.'
)


def register(ctx):
    if hasattr(ctx, 'register_system_prompt_section'):
        ctx.register_system_prompt_section('wizard-agents.usage', lambda _session: GUIDE if configured() else '',
                                           position='after_memory', max_chars=600)
    agent = {'agent': {'type': 'string', 'description': 'Agent id from wizard_agents_list'}}
    specs = [
        ('list', 'List the Wizard agents you may read (id, label, privacy, purpose).', {}, []),
        ('memory_read', "Read another agent's always-loaded memory, user profile and read-only persona.", agent, ['agent']),
        ('skills_list', "List another agent's skills.", agent, ['agent']),
        ('skill_read', "Read one of another agent's skills (source-labelled; adapt before relying on it).",
         {**agent, 'name': {'type': 'string'}}, ['agent', 'name']),
        ('notes_list', "List files in another agent's declared notes folder.", agent, ['agent']),
        ('notes_read', "Read a .md/.txt note in another agent's notes folder.",
         {**agent, 'path': {'type': 'string'}}, ['agent', 'path']),
    ]
    for short, description, properties, required in specs:
        name = 'wizard_agents_' + short
        ctx.register_tool(name=name, toolset='wizard-agents', handler=tool(short, list(properties)),
            schema={'name': name, 'description': '[WizardOS] ' + description,
                    'parameters': {'type': 'object', 'properties': properties,
                                   'required': required, 'additionalProperties': False}})
