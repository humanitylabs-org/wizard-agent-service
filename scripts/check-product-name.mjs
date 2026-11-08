#!/usr/bin/env node
// Fails when tracked text spells the product as two words. It is WizardOS, one word, always (James, 8 Nov 2026).
// The lowercase identifier wizard-os (repo, paths, ids) is fine; display spellings with a space or a hyphen are not.
// Usage: node scripts/check-product-name.mjs [paths...]   (default: every tracked file)
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { misspellsProductName } from '../server/product-name.mjs'

// Historical evidence records are kept exactly as captured.
const SKIP = [/^ops\/evidence\//u, /^node_modules\//u, /(^|\/)package-lock\.json$/u]
const files = process.argv.length > 2 ? process.argv.slice(2)
  : execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
const hits = []
for (const file of files) {
  if (SKIP.some((pattern) => pattern.test(file))) continue
  let text
  try { if (statSync(file).size > 4 * 1024 * 1024) continue; text = readFileSync(file, 'utf8') } catch { continue }
  if (text.includes('\u0000')) continue
  text.split('\n').forEach((line, index) => { if (misspellsProductName(line)) hits.push(`${file}:${index + 1}: ${line.trim().slice(0, 160)}`) })
}
if (hits.length) {
  console.error(`The product name is WizardOS, one word. Respell these ${hits.length} line(s):\n${hits.join('\n')}`)
  process.exit(1)
}
console.log(`product name: ${files.length} files checked, WizardOS spelled as one word everywhere`)
