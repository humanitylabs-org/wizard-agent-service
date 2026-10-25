"""Supervisor tools. Session identity is injected by Hermes, never exposed in tool schemas."""
import json
import os
from pathlib import Path
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from urllib.error import HTTPError
from urllib.parse import urlparse
from agent.secret_scope import get_secret


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def endpoint():
    # Main/alongside uses the already provisioned heavy loopback capability.
    origin = (get_secret('WIZARD_HEAVY_ORIGIN') or '').rstrip('/')
    token = get_secret('WIZARD_HEAVY_TOKEN')
    p = urlparse(origin)
    if token and p.scheme == 'http' and p.hostname in ('127.0.0.1', 'localhost', '::1') and not p.username and not p.password and p.path in ('', '/') and not p.query and not p.fragment:
        return origin + '/wizard/internal/supervisor/', token
    # Managed/container/restricted agents use ONLY their own existing app-gateway capability.
    token = get_secret('WIZARD_MCP_TOKEN')
    if token:
        import yaml
        home = Path(os.environ.get('HERMES_HOME') or Path.home() / '.hermes')
        cfg = yaml.safe_load((home / 'config.yaml').read_text()) or {}
        url = cfg.get('mcp_servers', {}).get('wizard', {}).get('url', '')
        p = urlparse(url)
        if p.scheme in ('http', 'https') and p.hostname and not p.username and not p.password and p.path.rstrip('/') == '/wizard/mcp' and not p.query and not p.fragment:
            p.port  # Validate malformed explicit port before sending a credential.
            return url, token
    return None, None


def call(action, args, session_id=None, **kwargs):
    if not session_id:
        return json.dumps({'error': 'An active Wizard thread is required.'})
    try:
        origin, token = endpoint()
        if not origin or not token:
            return json.dumps({'error': 'Supervisor is not configured, or this agent is privacy-sealed; nothing was shared.'})
        # Overwrite, never trust model-provided identity (not in any public schema).
        value = {**args, 'session_id': session_id}
        gateway = urlparse(origin).path.rstrip('/') == '/wizard/mcp'
        if gateway:
            value = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'supervisor_' + action, 'arguments': value}}
        req = Request(origin if gateway else origin + action, data=json.dumps(value).encode(), method='POST',
                      headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
        with build_opener(ProxyHandler({}), NoRedirect()).open(req, timeout=15) as res:
            data = res.read(131073)
            if len(data) > 131072:
                return json.dumps({'error': 'Supervisor response is too large; narrow the lessons query.'})
            raw = data.decode()
            if not gateway:
                return raw
            result = json.loads(raw).get('result', {})
            content = result.get('content') or []
            return content[0].get('text', '{}') if content else json.dumps({'error': 'Supervisor request failed.'})
    except HTTPError as error:
        try:
            message = json.loads(error.read(4096).decode()).get('error', 'Supervisor refused the request.')
        except (ValueError, OSError):
            message = 'Supervisor refused the request.'
        return json.dumps({'error': message, 'status': error.code})
    except (OSError, ValueError, TypeError):
        return json.dumps({'error': 'Supervisor unavailable; retry with the SAME client_report_id.'})


def register(ctx):
    specs = json.loads(Path(__file__).with_name('tools.json').read_text())
    for spec in specs:
        action = spec['name'].removeprefix('supervisor_')
        ctx.register_tool(name=spec['name'], toolset='wizard-supervisor-tools', schema=spec,
                          handler=lambda args, _action=action, **kw: call(_action, args, **kw))
