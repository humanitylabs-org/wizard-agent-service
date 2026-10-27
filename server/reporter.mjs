import { parseStatus } from './thread-status.mjs'

export const REPORTER_INSTRUCTIONS = `Reporter format (overrides the general reply guidance for this scheduled reply):
First line: the point, in bold, as one plain sentence.
Then only labels that have something to say: **What happened:** (1–3 sentences), **What you need to do:** (one action, only if needed), **Still open:** (at most 2 bullets).
At most 120 words excluding the status line. Plain words: no PR, issue or version numbers, branch, job or file names; no team jargon (lane, gate, waive, receipt, cutover, soak, parity, unblock).
End with a valid [WIZARD_STATUS_V1]{"state":"fyi","ask":"Plain outcome"}[/WIZARD_STATUS_V1] line. If nothing is worth the owner's attention, write exactly [SILENT].
For report=digest, keep the content body (it is the product); still open with the bold point, use plain words and end with the status line.`

const marker = /\[WIZARD_STATUS_V1\][\s\S]*?\[\/WIZARD_STATUS_V1\]/g
const jargon = /\b(?:lanes?|gates?|waiv(?:e|ed|er|ers)|receipts?|cutovers?|soaks?|parity|unblock(?:ed|ing)?|PR\s*#?\s*\d+|issue\s*#?\s*\d+)\b|\b(?:feat|feature|fix|release|integration|docs|spec)\/[^\s]+|\b[0-9a-f]{7,40}\b|\bv?\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/gi

export const reportJargon = text => [...String(text).matchAll(jargon)].map(m => m[0])

/** One deterministic checker for scheduled replies and (later) script alerts. */
export function lintReport(text, { kind = 'status' } = {}) {
  const reasons = []
  if (typeof text !== 'string') return { ok: false, reasons: ['report must be text'] }
  text = text.trim()
  if (text === '[SILENT]') return { ok: true, reasons: [] }
  if (!['status', 'digest'].includes(kind)) reasons.push('report kind must be status or digest')
  const lines = text.split(/\r?\n/)
  if (!/^\*\*[^*\n]+[.!?]\*\*$/.test(lines[0] || '') || /[.!?]\s+\S/.test((lines[0] || '').slice(2, -2))) reasons.push('open with one bold sentence')
  const last = lines.at(-1) || ''
  if (!/^\[WIZARD_STATUS_V1\].*\[\/WIZARD_STATUS_V1\]$/.test(last) || !parseStatus(last) || (text.match(marker) || []).length !== 1) reasons.push('end with one valid status line')
  const body = text.replace(marker, '').trim()
  if (kind === 'status') {
    if (body.split(/\s+/).filter(Boolean).length > 120) reasons.push('keep the body within 120 words')
    const allowed = ['What happened:', 'What you need to do:', 'Still open:']
    const labels = []
    for (const match of lines.slice(1, -1).join('\n').matchAll(/\*\*([^*\n]+)\*\*/g)) {
      labels.push(match[1])
      if (!allowed.includes(match[1])) reasons.push(`label not allowed: ${match[1]}`)
    }
    if (new Set(labels).size !== labels.length) reasons.push('use each report label at most once')
    if (/^\s*#{1,6}\s/m.test(body)) reasons.push('use the report labels, not headings')
    const open = body.split('**Still open:**')[1]?.split(/\n\*\*(?:What happened|What you need to do):\*\*/)[0] || ''
    if ((open.match(/^\s*(?:[-*•]|\d+[.)])\s/gm) || []).length > 2) reasons.push('Still open has at most two bullets')
  }
  const found = reportJargon(body)
  const status = parseStatus(last)
  const askJargon = reportJargon(status?.ask || '')
  if (found.length || askJargon.length) reasons.push(`replace internal words or identifiers: ${[...new Set([...found, ...askJargon])].join(', ')}`)
  return { ok: !reasons.length, reasons }
}
