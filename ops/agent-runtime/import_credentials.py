"""Names-only credential inventory and explicit, structured import grants.

This is disposition review, not a guarantee that arbitrary user text contains no
secret. Unknown credential-shaped files are whole-file grants, default denied.
"""
import io
import json
import re
import yaml
from pathlib import PurePosixPath
from dotenv import dotenv_values

CREDENTIAL_PATH = re.compile(r'^(?:(?:.*[._-])?(?:auth|oauth|credentials?|secrets?|tokens?)(?:\.(?:json|ya?ml|toml|ini|env))?|id_(?:rsa|ed25519)(?:\.pub)?|hosts\.yml|.*\.(?:pem|key))$', re.I)
FORBIDDEN_ENV = re.compile(r'^(WIZARD_|COMPANY_|DOCKER_|BWS_|BW_|OP_|SSH_AUTH_SOCK$|HOME$|HERMES_HOME$|API_SERVER_|TERMINAL_|HERMES_GATEWAY_|HERMES_PROFILE)')
PLATFORM = re.compile(r'^(TELEGRAM|DISCORD|SLACK|WHATSAPP|SIGNAL|MATRIX|EMAIL|SMS|FEISHU|DINGTALK|WECHAT|WEIXIN|NTFY|TEAMS|LINE|SIMPLEX|BLUEBUBBLES|PHOTON|WEBHOOK|MATTERMOST|GOOGLE_CHAT)_')


def dotenv(text):
    return dict(dotenv_values(stream=io.StringIO(text), interpolate=False))


INLINE_SECRET = re.compile(r'(?:^|_)(api_key|access_token|refresh_token|token|secret|password|client_secret|authorization)$', re.I)


def config_items(value, prefix=()):
    if isinstance(value, dict):
        for key, child in value.items():
            path = (*prefix, str(key))
            if (INLINE_SECRET.search(str(key)) or FORBIDDEN_ENV.match(str(key))) and child not in (None, ''):
                yield '/'.join(path)
            else:
                yield from config_items(child, path)
    elif isinstance(value, list):
        for i, child in enumerate(value):
            yield from config_items(child, (*prefix, str(i)))


def filter_config(value, plan, prefix=()):
    if isinstance(value, dict):
        return {k: filter_config(v, plan, (*prefix, str(k))) for k, v in value.items()
                if not FORBIDDEN_ENV.match(str(k)) and (
                    not INLINE_SECRET.search(str(k)) or
                    selected(plan, 'config.yaml', 'config-field', '/'.join((*prefix, str(k)))))}
    if isinstance(value, list):
        return [filter_config(v, plan, (*prefix, str(i))) for i, v in enumerate(value)]
    return value


def inventory(entries, read):
    result = []
    for path in sorted(entries):
        name = PurePosixPath(path).name
        if path == 'config.yaml':
            for item in config_items(yaml.safe_load(read(path)) or {}):
                result.append({'path': path, 'kind': 'config-field', 'item': item, 'approved': False})
        elif name == '.env' or name.startswith('.env.'):
            for key in sorted(dotenv(read(path))):
                result.append({'path': path, 'kind': 'env', 'item': key, 'approved': False})
        elif name == 'auth.json':
            value = json.loads(read(path))
            # Provider and pool are independently selected: provider identifiers
            # are names, never token/account values or arbitrary JSON paths.
            for section in ('providers', 'credentials', 'credential_pool'):
                mapping = value.get(section, {})
                if isinstance(mapping, dict):
                    for provider in sorted(mapping):
                        result.append({'path': path, 'kind': 'auth-provider', 'item': section + ':' + provider, 'approved': False})
            result.append({'path': path, 'kind': 'auth-envelope', 'item': '', 'approved': False})
        elif CREDENTIAL_PATH.search(name) or any(part in {'.ssh', 'credentials', 'secrets'} for part in PurePosixPath(path).parts[:-1]):
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
    for section in ('providers', 'credentials', 'credential_pool'):
        mapping = value.get(section, {})
        if isinstance(mapping, dict):
            out[section] = {k: v for k, v in mapping.items()
                            if selected(plan, path, 'auth-provider', section + ':' + k)}
    return json.dumps(out, indent=2) + '\n'
