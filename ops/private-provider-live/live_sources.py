"""Read-only discovery of the three independently selected live WAM sources.

The CLI launcher, manager API unit and agent runtime may select different trees.
Only code/launcher hashes are returned; no credential or agent files are opened.
"""
import hashlib
from pathlib import Path
import re
import shlex
import subprocess

FILES = ('wam/cli.py', 'wam/registry.py', 'wam/runtipi.py')

def code_identity(root):
    root = Path(root).resolve(strict=True)
    digests = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in FILES}
    return {'resolved': str(root), 'sha256': digests}

def launcher_source(text):
    matches = re.findall(r'^cd\s+([\'"][^\n]+?[\'"]|[^\s]+)\s*&&\s*exec\s+[^\n]*\s-m\s+wam(?:\s|$)', text, re.M)
    if len(matches) != 1:
        raise ValueError('WAM CLI launcher source is ambiguous')
    parts = shlex.split(matches[0])
    if len(parts) != 1 or not Path(parts[0]).is_absolute():
        raise ValueError('WAM CLI source must be an absolute immutable path')
    return Path(parts[0])

def runtime_source(text):
    # systemctl's formatted argv is not shell syntax; the selected path must not
    # contain whitespace and must be explicit, rather than a guessed checkout.
    matches = re.findall(r'(?:^|\s)--wam\s+([^\s;]+)', text)
    if len(matches) != 1 or not Path(matches[0]).is_absolute():
        raise ValueError('runtime WAM selection is absent or ambiguous')
    return Path(matches[0])

def discover(home, show=None):
    home = Path(home)
    def system_show(unit, field):
        return subprocess.check_output(['systemctl', '--user', 'show', unit,
            '--property=' + field, '--value'], text=True, timeout=20).strip()
    show = show or system_show
    launcher = home / '.local/bin/wam'
    text = launcher.read_text()
    selected = {
        'cli': launcher_source(text),
        'api': Path(show('wizard-app-manager-api', 'WorkingDirectory')),
        'runtime': runtime_source(show('wizard-agent-runtime', 'ExecStart')),
    }
    if not selected['api'].is_absolute():
        raise ValueError('WAM API selected source is absent')
    return {'selected': {name: code_identity(root) for name, root in selected.items()},
            'launcher_sha256': hashlib.sha256(launcher.read_bytes()).hexdigest()}
