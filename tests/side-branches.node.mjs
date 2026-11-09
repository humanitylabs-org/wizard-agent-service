// scripts/side-branches.mjs (issue 418): read-only census of leftover integration/* and live* branches.
// These tests build a throwaway repo with remote-tracking refs and check the grouping, the exit code and
// that the script never deletes or moves a ref.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sideBranches, openPrHeads, render, main, SIDE } from '../scripts/side-branches.mjs';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'side-branches-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8' }).trim();
  const commit = (file, text) => { writeFileSync(join(dir, file), text); git('add', file); git('commit', '-qm', file); return git('rev-parse', 'HEAD'); };
  const remote = (name, sha) => git('update-ref', `refs/remotes/origin/${name}`, sha);
  git('init', '-q', '-b', 'main');
  const m1 = commit('a.txt', 'one\n');
  // live-picked: its change was later cherry-picked onto main (different sha, same patch) -> safe.
  git('checkout', '-qb', 'tmp-picked');
  const picked = commit('picked.txt', 'picked\n');
  // live/extra: carries a change main never got -> needs a decision.
  git('checkout', '-q', m1);
  git('checkout', '-qb', 'tmp-extra');
  const extra1 = commit('extra.txt', 'extra\n');
  const extra2 = commit('extra2.txt', 'extra2\n');
  // integration/open-pr: unique, but an open PR still uses it -> held.
  git('checkout', '-q', m1);
  git('checkout', '-qb', 'tmp-open');
  const open = commit('open.txt', 'open\n');
  git('checkout', '-q', 'main');
  git('cherry-pick', picked);
  const m2 = commit('b.txt', 'two\n');
  remote('main', m2);
  remote('integration/old-merged', m1);       // fully on main -> safe
  remote('live-picked', picked);
  remote('live/extra', extra2);
  remote('integration/open-pr', open);
  remote('owner-snapshot/box', extra1);        // never listed
  remote('feature/thing', extra1);             // other prefixes never listed
  remote('liveliness-fix', extra1);            // "live" without - or / is not a side branch
  // integration/clean-merge: main merged into an old branch, nothing added -> safe.
  git('checkout', '-q', m1);
  git('merge', '-q', '--no-ff', '--no-edit', m2);
  remote('integration/clean-merge', git('rev-parse', 'HEAD'));
  // live/evil-merge: same merge, but with an extra file made inside the merge commit -> 1 unique.
  writeFileSync(join(dir, 'in-merge.txt'), 'only in the merge\n');
  git('add', 'in-merge.txt');
  git('commit', '-q', '--amend', '--no-edit');
  remote('live/evil-merge', git('rev-parse', 'HEAD'));
  git('checkout', '-q', 'main');
  const refs = () => git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes');
  return { dir, git, refs, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('prefix rule matches only integration/, live/ and live-', () => {
  for (const n of ['integration/x', 'live/x', 'live-x-20261025']) assert.ok(SIDE.test(n), n);
  for (const n of ['owner-snapshot/x', 'feature/live-x', 'liveliness-fix', 'main', 'fix/integration/x']) assert.ok(!SIDE.test(n), n);
});

test('groups side branches into safe, needs-decision and held', () => {
  const r = repo();
  try {
    const got = sideBranches({ cwd: r.dir, openPrs: ['integration/open-pr'] });
    assert.equal(got.total, 6);
    assert.deepEqual(got.safe.map(b => b.name), ['integration/clean-merge', 'integration/old-merged', 'live-picked']);
    // The edit made inside a merge commit counts, although `git cherry` alone skips merges.
    assert.deepEqual(got.needsDecision.map(b => [b.name, b.unique]), [['live/evil-merge', 1], ['live/extra', 2]]);
    assert.deepEqual(got.held.map(b => [b.name, b.unique]), [['integration/open-pr', 1]]);
    for (const b of [...got.safe, ...got.needsDecision, ...got.held]) assert.match(b.last, /^\d{4}-\d{2}-\d{2}$/);
  } finally { r.done(); }
});

test('without open PRs a unique branch is needs-decision, never safe', () => {
  const r = repo();
  try {
    const got = sideBranches({ cwd: r.dir });
    assert.deepEqual(got.needsDecision.map(b => b.name), ['integration/open-pr', 'live/evil-merge', 'live/extra']);
    assert.equal(got.held.length, 0);
  } finally { r.done(); }
});

test('CLI is read-only, exits 1 while branches remain and 0 once none are left', () => {
  const r = repo();
  try {
    const before = r.refs();
    const prs = join(r.dir, 'open-prs.json');
    writeFileSync(prs, JSON.stringify([{ headRefName: 'integration/open-pr' }, { headRefName: 'feature/thing' }]));
    const out = [];
    const code = main(['--open-prs', prs, '--print-delete'], { cwd: r.dir, log: s => out.push(s), err: () => {} });
    assert.equal(code, 1);
    const text = out.join('\n');
    assert.match(text, /^6 side branch\(es\) on origin/);
    assert.match(text, /safe \(no unique commits, no open PR\): 3/);
    assert.match(text, /needs a decision \(unique commits\): 2\n  live\/evil-merge  1 unique  last [-\d]+\n  live\/extra  2 unique/);
    assert.match(text, /held \(open PR, leave alone\): 1\n  integration\/open-pr/);
    const deletes = text.split('\n').filter(l => l.startsWith('git push'));
    assert.deepEqual(deletes, ['git push origin --delete integration/clean-merge', 'git push origin --delete integration/old-merged', 'git push origin --delete live-picked']);
    assert.ok(!text.includes('owner-snapshot') && !text.includes('feature/thing') && !text.includes('liveliness'));
    assert.equal(r.refs(), before, 'no ref was deleted or moved');

    // Without --print-delete no delete line is printed.
    const quiet = [];
    main(['--open-prs', prs], { cwd: r.dir, log: s => quiet.push(s), err: () => {} });
    assert.ok(!quiet.join('\n').includes('git push'));

    // A person deletes them all: the re-run reports 0 left and exits 0.
    for (const n of ['integration/old-merged', 'integration/clean-merge', 'live-picked', 'live/extra', 'live/evil-merge', 'integration/open-pr']) r.git('update-ref', '-d', `refs/remotes/origin/${n}`);
    const json = [];
    assert.equal(main(['--json'], { cwd: r.dir, log: s => json.push(s), err: () => {} }), 0);
    assert.equal(JSON.parse(json[0]).total, 0);
  } finally { r.done(); }
});

test('usage and git errors exit 2', () => {
  const r = repo();
  try {
    const err = [];
    assert.equal(main(['--nope'], { cwd: r.dir, log: () => {}, err: s => err.push(s) }), 2);
    assert.equal(main(['--base', 'missing'], { cwd: r.dir, log: () => {}, err: s => err.push(s) }), 2);
    assert.match(err.join('\n'), /origin\/missing not found/);
    // Delete lines are only offered when open PR heads are known.
    const out = [];
    assert.equal(main(['--print-delete'], { cwd: r.dir, log: s => out.push(s), err: s => err.push(s) }), 2);
    assert.equal(out.length, 0);
    assert.match(err.join('\n'), /--print-delete needs --open-prs/);
  } finally { r.done(); }
});

test('open PR file accepts gh --json headRefName output or plain names', () => {
  assert.deepEqual(openPrHeads('[{"headRefName":"live/a"},"integration/b",{}]'), ['live/a', 'integration/b']);
  assert.throws(() => openPrHeads('{}'), /JSON array/);
  assert.equal(render({ remote: 'origin', base: 'main', total: 0, safe: [], needsDecision: [], held: [] }).split('\n')[0],
    '0 side branch(es) on origin (integration/*, live/*, live-*), compared with origin/main');
});
