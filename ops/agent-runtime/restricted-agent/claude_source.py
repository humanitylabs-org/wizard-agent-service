"""Resolve only the installed Claude engine's /claude mount, never token values.

The legacy app uses wizard-ai-accounts-claude. App-owned shares compile to a
bind mount at the same app-owned destination. Resolve the actual installed
engine metadata, not an ambient credential/path override or grants.json.
"""
import os

LEGACY_VOLUME = 'wizard-ai-accounts-claude'
ENGINE_SERVICE = 'wizard-claude-engine'


def resolve(containers):
    engines = [c for c in containers if
               c.get('Config', {}).get('Labels', {}).get('com.docker.compose.service') == ENGINE_SERVICE
               and c.get('State', {}).get('Running') is True]
    if len(engines) != 1:
        return None
    mounts = [m for m in engines[0].get('Mounts', []) if m.get('Destination') == '/claude']
    if len(mounts) != 1:
        return None
    mount = mounts[0]
    if mount.get('Type') == 'volume' and mount.get('Name') == LEGACY_VOLUME:
        return {'type': 'volume', 'source': LEGACY_VOLUME}
    if mount.get('Type') == 'bind':
        source = mount.get('Source', '')
        # A compiled share is a dedicated absolute directory, never a root or
        # credential file. Its authority is the installed engine's exact mount.
        if (os.path.isabs(source) and os.path.normpath(source) == source
                and source.count('/') >= 3 and os.path.basename(source) == 'claude'):
            return {'type': 'bind', 'source': source}
    return None


def mount_spec(source, target='/claude-app'):
    spec = {**source, 'target': target, 'read_only': True}
    if source['type'] == 'bind':
        spec['bind'] = {'create_host_path': False}
    else:
        spec['volume'] = {'nocopy': True}  # daemon copy-up must not write to the app
    return spec


def compose_override(source):
    mount = mount_spec(source)
    doc: dict = {'services': {'claude-init': {'volumes': [mount]}}}
    if source['type'] == 'volume':
        mount['source'] = 'claude-app-login'
        doc['volumes'] = {'claude-app-login': {'external': True, 'name': source['source']}}
    return doc
