"""Read-only proof that this agent consumes the connection app's exact granted login.

No provider credentials, token refresh, guessed host directories, or auth-pool mutation.
"""
import json
import os
from pathlib import Path
import re

CONTRACT = 'wizard.app-owned-claude/1'
PROVIDER = 'claude-subscription-directsdk-experimental'


def claude_status(env=None, profile=None, config=None):
    env = os.environ if env is None else env
    answer = {'contract': CONTRACT, 'provider': 'claude', 'owner': 'app',
              'status': 'unavailable', 'ownerId': None, 'accountIds': [], 'in_use': False}
    root = env.get('CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR') or env.get('CLAUDE_CONFIG_DIR')
    if not root or env.get('CLAUDE_CODE_OAUTH_TOKEN'):
        return answer
    if profile is None:
        from providers import get_provider_profile
        profile = get_provider_profile(PROVIDER)
    if getattr(profile, 'app_owned_login_contract', None) != CONTRACT:
        return answer
    if config is None:
        from hermes_cli.config import load_config_readonly
        config = load_config_readonly() or {}
    root = Path(root).resolve()
    try:
        owner = json.loads((root/'owner.json').read_text()).get('id')
        rows = json.loads((root/'accounts.json').read_text())
        if not isinstance(owner, str) or not re.fullmatch(r'[a-f0-9]{32}', owner) or not isinstance(rows, list):
            return answer
        ids = []
        for row in rows:
            ident = row.get('id') if isinstance(row, dict) else None
            if not isinstance(ident, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', ident) or ident in ids:
                return answer
            directory = root if ident == 'legacy' else (root/'accounts'/ident).resolve()
            if directory != root and root not in directory.parents:
                return answer
            ids.append(ident)
        exists = any((root if ident == 'legacy' else root/'accounts'/ident).joinpath('.credentials.json').is_file() for ident in ids)
        return {**answer, 'status': 'mounted' if exists else 'not_connected', 'ownerId': owner, 'accountIds': ids,
                'in_use': (config.get('model') or {}).get('provider') == PROVIDER}
    except (OSError, ValueError, TypeError, AttributeError):
        return answer
