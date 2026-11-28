import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scene, post, kinds } from '../qa/agent-parity/fixture.mjs'
import { QUICK_LINKS_INSTRUCTIONS, quickLinksNote } from '../server/quick-links.mjs'

// New chat quick links (wizard-ux issue 1965, on for everyone; the Look-file switch wizard/new-chat-chips was removed).
// The actual upstream run of the main agent and of every routed kind (host-profile, container, restricted) carries the
// one note on how to answer "What's waiting on me?" and "Plan my day", whatever an older Look file still says.
const runs = (s: any) => s.seen.filter((r: any) => r.method === 'POST' && r.path.endsWith('/v1/runs'))
const look = (s: any, on: boolean | null) => {
  const dir = join(s.root, 'Pages', 'wizard-look'); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'look.json'), JSON.stringify({ version: 1, skin: null, tweaks: on === null ? {} : { 'wizard/new-chat-chips': { on, at: Date.now() } } }))
}

describe('new chat quick links: every agent is told how to answer them', () => {
  it('the note answers the two chips the way the issue asks', () => {
    for (const part of ['"What\'s waiting on me?"', 'only the things blocked on them', 'decisions, approvals, missing info', 'one link', 'If nothing is waiting, say so in one line',
      '"Plan my day"', 'one short plan for today', 'calendar', 'tasks', 'anything waiting on them']) expect(QUICK_LINKS_INSTRUCTIONS).toContain(part)
    expect(quickLinksNote()).toBe(QUICK_LINKS_INSTRUCTIONS)
  })
  for (const kind of kinds) it(`main and routed runs alike, whatever the Look file says / ${kind}`, async () => {
    const s: any = await scene(kind, ({ root }: any) => ({ pagesRoot: join(root, 'Pages'), pagesGitDir: join(root, 'pages-history.git'), pagesWatch: false }))
    try {
      let n = 0
      const send = async (input: string) => {
        const id = `wizard_quick_${++n}`, before = runs(s).length
        expect((await s.request('/api/sessions', post({ id, source: 'wizard-mobile', hidden: true }))).status).toBe(201)
        expect((await s.request('/v1/runs', post({ session_id: id, input }))).status).toBe(202)
        expect(runs(s).length).toBe(before + 1)
        return String(runs(s).at(-1).body.instructions || '')
      }
      expect(await send('Plan my day')).toContain(QUICK_LINKS_INSTRUCTIONS)
      look(s, false)
      expect(await send("What's waiting on me?")).toContain(QUICK_LINKS_INSTRUCTIONS)
      look(s, true)
      expect(await send("What's waiting on me?")).toContain(QUICK_LINKS_INSTRUCTIONS)
      look(s, null)
      expect(await send('Plan my day')).toContain(QUICK_LINKS_INSTRUCTIONS)
    } finally { await s.close() }
  }, 30_000)
})
