"""Bounded stock-CLI login broker. No tokens, CLI output, or secrets are logged.

Reconnect is a fresh login, not refresh: old grants are retained for explicit
removal. A successful login is reconciled against the read-only pool inventory.
"""
import atexit
import fcntl
from pathlib import Path
import os
import re
import secrets
import select
import signal
import subprocess
import threading
import time
from urllib.parse import urlsplit, parse_qs

PROVIDERS = {'chatgpt': 'openai-codex', 'claude': 'anthropic'}
TERMINAL = {'succeeded', 'failed', 'cancelled', 'expired', 'needs_review'}
ANSI = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]')


def read_pool(provider):
    from hermes_cli.auth import read_credential_pool
    return read_credential_pool(provider)


class BrokerError(ValueError):
    pass


class Broker:
    def __init__(self, read=read_pool, command=None, ttl=600, lock_path=None):
        self.lock_path = lock_path
        self.stock_cli = command is None
        self.read = read
        self.command = command or ['hermes']
        self.ttl = ttl
        self.lock = threading.RLock()
        self.jobs = {}
        atexit.register(self.close)

    def rows(self, provider):
        return [r for r in self.read(PROVIDERS[provider]) if r.get('auth_type') == 'oauth']

    def target(self, provider, target):
        # CLI permits numeric positions and label fallbacks. Never accept those.
        if not isinstance(target, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', target) or target.isdigit():
            raise BrokerError('Exact nonnumeric credential ID required')
        inventory = self.rows(provider)
        if any(str(r.get('label', '')).strip().lower() == target.lower() for r in inventory):
            raise BrokerError('Credential ID conflicts with a label; resolve in Hermes first')
        rows = [r for r in inventory if r.get('id') == target]
        if len(rows) != 1 or not str(rows[0].get('source', '')).startswith('manual:'):
            raise BrokerError('Credential changed or is an externally managed source; refresh inventory')
        return rows[0]

    def start(self, provider, action, target=None, label='', confirmed=False):
        if provider not in PROVIDERS or action not in {'add', 'reconnect', 'remove'}:
            raise BrokerError('Unsupported action')
        if confirmed is not True:
            raise BrokerError('Explicit confirmation required')
        if self.stock_cli:
            from agent.credential_sources import adopt_external_logins_enabled
            from hermes_cli.config import load_config_readonly
            if adopt_external_logins_enabled():
                raise BrokerError('Disable external login adoption before using the account broker')
            cfg = load_config_readonly() or {}
            if provider == 'chatgpt' and action != 'remove' and (cfg.get('auth') or {}).get('codex_login_flow', 'device_code') != 'device_code':
                raise BrokerError('The browser broker requires the stock device_code login flow')
        if not isinstance(label, str) or len(label) > 60 or re.search(r'[\x00-\x1f\x7f]|sk-|eyJ', label):
            raise BrokerError('Invalid nickname')
        with self.lock:
            if any(j['status'] not in TERMINAL for j in self.jobs.values()):
                raise BrokerError('Another account operation is active')
            row = self.target(provider, target) if action != 'add' else None
            if action == 'add' and target is not None:
                raise BrokerError('Add does not accept a target')
            before = {r['id'] for r in self.rows(provider)}
            args = ['auth', 'remove', PROVIDERS[provider], target] if action == 'remove' else [
                'auth', 'add', PROVIDERS[provider], '--type', 'oauth', '--label', label or (row or {}).get('label') or 'Subscription', '--no-browser']
            env = dict(os.environ, PYTHONUNBUFFERED='1', BROWSER='/bin/true')
            # No shell, no output files, no provider tokens in arguments.
            if self.lock_path is None:
                from hermes_cli.config import get_hermes_home
                lock_path = Path(get_hermes_home()) / 'wizard-account-lifecycle.lock'
            else:
                lock_path = Path(self.lock_path)
            lease = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            try:
                fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if action != 'add':
                    self.target(provider, target)
                before = {r['id'] for r in self.rows(provider)}
                # Inherited lock survives a dashboard crash until the CLI exits.
                proc = subprocess.Popen(self.command + args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT, env=env, start_new_session=True, bufsize=0,
                                        pass_fds=(lease,))
            except Exception:
                os.close(lease)
                raise BrokerError('Account broker busy or CLI unavailable') from None
            job = dict(id=secrets.token_urlsafe(24), provider=provider, action=action,
                       target=target, status='running', expiresAt=time.time()+self.ttl,
                       url=None, userCode=None, inputRequired=False, credentialIds=[],
                       proc=proc, lease=lease, before=before, stop=None, submitted=False)
            self.jobs[job['id']] = job
            # Bound retained completed job metadata.
            for key in list(self.jobs):
                if len(self.jobs) > 64 and self.jobs[key]['status'] in TERMINAL:
                    del self.jobs[key]
            threading.Thread(target=self._run, args=(job,), daemon=True).start()
            return self.view(job)

    def view(self, job):
        return {k: job[k] for k in ('id', 'provider', 'action', 'target', 'status', 'expiresAt',
                                   'url', 'userCode', 'inputRequired', 'credentialIds')}

    def get(self, provider, jid):
        job = self.jobs.get(jid)
        if not job or job['provider'] != provider:
            raise BrokerError('Unknown operation')
        return job

    def poll(self, provider, jid):
        with self.lock:
            return self.view(self.get(provider, jid))

    def cancel(self, provider, jid):
        with self.lock:
            job = self.get(provider, jid)
            if job['status'] not in TERMINAL:
                job['stop'] = 'cancelled'
                self._kill(job['proc'])
            return self.view(job)  # pending until runner reconciles; never premature success

    def submit(self, provider, jid, code):
        with self.lock:
            job = self.get(provider, jid)
            if provider != 'claude' or job['status'] != 'running' or not job['inputRequired'] or job['submitted'] or job['stop'] or time.time() >= job['expiresAt']:
                raise BrokerError('Operation is not accepting a code')
            if not isinstance(code, str) or not re.fullmatch(r'[A-Za-z0-9_\-]{1,2048}#[A-Za-z0-9_\-]{1,256}', code):
                raise BrokerError('Invalid authorization code')
            job['submitted'] = True
            job['inputRequired'] = False
            try:
                job['proc'].stdin.write((code+'\n').encode())
                job['proc'].stdin.flush()
            except (BrokenPipeError, OSError):
                raise BrokerError('Login process ended; check status') from None
            return self.view(job)

    @staticmethod
    def _kill(proc):
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def _display(self, job, text):
        # Only exact provider authorization surfaces and short device code emitted
        # by the stock CLI. Never relay free-form stdout/errors or token responses.
        clean = ANSI.sub('', text)
        for url in re.findall(r'https://[^\s<>\"\']+', clean):
            u = urlsplit(url)
            if u.username or u.password or u.fragment:
                continue
            if job['provider'] == 'chatgpt' and url == 'https://auth.openai.com/codex/device':
                job['url'] = url
            if job['provider'] == 'claude' and u.netloc == 'claude.ai' and u.path == '/oauth/authorize':
                q = parse_qs(u.query)
                allowed = {'code', 'client_id', 'response_type', 'redirect_uri', 'scope', 'code_challenge', 'code_challenge_method', 'state'}
                if set(q) <= allowed and q.get('response_type') == ['code'] and q.get('code_challenge_method') == ['S256']:
                    job['url'] = url
        if job['provider'] == 'chatgpt':
            m = re.search(r'Enter this code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b', clean)
            if m:
                job['userCode'] = m.group(1)
        elif job['url'] and 'Authorization code:' in clean and not job['submitted']:
            job['inputRequired'] = True

    def _run(self, job):
        proc = job['proc']
        text = ''
        try:
            while proc.poll() is None:
                if time.time() >= job['expiresAt']:
                    job['stop'] = 'expired'
                    self._kill(proc)
                    break
                ready, _, _ = select.select([proc.stdout], [], [], .1)
                if ready:
                    chunk = os.read(proc.stdout.fileno(), 4096)
                    text = (text + chunk.decode('utf-8', 'replace'))[-16384:]
                    with self.lock:
                        self._display(job, text)
            proc.wait(timeout=5)
            # Kill any descendants left by a wrapper before releasing single-flight.
            self._kill(proc)
            after = {r['id'] for r in self.rows(job['provider'])}
            added = sorted(after - job['before'])
            with self.lock:
                job['credentialIds'] = added
                if job['action'] == 'remove':
                    ok = job['target'] not in after
                else:
                    ok = bool(added)
                unexpected_loss = job['before'] - after - ({job['target']} if job['action'] == 'remove' else set())
                job['status'] = ('needs_review' if unexpected_loss else
                                 'succeeded' if ok and proc.returncode == 0 else
                                 'needs_review' if ok or added else job['stop'] or 'failed')
        except Exception:
            self._kill(proc)
            proc.wait()
            job['status'] = 'needs_review'
        finally:
            proc.stdin.close()
            proc.stdout.close()
            os.close(job['lease'])
            with self.lock:
                job.update(url=None, userCode=None, inputRequired=False)

    def close(self):
        with self.lock:
            for job in self.jobs.values():
                if job['status'] not in TERMINAL:
                    self._kill(job['proc'])


broker = Broker()
