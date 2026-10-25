"""Python-only WAM rollout and public UX projection. No lifecycle operations.

The JavaScript daemon and every path in runtipi/{user-config,apps,app-data,state}
are deliberately outside this adapter. Rollback is compare-and-swap of selection
pointers; the caller owns the ONE explicit restart after all selections are set.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import tarfile
from release_transaction import Transaction, atomic

WAM_API='.config/systemd/user/wizard-app-manager-api.service.d/connection-fork-registry.conf'
WAM_RT='.config/systemd/user/wizard-agent-runtime.service.d/99-pp-launch-wam.conf'
WAM_CURRENT='.local/share/wam-python/current'
TARGETS=('.local/share/wizard-mobile-server/current','.local/share/wizard-agent-runtime/current',WAM_CURRENT,'.local/bin/wam',WAM_API,WAM_RT)

def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def unpack(archive,dst):
    dst=Path(dst);dst.mkdir(parents=True,exist_ok=False)
    with tarfile.open(archive) as tf:
        for m in tf:
            p=Path(m.name)
            if p.is_absolute() or '..' in p.parts or m.isdev() or m.isfifo():raise ValueError('unsafe candidate member')
        tf.extractall(dst,filter='data')
    return dst

def tree_hash(root):
    h=hashlib.sha256()
    for p in sorted(Path(root).rglob('*')):
        if p.is_symlink():raise ValueError('public projection contains symlink')
        if p.is_file():h.update(str(p.relative_to(root)).encode()+b'\0'+hashlib.sha256(p.read_bytes()).digest())
    return h.hexdigest()

class Rollout:
    def __init__(self,home,receipts,attempt):
        self.home=Path(home);self.attempt=attempt;self.root=Path(receipts)
        self.tx=Transaction(home,self.root/'transactions',attempt)
        self.ux=self.home/'apps/wizard-os-home/web';self.uxjournal=self.tx.root/'public-ux.json'
    def snapshot(self):
        result=self.tx.snapshot([self.home/n for n in TARGETS])
        if self.ux.is_symlink():ux={'kind':'link','target':os.readlink(self.ux)}
        else:ux={'kind':'dir','sha256':tree_hash(self.ux)}
        atomic(self.uxjournal,json.dumps({'attempt':self.attempt,'before':ux,'owned':None,'backup':str(self.ux.with_name('.ui-live.pp-before-'+self.attempt))}).encode())
        return result
    def prepare(self,candidate,wam,metadata):
        root=self.home/'.local/share/private-provider-launch/releases'/self.attempt
        unpack(candidate,root)
        self.prepared=root
        for name,sub in [('wizard-mobile-server','service'),('wizard-agent-runtime','runtime')]:
            dst=self.home/'.local/share'/name/'releases'/self.attempt
            dst.parent.mkdir(parents=True,exist_ok=True);shutil.copytree(root/sub,dst)
            (dst/'RELEASE_SHA').write_text(metadata['candidate_sha']+'\n')
            (dst/'SOURCE_REPO').write_text(metadata['repository']+'\n')
        dst=self.home/'.local/share/wam-python/releases'/self.attempt
        unpack(wam,dst)
        for n in ['wam/cli.py','wam/registry.py']:
            if digest(dst/n)!=metadata['wam_files'][n]:raise ValueError('WAM source archive drift')
        atomic(root/'selection.json',json.dumps(metadata).encode())
        return root
    def promote(self,runtime_argv):
        root=self.home/'.local/share/private-provider-launch/releases'/self.attempt
        for name in ['wizard-mobile-server','wizard-agent-runtime','wam-python']:
            self.tx.install(self.home/'.local/share'/name/'current',link=self.home/'.local/share'/name/'releases'/self.attempt)
        wam=self.home/WAM_CURRENT
        launcher=(self.home/'.local/bin/wam').read_text()
        from live_sources import launcher_source
        old=launcher_source(launcher)
        # Preserve the private catalogue/environment and interpreter exactly.
        launcher=launcher.replace(str(old),str(wam))
        self.tx.install(self.home/'.local/bin/wam',text=launcher.encode(),mode=0o755)
        prior=(self.home/WAM_API).read_text() if (self.home/WAM_API).exists() else '[Service]\n'
        if re.search(r'^WorkingDirectory=',prior,re.M):prior=re.sub(r'^WorkingDirectory=.*$', 'WorkingDirectory='+str(wam),prior,flags=re.M)
        else:prior+='\nWorkingDirectory='+str(wam)+'\n'
        self.tx.install(self.home/WAM_API,text=prior.encode(),mode=0o644)
        argv=list(runtime_argv);i=argv.index('--wam');argv[i+1]=str(wam)
        self.tx.install(self.home/WAM_RT,text=('[Service]\nExecStart=\nExecStart='+shlex.join(argv)+'\n').encode(),mode=0o644)
        journal=json.loads(self.uxjournal.read_text())
        if journal['before']['kind']=='dir':
            if self.ux.is_symlink() or tree_hash(self.ux)!=journal['before']['sha256']:raise ValueError('public UX drift')
        elif not self.ux.is_symlink() or os.readlink(self.ux)!=journal['before']['target']:raise ValueError('public UX pointer drift')
        journal['owned']=str(root/'ux');atomic(self.uxjournal,json.dumps(journal).encode())
        if journal['before']['kind']=='dir':os.replace(self.ux,journal['backup'])
        pending=self.ux.with_name('.ui-live.pp-'+self.attempt);pending.symlink_to(root/'ux');os.replace(pending,self.ux)
        if self.ux.resolve()!=root/'ux':raise ValueError('public UX readback failed')
        return {'selections_readback':self.tx.readback(),'ux_sha256':tree_hash(self.ux.resolve())}
    def rollback(self):
        # Validate the UX target before touching ANY source selection.
        journal=json.loads(self.uxjournal.read_text())
        if journal['owned']:
            if self.ux.exists() and (not self.ux.is_symlink() or os.readlink(self.ux)!=journal['owned']):raise ValueError('foreign public UX drift')
            if journal['before']['kind']=='dir' and tree_hash(journal['backup'])!=journal['before']['sha256']:raise ValueError('public UX snapshot drift')
        result=self.tx.rollback()
        if journal['owned']:
            if self.ux.is_symlink():self.ux.unlink()
            if journal['before']['kind']=='dir':os.replace(journal['backup'],self.ux)
            else:self.ux.symlink_to(journal['before']['target'])
            journal['owned']=None;atomic(self.uxjournal,json.dumps(journal).encode())
        return result
