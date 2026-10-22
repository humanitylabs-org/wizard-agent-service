"""Names-only credential inventory and explicit, structured import grants.

This is disposition review, not a guarantee that arbitrary user text contains no
secret. Unknown credential-shaped files are whole-file grants, default denied.
"""
import io
import json
import re
from pathlib import PurePosixPath
from dotenv import dotenv_values

CREDENTIAL_PATH = re.compile(r'(^|[/_.-])(auth|oauth|credentials?|secrets?|tokens?|id_rsa|id_ed25519|hosts\.yml|.*\.pem|.*\.key)([/_.-]|$)', re.I)
FORBIDDEN_ENV = re.compile(r'^(WIZARD_|COMPANY_|DOCKER_|BWS_|BW_|OP_|SSH_AUTH_SOCK$|HOME$|HERMES_HOME$|API_SERVER_|TERMINAL_|HERMES_GATEWAY_|HERMES_PROFILE)')
PLATFORM = re.compile(r'^(TELEGRAM|DISCORD|SLACK|WHATSAPP|SIGNAL|MATRIX|EMAIL|SMS|FEISHU|DINGTALK|WECHAT|WEIXIN|NTFY|TEAMS|LINE|SIMPLEX|BLUEBUBBLES|PHOTON|WEBHOOK|MATTERMOST|GOOGLE_CHAT)_')


def dotenv(text):
    return dict(dotenv_values(stream=io.StringIO(text), interpolate=False))


def inventory(entries, read):
    result = []
    for path in sorted(entries):
        name = PurePosixPath(path).name
        if name == '.env' or name.startswith('.env.'):
            for key in sorted(dotenv(read(path))):
                result.append({'path': path, 'kind': 'env', 'item': key, 'approved': False})
        elif name == 'auth.json':
            value = json.loads(read(path))
            # Provider and pool are independently selected: provider identifiers
            # are names, never token/account values or arbitrary JSON paths.
            for section in ('providers', 'credentials'):
                mapping = value.get(section, {})
                if isinstance(mapping, dict):
                    for provider in sorted(mapping):
                        result.append({'path': path, 'kind': 'auth-provider', 'item': section + ':' + provider, 'approved': False})
            result.append({'path': path, 'kind': 'auth-envelope', 'item': '', 'approved': False})
        elif CREDENTIAL_PATH.search(path) or '/.ssh/' in '/' + path or path.startswith('credentials/'):
            result.append({'path': path, 'kind': 'file', 'item': '', 'approved': False})
    return result


def selected(plan, path, kind, item=''):
    return any(c.get('path') == path and c.get('kind') == kind and c.get('item', '') == item
               and c.get('approved') is True for c in plan.get('credentials', []))


def filtered_env(text, plan, path='.env'):
    # Parse multiline values as one unit. No assignment-line stripping/tail leak.
    values = dotenv(text)
    return '\n'.join(key + '=' + json.dumps(value) for key, value in values.items()
                     if value is not None and selected(plan, path, 'env', key)
                     and not FORBIDDEN_ENV.match(key)
                     and not (plan['mode'] == 'paused' and PLATFORM.match(key))) + '\n'


def filtered_auth(text, plan, path='auth.json'):
    value = json.loads(text)
    out = {}
    # Only harmless schema metadata and specifically approved provider sections.
    if type(value.get('version')) is int:
        out['version'] = value['version']
    for section in ('providers', 'credentials'):
        mapping = value.get(section, {})
        if isinstance(mapping, dict):
            out[section] = {k: v for k, v in mapping.items()
                            if selected(plan, path, 'auth-provider', section + ':' + k)}
    return json.dumps(out, indent=2) + '\n'
