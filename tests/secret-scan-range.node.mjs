// Required `gitleaks` check judges only the change in front of it (humanitylabs-org/wizard-ux#887 rule 2). Before this, the job
// scanned every fetched branch's full history, so one key-like line on an unrelated branch turned every PR red
// (wizard-ux main froze 1–3 Nov 2026 that way). scripts/secret-scan-range.sh picks the range; these tests run it on a real throwaway repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const script = join(root, 'scripts/secret-scan-range.sh');
const workflow = readFileSync(join(root, '.github/workflows/secret-scan.yml'), 'utf8');

test('the required gitleaks job scans a computed range, never every fetched branch', () => {
  const job = workflow.slice(workflow.indexOf('\n  gitleaks:'), workflow.indexOf('\n  history-audit:'));
  assert.ok(job.length > 20, 'gitleaks job is present and the full-history scan is a separate job');
  assert.match(job, /if: github\.event_name == 'push' \|\| github\.event_name == 'pull_request'/);
  assert.match(job, /RANGE=\$\(sh scripts\/secret-scan-range\.sh\)/);
  const scans = job.split('\n').filter(l => /\.\/gitleaks git /.test(l));
  assert.equal(scans.length, 1);
  assert.match(scans[0], /--log-opts="\$RANGE"/, 'every gitleaks run in the required job is limited to the range');
  // The full-history scan still exists, off the PR path (schedule / manual only).
  const audit = workflow.slice(workflow.indexOf('\n  history-audit:'));
  assert.match(audit, /if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/);
  assert.match(audit, /--log-opts="--all"/);
  // The download is checked before it runs.
  assert.match(workflow, /GITLEAKS_SHA256: [0-9a-f]{64}/);
  assert.equal((workflow.match(/sha256sum -c -/g) || []).length, 2);
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'scan-range-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8' }).trim();
  const commit = (file, text) => { writeFileSync(join(dir, file), text); git('add', file); git('commit', '-qm', file); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'main');
  const m1 = commit('a.txt', 'one\n');
  git('checkout', '-qb', 'someone-else');                  // another thread's branch with a key-like line
  const leak = commit('leak.txt', 'api_key = "not-ours"\n');
  git('checkout', '-q', 'main');
  const m2 = commit('b.txt', 'two\n');
  git('checkout', '-qb', 'my-pr');
  const p1 = commit('c.txt', 'mine\n');
  const p2 = commit('d.txt', 'mine too\n');
  git('update-ref', 'refs/remotes/origin/main', m2);      // what actions/checkout leaves behind
  git('update-ref', 'refs/remotes/origin/someone-else', leak);
  const run = vars => spawnSync('sh', [script], { cwd: dir, env: { PATH: process.env.PATH, ...vars }, encoding: 'utf8' });
  const commits = range => (range ? git('rev-list', range).split('\n').filter(Boolean) : []);
  return { dir, git, run, commits, m1, m2, leak, p1, p2, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('pull_request: exactly the PR\'s own commits, not another branch\'s', () => {
  const r = repo();
  try {
    const out = r.run({ EVENT: 'pull_request', PR_BASE: r.m2, PR_HEAD: r.p2 });
    assert.equal(out.status, 0, out.stderr);
    const got = r.commits(out.stdout.trim());
    assert.deepEqual(new Set(got), new Set([r.p1, r.p2]));
    assert.ok(!got.includes(r.leak) && !got.includes(r.m1));
  } finally { r.done(); }
});

test('push: main scans main\'s history; another branch scans what main lacks; a delete scans nothing', () => {
  const r = repo();
  try {
    let out = r.run({ EVENT: 'push', PUSH_REF: 'refs/heads/main', PUSH_AFTER: r.m2, DEFAULT_BRANCH: 'main' });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(new Set(r.commits(out.stdout.trim())), new Set([r.m1, r.m2]));
    out = r.run({ EVENT: 'push', PUSH_REF: 'refs/heads/my-pr', PUSH_AFTER: r.p2, DEFAULT_BRANCH: 'main' });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(new Set(r.commits(out.stdout.trim())), new Set([r.p1, r.p2]));
    out = r.run({ EVENT: 'push', PUSH_REF: 'refs/heads/someone-else', PUSH_AFTER: r.leak, DEFAULT_BRANCH: 'main' });
    assert.deepEqual(r.commits(out.stdout.trim()), [r.leak], 'that branch\'s own push still catches its own line');
    out = r.run({ EVENT: 'push', PUSH_REF: 'refs/heads/my-pr', PUSH_AFTER: '0'.repeat(40), DEFAULT_BRANCH: 'main' });
    assert.equal(out.status, 0);
    assert.equal(out.stdout, '');
  } finally { r.done(); }
});

test('a malformed or missing commit fails the check instead of scanning nothing', () => {
  const r = repo();
  try {
    for (const vars of [
      { EVENT: 'pull_request', PR_BASE: 'main; echo hi', PR_HEAD: r.p2 },
      { EVENT: 'pull_request', PR_BASE: r.m2, PR_HEAD: 'f'.repeat(40) },
      { EVENT: 'pull_request', PR_BASE: '', PR_HEAD: r.p2 },
      { EVENT: 'push', PUSH_REF: 'refs/heads/x', PUSH_AFTER: '', DEFAULT_BRANCH: 'main' },
      { EVENT: 'schedule' },
    ]) {
      const out = r.run(vars);
      assert.notEqual(out.status, 0, JSON.stringify(vars));
      assert.equal(out.stdout, '');
    }
  } finally { r.done(); }
});
