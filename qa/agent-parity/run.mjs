import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { kinds } from './fixture.mjs'
import { checks, runCheck } from './checks.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const manifest = JSON.parse(readFileSync(join(root, 'qa/agent-parity/features.json'), 'utf8'))
const flags = new Set(process.argv.slice(2))
const reportArg = process.argv.indexOf('--report-dir')
const reportDir = resolve(reportArg >= 0 ? process.argv[reportArg + 1] : join(root, 'qa/agent-parity/reports/latest'))
if (flags.has('--live')) throw new Error('Live mode is not implemented. Refusing to label fixture evidence as live or touch existing agents.')
const unique = (values, field) => { if (new Set(values).size !== values.length) throw new Error(`Duplicate ${field}`) }
unique(manifest.features.map(f => f.id), 'feature ids'); unique(manifest.runtime_kinds, 'runtime kinds')
if (JSON.stringify(manifest.runtime_kinds) !== JSON.stringify(kinds)) throw new Error('Manifest runtime kind set differs from runner')
for (const f of manifest.features) {
  for (const field of ['id', 'description', 'layer', 'how_to_test']) if (typeof f[field] !== 'string' || !f[field]) throw new Error(`Missing ${f.id}.${field}`)
  if (f.fixture && !checks[f.fixture]) throw new Error(`Missing fixture implementation: ${f.id}`)
  if (f.policy_exemptions.length) throw new Error(`Policy exemption requires an executable policy assertion: ${f.id}`)
}
for (const check of Object.keys(checks)) if (!manifest.features.some(f => f.fixture === check)) throw new Error(`Undeclared check: ${check}`)
mkdirSync(reportDir, { recursive: true })
const rows = []
// Checkpoint every cell, so a crash never looks like a completed matrix.
writeFileSync(join(reportDir, 'cells.jsonl'), '')
for (const feature of manifest.features) {
  for (const kind of kinds) {
    const cell = feature.fixture ? await runCheck(kind, feature.fixture) : {
      feature: feature.id, kind, status: 'fail', reason: `No per-kind ${feature.layer} evidence implemented`, evidence: 'not-run', failure_kind: 'coverage-gap',
    }
    cell.feature = feature.id
    rows.push(cell)
    writeFileSync(join(reportDir, 'cells.jsonl'), JSON.stringify(cell) + '\n', { flag: 'a' })
    if (cell.evidence !== 'not-run') console.log(`${cell.status} ${feature.id}/${kind}${cell.reason ? ': ' + cell.reason.replace(/\s+/g, ' ') : ''}`)
  }
}
unique(rows.map(r => JSON.stringify([r.feature, r.kind])), 'matrix cells')
if (rows.length !== manifest.features.length * kinds.length) throw new Error('Incomplete matrix')
const counts = cells => Object.fromEntries(['pass', 'fail', 'policy-exempt'].map(status => [status, cells.filter(c => c.status === status).length]))
const tested = rows.filter(c => c.evidence !== 'not-run')
const sourceHash = Object.fromEntries(['server/service.mjs', 'server/agents-http.mjs', 'server/agent-chat-inputs.mjs', 'qa/agent-parity/features.json'].map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]))
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const report = { schema_version: 1, mode: 'fixture', completed: true, generated_at: new Date().toISOString(), provenance: { commit: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain'])), source_sha256: sourceHash }, feature_count: manifest.features.length, kind_count: kinds.length, cell_count: rows.length, summary: counts(rows), fixture_summary: counts(tested), coverage_gap_count: rows.filter(c => c.failure_kind === 'coverage-gap').length, live_verified: false, browser_verified: false, cleanup: { disposable_fixtures: true, existing_agents_opened: false }, cells: rows }
writeFileSync(join(reportDir, 'matrix.json'), JSON.stringify(report, null, 2) + '\n')
const lines = ['# Agent chat parity matrix', '', '**Fixture evidence only. No live or real-browser acceptance claimed.**', '', `Features: ${report.feature_count}; cells: ${rows.length}; pass/fail/exempt: ${report.summary.pass}/${report.summary.fail}/${report.summary['policy-exempt']}.`, `Executed fixture cells: ${tested.length}; pass/fail: ${report.fixture_summary.pass}/${report.fixture_summary.fail}. Missing evidence cells: ${report.coverage_gap_count}.`, '', '| Feature | ' + kinds.join(' | ') + ' |', '|---|' + kinds.map(() => '---|').join('')]
for (const feature of manifest.features) lines.push('| ' + feature.id + ' | ' + kinds.map(kind => { const row = rows.find(r => r.feature === feature.id && r.kind === kind); return row.status + (row.failure_kind ? ' (not run)' : '') }).join(' | ') + ' |')
lines.push('', '## Failed executed checks', '')
for (const row of tested.filter(c => c.status === 'fail')) lines.push(`- ${row.feature}/${row.kind}: ${row.reason.replace(/\s+/g, ' ')}`)
lines.push('', 'Every fixture was stopped and its temporary root removed. No pre-existing agent sessions or home contents were opened.', '')
writeFileSync(join(reportDir, 'matrix.md'), lines.join('\n'))
console.log(JSON.stringify({ reportDir, summary: report.summary, fixture_summary: report.fixture_summary, coverage_gaps: report.coverage_gap_count }))
// CI/deploy mode tests every server contract, not just the selected green cells.
const gateRows = flags.has('--fixture-only') ? rows.filter(row => manifest.features.find(f => f.id === row.feature).layer === 'server') : rows
if (gateRows.some(row => row.status === 'fail')) process.exitCode = 1
