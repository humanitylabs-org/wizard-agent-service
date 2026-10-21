#!/usr/bin/env node
// Offline only: pass every directory containing a pair migration inventory.
import { restoreStoreSet } from '../server/store-migration.mjs'
const args = process.argv.slice(2)
if (args[0] !== '--service-stopped' || args.length < 2) {
  console.error('Usage: node scripts/restore-agent-pairs.mjs --service-stopped STORE_DIRECTORY [STORE_DIRECTORY ...]')
  process.exitCode = 2
} else {
  try {
    const paths = restoreStoreSet(args.slice(1), { serviceStopped: true })
    console.log(JSON.stringify({ restored_stores: paths.length }))
  } catch (error) { console.error(error.message); process.exitCode = 2 }
}
