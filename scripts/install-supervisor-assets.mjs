#!/usr/bin/env node
// Explicit release step for host/main Hermes homes; never discovers or edits other profiles.
import { resolve, join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { installSupervisorAssets } from '../server/supervisor-assets.mjs'
const args = process.argv.slice(2)
const homeArg = args.indexOf('--hermes-home')
if (homeArg < 0 || !args[homeArg+1] || args.some((a,i) => !['--hermes-home','--attach-cron-reporter'].includes(a) && i !== homeArg+1)) {
  console.error('Usage: node scripts/install-supervisor-assets.mjs --hermes-home <explicit home> [--attach-cron-reporter]')
  process.exit(2)
}
const home = resolve(args[homeArg+1])
const installed = installSupervisorAssets(home)
let cronAttached = 0
if (args.includes('--attach-cron-reporter')) {
  const path = join(home,'cron/jobs.json')
  if (existsSync(path)) {
    const raw = readFileSync(path,'utf8'), data = JSON.parse(raw)
    const jobs = Array.isArray(data) ? data : data.jobs
    if (!Array.isArray(jobs)) throw Error('Invalid cron jobs list; refusing to replace it')
    for (const job of jobs) {
      if (!job || typeof job !== 'object' || job.no_agent || job.enabled === false) continue
      const skills = [...new Set([...(Array.isArray(job.skills) ? job.skills : []),job.skill].filter(Boolean))]
      if (!skills.includes('reporter')) { job.skills = [...skills,'reporter']; cronAttached++ }
    }
    if (cronAttached) {
      // Preserve a same-home original; the operator stops cron while deploying this explicit change.
      const backup = `${path}.before-reporter`
      if (!existsSync(backup)) writeFileSync(backup, raw, {mode:0o600,flag:'wx'})
      writeFileSync(`${path}.reporter-next`,JSON.stringify(data,null,2)+'\n',{mode:0o600})
      renameSync(`${path}.reporter-next`,path)
    }
  }
}
console.log(JSON.stringify({...installed,cronAttached}))
