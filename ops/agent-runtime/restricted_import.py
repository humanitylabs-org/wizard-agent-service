"""Owner-only restricted admission. Rollback/staging never enter the runtime.

The portable transformer operates on an unregistered, owner-private staging home.
Admission re-owns that SAME tree in place, then renames it into the sealed target.
Only RestrictedDriver starts it. No DB copy, host chmod/read bypass or agent-root
bootstrap is used. The root one-shot below only changes ownership (home-init's
capabilities); all population/verification after sealing runs as uid 10000.
"""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import secrets
import shutil
import stat
import time
import zipfile

import agent_runtime as rt
import declared_egress


@contextmanager
def lock(directory):
    directory = Path(directory)
    fd = os.open(directory / '.lifecycle.lock', os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


class StagingRuntime:
    """No runtime activation: the transformer writes a private staging registry."""
    def __init__(self, plan, directory, agent_id):
        self.plan, self.directory = plan, Path(directory)
    def start(self):
        pass
    def healthy(self, key):
        pass
    def remove(self):
        pass
    def import_archive(self, archive):
        # Validated transport only, never untrusted links/special files. Native
        # import occurs in a stopped uid-10000 helper, then staging is returned
        # to the owner for policy transformation; never mounted to an agent.
        reown(self.directory / 'home', rt.AGENT_UID)
        from hermes_import import DockerRuntime
        runtime = DockerRuntime(self.plan, self.directory, 'staging-only')
        # The filtered transport is private 0600, not world-readable. Give only
        # this ephemeral file to uid 10000 before its read-only import mount.
        if Path(archive) != self.directory / 'transport.zip':
            raise rt.RuntimeFailure('import_transport_invalid', 409)
        helper(self.directory, 'import os; os.chown("/opt/data/transport.zip",10000,10000,follow_symlinks=False)',
               uid=0, privileged=True)
        runtime.import_archive(archive, uid=rt.AGENT_UID)
        reown(self.directory / 'home', os.getuid())


def helper(home, code, *, uid=rt.AGENT_UID, privileged=False, data=None):
    name = 'wizard-import-helper-' + secrets.token_hex(6)
    args = ['run', '--rm', '-i', '--name', name, '--network', 'none', '--read-only',
            '--user', f'{uid}:{uid}', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
            '--pids-limit', '32', '--memory', '128m', '--mount', f'type=bind,src={home},dst=/opt/data',
            '--entrypoint', 'python3']
    if privileged:
        args += ['--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE']
    try:
        return rt.docker([*args, rt.SIDECAR_IMAGE, '-c', code], input_text=json.dumps(data) if data is not None else None, timeout=120)
    except BaseException:
        rt.docker(['rm', '-f', name], timeout=30, check=False)
        raise


def reown(home, uid):
    # No imported code, no following links, no file contents read. Same inode.
    helper(home, '''import os,stat
root='/opt/data'
uid=int(__import__('sys').stdin.read())
for base, dirs, names in os.walk(root, followlinks=False):
 for name in dirs+names:
  p=os.path.join(base,name)
  os.chown(p,uid,uid,follow_symlinks=False)
os.chown(root,uid,uid)
os.chmod(root,0o700)
''', uid=0, privileged=True, data=uid)


def relocate(source, target):
    """rename(2) needs write on a moved directory's '..', even when its parent
    is owner-writable. Perform only this fixed rename with DAC_OVERRIDE; never
    relax the sealed directory to let the host perform it."""
    transfer = target.parent / '.import-transfer'
    # Two bind mounts have distinct mount identities: rename between them is
    # EXDEV even on the same disk. Move the OWNER-owned enclosing staging dir,
    # never chmod the sealed child, then rename the child within one bind mount.
    # A fixed transfer name lets undo reconcile a crash on either side of rename.
    source.parent.rename(transfer)
    if os.environ.get('WIZARD_IMPORT_CRASH_AFTER') == 'transfer-staged':
        raise SystemExit('simulated_import_crash_transfer_staged')
    name = 'wizard-import-rename-' + secrets.token_hex(6)
    try:
        rt.docker(['run', '--rm', '--name', name, '--network', 'none', '--read-only', '--user', '0:0',
                   '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--security-opt', 'no-new-privileges:true',
                   '--mount', f'type=bind,src={target.parent},dst=/target', '--entrypoint', 'python3', rt.SIDECAR_IMAGE,
                   '-c', 'import os; os.rename("/target/.import-transfer/home", "/target/home")'], timeout=30)
        if os.environ.get('WIZARD_IMPORT_CRASH_AFTER') == 'transfer-moved':
            raise SystemExit('simulated_import_crash_transfer_moved')
    except BaseException:
        rt.docker(['rm', '-f', name], timeout=30, check=False)
        raise
    finally:
        if os.environ.get('WIZARD_IMPORT_CRASH_AFTER') != 'transfer-moved':
            transfer.rename(source.parent)


def metadata(home):
    result = {}
    for base, dirs, names in os.walk(home, followlinks=False):
        for path in [Path(base), *(Path(base) / n for n in dirs + names)]:
            s = path.lstat()
            result[path.relative_to(home).as_posix()] = [s.st_uid, s.st_gid, stat.S_IMODE(s.st_mode)]
    return result


def checkpoint(h, path, journal, step):
    journal['step'] = step
    h.dump(path, journal)
    # Deliberate hard crash injection: intent is already durable. Not an agent API.
    if os.environ.get('WIZARD_IMPORT_CRASH_AFTER') == step:
        raise SystemExit('simulated_import_crash_' + step)


def driver(h, root, plan):
    agents = rt.Agents(Path(root) / 'agents', None)
    return rt.RestrictedDriver(agents, rt.RESTRICTED_DIR, plan['image'], int(plan.get('agent_listener_port', 8929)))


def apply(h, plan, agent_id, wizard_home, *, allow_source_stop=False):
    started = time.monotonic()
    root = Path(wizard_home).absolute()
    h.validate_plan(plan, root)
    h.require(h.ID_RE.fullmatch(agent_id) and agent_id not in {'hermes', 'main', 'default', 'new', 'options'}, 'agent_id')
    h.require(plan.get('isolation') == 'restricted', 'import_requires_restricted')
    h.require(not plan.get('approved_mcp'), 'import_mcp_requires_separate_review')
    h.require(not plan.get('route_default'), 'restricted_cutover_requires_separate_gate')
    target = root / 'agents' / agent_id
    h.require(not target.exists() and not target.is_symlink(), 'agent_exists')
    source = Path(plan['source'])
    h.assert_owner(source)
    h.require(h.source_identity(plan) == plan['source_identity'], 'source_changed_rescan')
    # No builds/pulls on the control plane. All images must be preloaded.
    for image in (plan['image'], rt.SIDECAR_IMAGE):
        rt.docker(['image', 'inspect', image], timeout=30)
    d = driver(h, root, plan)
    # Reserve journal before the registry mutation, so a crash can always undo.
    work = root / 'imports' / agent_id
    h.require(not work.exists(), 'import_work_exists')
    work.mkdir(mode=0o700, parents=True)
    path = work / 'journal.json'
    journal = {'schema': 1, 'restricted_import': True, 'id': agent_id, 'root': str(root), 'plan': plan,
               'step': 'intent', 'state': 'preparing', 'metadata': metadata(source) if plan['move'] else {},
               'uid': os.getuid(), 'gid': os.getgid()}
    checkpoint(h, path, journal, 'intent')
    cfg = plan['summary']['model']
    h.run(['node', str(Path(__file__).with_name('import-reserve.mjs'))], input=json.dumps({
        'agentsDir': str(root / 'agents'), 'id': agent_id, 'provider': cfg['provider'], 'model': cfg['default'],
        'port': plan['port'], 'image': plan['image'], 'outside_tools': plan['outside_tools']}))
    record = d.agents.read(agent_id)
    h.require(record['runtime'].get('admission') == 'importing' and rt.restricted(record), 'reservation_not_restricted')
    checkpoint(h, path, journal, 'reserved')
    with lock(target):
        # An importing record is denied by every RestrictedDriver lifecycle even
        # if another owner CLI/UI tries to start it while staging is in progress.
        stage_root = work / 'stage'
        h.apply(plan, agent_id, stage_root, runtime_factory=StagingRuntime, allow_source_stop=allow_source_stop)
        stage = stage_root / 'agents' / agent_id
        home = stage / 'home'
        checkpoint(h, path, journal, 'staged')
        # Registry keys, not transformer-generated keys, own the actual target.
        wired = dict(plan, gateway_url='http://edge:8923/wizard/mcp', logical_home='/opt/data', path_preserving=False)
        h.wire(home, wired, d.agents.secret(agent_id, 'runtime.key'), d.agents.secret(agent_id, 'gateway.key'))
        managed = target / 'managed'
        for name in rt.MANAGED_FILES:
            shutil.copy2(home / name, managed / name)
        # Native HOME is inside the sealed home, not the host's home. The alias
        # contains a .hermes symlink to /opt/data; absolute source paths keep working.
        native = home / 'native-home'
        h.require(not native.exists() and not native.is_symlink(), 'native_home_collision')
        inner_path = stage / 'import-journal.json'
        inner = json.loads(inner_path.read_text())
        inner['assets_added'].append('native-home')
        h.dump(inner_path, inner)
        native.mkdir(mode=0o700)
        (native / '.hermes').symlink_to('/opt/data')
        if not (home / '.ssh').exists() and not (home / '.ssh').is_symlink():
            inner['assets_added'].append('.ssh')
            h.dump(inner_path, inner)
            (home / '.ssh').symlink_to('native-home/.ssh')
        for item in plan['dependencies']:
            if item.get('approved') and item.get('action', item['proposal']) == 'carry secret':
                dest = native / Path(item['path']).relative_to(plan['owner_home'])
                dest.parent.mkdir(mode=0o700, exist_ok=True, parents=True)
                src = stage / 'credentials' / h.digest(item['path'])
                if src.is_dir():
                    shutil.copytree(src, dest)
                else:
                    shutil.copy2(src, dest)
                top = Path(item['path']).relative_to(plan['owner_home']).parts[0]
                alias = home / top
                if not alias.exists() and not alias.is_symlink():
                    inner['assets_added'].append(top)
                    h.dump(inner_path, inner)
                    alias.symlink_to('native-home/' + top)
        mounts = [{'type': 'bind', 'source': str(target / 'home' / 'native-home'), 'target': plan['owner_home']}]
        writable_groups = set()
        for item in plan['dependencies']:
            if item.get('approved') and item.get('action', item['proposal']) in {'mount rw', 'mount ro'}:
                src = h.safe_mount(item['path'], owner_home=plan['owner_home'], wizard_home=root, source=plan['source'])
                mounts.append({'type': 'bind', 'source': src, 'target': item['path'], 'read_only': item.get('action', item['proposal']) == 'mount ro'})
                s = Path(src).stat()
                if item.get('action', item['proposal']) == 'mount rw' and s.st_mode & stat.S_IWGRP:
                    writable_groups.add(s.st_gid)
        groups = plan.get('supplemental_groups', [])
        h.require(all(type(g) is int and g > 0 and g in writable_groups for g in groups), 'import_mount_group_not_granted')
        h.dump(target / 'import-runtime.json', {'services': {'agent': {'volumes': mounts, 'group_add': [str(g) for g in groups], 'environment': {'HOME': '/opt/data', 'HERMES_HOME': '/opt/data'}}}})
        checkpoint(h, path, journal, 'prepared')
        reown(home, rt.AGENT_UID)
        helper(home, 'import os; assert os.getuid()==10000; assert os.stat("/opt/data").st_uid==10000; os.chmod("/opt/data",0o700)')
        checkpoint(h, path, journal, 'sealed')
        # Directory rename preserves all DB inodes; the old empty reserved home
        # never contains imported bytes under the host owner's UID.
        (target / 'home').rmdir()
        relocate(home, target / 'home')
        checkpoint(h, path, journal, 'placed')
        record['imported'] = {'schema': 1, 'format': 'hermes', 'history_visibility': 'standard-owner-visible',
                              'auto_app_grants': False, 'denied_apps': ['privacycom', 'privacy-com', 'privacy.com']}
        record['runtime'].pop('admission')
        record['runtime']['image'] = plan['image']
        record['runtime']['declared_tcp'] = declared_egress.validate(plan.get('declared_tcp', []))
        h.dump(target / 'import-journal.json', {'restricted_import': True, 'journal': str(path)})
        h.dump(target / 'agent.json', record)
        checkpoint(h, path, journal, 'admitted')
        d.start(record)
        # Only the edge's loopback relay is published, never the agent API itself.
        health = h.DockerRuntime(dict(plan, port=record['runtime']['port']), target, agent_id)
        health.healthy(d.agents.secret(agent_id, 'runtime.key'))
        h.dump(target / 'service-state.json', {'desired': 'running', 'started_at': int(time.time() * 1000)})
        journal.update(state='applied', apply_seconds=round(time.monotonic() - started, 3))
        checkpoint(h, path, journal, 'running')
    return {'id': agent_id, 'journal': str(path), 'apply_seconds': journal['apply_seconds']}


def lifecycle(h, path, action):
    journal = json.loads(Path(path).read_text())
    if 'journal' in journal:
        journal = json.loads(Path(journal['journal']).read_text())
    h.require(journal.get('state') == 'applied', 'import_not_applied')
    target = Path(journal['root']) / 'agents' / journal['id']
    with lock(target):
        d = driver(h, journal['root'], journal['plan'])
        record = d.agents.read(journal['id'])
        h.require(rt.restricted(record), 'import_requires_restricted')
        result = getattr(d, action)(record)
        h.dump(target / 'service-state.json', {'desired': 'stopped' if action == 'stop' else 'running'})
        return result


def undo(h, journal_path):
    started = time.monotonic()
    path = Path(journal_path)
    journal = json.loads(path.read_text())
    if 'journal' in journal:
        path = Path(journal['journal'])
        journal = json.loads(path.read_text())
    h.require(journal.get('restricted_import') is True and h.ID_RE.fullmatch(journal['id']), 'journal_invalid')
    if journal.get('state') == 'undone':
        return {'id': journal['id'], 'state': 'undone', 'journal': str(path), 'undo_seconds': journal['undo_seconds']}
    root = Path(journal['root'])
    target = root / 'agents' / journal['id']
    work = path.parent
    stage = work / 'stage/agents' / journal['id']
    # Reconcile process death while the owner-owned enclosing directory was
    # temporarily parked for a one-mount rename (including undo's reverse move).
    if (target / '.import-transfer').exists() and not stage.exists():
        (target / '.import-transfer').rename(stage)
    if (stage / '.import-transfer').exists() and not target.exists():
        (stage / '.import-transfer').rename(target)
    staged_journal = stage / 'import-journal.json'
    if staged_journal.exists():
        h.validate_backups(stage, json.loads(staged_journal.read_text()))
    if target.exists():
        with lock(target):
            d = driver(h, root, journal['plan'])
            record = d.agents.read(journal['id'])
            record['runtime']['admission'] = 'importing'
            h.dump(target / 'agent.json', record)
            # Down is allowed while admission is held; no other project's labels
            # are used. Removing networks is part of undo, not just stopping them.
            d._compose(record, 'down', '--volumes', '--remove-orphans', timeout=120)
            home = target / 'home'
            if home.exists() and stage.exists() and not (stage / 'home').exists():
                relocate(home, stage / 'home')
            if (stage / 'home').exists():
                reown(stage / 'home', journal['uid'])
            # Remove only the reserved target; never traverse a foreign home.
            if home.exists():
                home.rmdir()
            shutil.rmtree(target)
    elif (stage / 'home').exists():
        reown(stage / 'home', journal['uid'])
    inner_path = stage / 'import-journal.json'
    if inner_path.exists():
        h.undo(inner_path, runtime_factory=StagingRuntime)
    source = Path(journal['plan']['source'])
    if journal['plan']['move'] and source.exists():
        # Restore original mode/gid metadata too, after original/quarantine bytes
        # are back. Never follow source links during restoration.
        for rel, (uid, gid, mode) in journal['metadata'].items():
            p = source if rel == '.' else source / rel
            if p.exists() or p.is_symlink():
                os.chown(p, uid, gid, follow_symlinks=False)
                if not p.is_symlink():
                    os.chmod(p, mode)
    # Retain only a non-secret receipt, no source/auth copies or staging tree.
    shutil.rmtree(work / 'stage', ignore_errors=True)
    journal.update(state='undone', undo_seconds=round(time.monotonic() - started, 3))
    checkpoint(h, path, journal, 'undone')
    return {'id': journal['id'], 'state': 'undone', 'journal': str(path), 'undo_seconds': journal['undo_seconds']}
