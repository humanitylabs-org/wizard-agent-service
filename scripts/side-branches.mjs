#!/usr/bin/env node
// Read-only census of leftover live-first side branches (issue 418): every `integration/*`, `live/*` and `live-*`
// branch on the remote, split into
//   safe          no commit that is not already on main (patch-id compare, like `git cherry`), no open PR;
//   needs-decision carries commits main does not have: land by PR, abandon with sign-off, or keep with a reason;
//   held          tied to an open PR, so it is left alone until that PR is merged or closed.
// `owner-snapshot/*` and every other prefix are never listed. The script changes nothing: it only prints.
// --print-delete prints the `git push <remote> --delete` lines for the safe group, for a person who can push to run.
// Exit 0 when no side branch is left, 1 while any remain, 2 on a usage or git error.
//
//   git fetch --prune origin
//   gh pr list --state open --limit 500 --json headRefName > open-prs.json
//   node scripts/side-branches.mjs --open-prs open-prs.json [--json] [--print-delete]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SIDE = /^(integration\/|live\/|live-)/;

function gitIn(cwd) {
  return (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
}

export function sideBranches({ cwd = process.cwd(), remote = 'origin', base = 'main', openPrs = [] } = {}) {
  const git = gitIn(cwd);
  const baseRef = `refs/remotes/${remote}/${base}`;
  try { git('rev-parse', '--verify', '--quiet', baseRef); } catch { throw new Error(`${remote}/${base} not found; run git fetch ${remote} first`); }
  const open = new Set(openPrs);
  const prefix = `refs/remotes/${remote}/`;
  const names = git('for-each-ref', '--format=%(refname)', prefix)
    .split('\n').filter(Boolean).map(r => r.slice(prefix.length))
    .filter(n => SIDE.test(n)).sort();
  const rows = names.map(name => {
    const ref = prefix + name;
    // `git cherry base ref`: "+" = a commit whose change is not on base, "-" = an equivalent change already landed.
    const unique = git('cherry', baseRef, ref).split('\n').filter(l => l.startsWith('+')).length;
    const last = git('log', '-1', '--format=%cs', ref);
    const group = open.has(name) ? 'held' : unique === 0 ? 'safe' : 'needs-decision';
    return { name, unique, last, group };
  });
  return {
    remote,
    base,
    total: rows.length,
    safe: rows.filter(r => r.group === 'safe'),
    needsDecision: rows.filter(r => r.group === 'needs-decision'),
    held: rows.filter(r => r.group === 'held'),
  };
}

export function openPrHeads(text) {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error('open PR file must be a JSON array');
  return list.map(x => (typeof x === 'string' ? x : x?.headRefName)).filter(Boolean);
}

function parseArgs(argv) {
  const o = { remote: 'origin', base: 'main', openPrs: null, json: false, printDelete: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--print-delete') o.printDelete = true;
    else if (a === '--remote' || a === '--base' || a === '--open-prs') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      o[a === '--open-prs' ? 'openPrs' : a.slice(2)] = v;
    } else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

export function render(r, { printDelete = false } = {}) {
  const out = [`${r.total} side branch(es) on ${r.remote} (integration/*, live/*, live-*), compared with ${r.remote}/${r.base}`];
  const section = (title, rows, line) => {
    out.push('', `${title}: ${rows.length}`);
    for (const row of rows) out.push(line(row));
  };
  section('safe (no unique commits, no open PR)', r.safe, b => `  ${b.name}  last ${b.last}`);
  section('needs a decision (unique commits)', r.needsDecision, b => `  ${b.name}  ${b.unique} unique  last ${b.last}`);
  section('held (open PR, leave alone)', r.held, b => `  ${b.name}  ${b.unique} unique  last ${b.last}`);
  if (printDelete && r.safe.length) {
    out.push('', 'For a person who can push here (this script never runs it):');
    for (const b of r.safe) out.push(`git push ${r.remote} --delete ${b.name}`);
  }
  return out.join('\n');
}

export function main(argv = process.argv.slice(2), { cwd = process.cwd(), log = console.log, err = console.error } = {}) {
  let o;
  try {
    o = parseArgs(argv);
    const openPrs = o.openPrs ? openPrHeads(readFileSync(o.openPrs, 'utf8')) : [];
    if (!o.openPrs) err('note: no --open-prs file given, so no branch is marked held');
    const r = sideBranches({ cwd, remote: o.remote, base: o.base, openPrs });
    log(o.json ? JSON.stringify(r, null, 2) : render(r, o));
    return r.total === 0 ? 0 : 1;
  } catch (e) {
    err(`side-branches: ${e.message}`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main();
