import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scene, post, kinds } from '../qa/agent-parity/fixture.mjs'
import { REPLY_BUTTONS_SWITCH, REPLY_BUTTONS_INSTRUCTIONS, replyButtonsNote } from '../server/reply-buttons.mjs'

// Tap-to-answer buttons inside agent replies (wizard-ux issue 1889, switch wizard/reply-buttons in the owner's Look
// file, off by default). While the switch is on, the actual upstream run of the main agent and of every routed kind
// (host-profile, container, restricted) carries the one buttons note; off, nothing changes. Read at runtime, no restart.
const NAMED_ROW_RULES = ['directly under the item or question it decides, never collected together at the end of the reply', 'One decision per group', 'never "Item 1", "Q2"', 'Labels say the outcome', '"Turn it on" / "Drop it" / "Test first"', 'make sense on its own', '("All four") instead of repeating identical rows']
const runs = (s: any) => s.seen.filter((r: any) => r.method === 'POST' && r.path.endsWith('/v1/runs'))
const look = (s: any, on: boolean | null) => {
  const dir = join(s.root, 'Pages', 'wizard-look'); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'look.json'), JSON.stringify({ version: 1, skin: null, tweaks: on === null ? {} : { [REPLY_BUTTONS_SWITCH]: { on, at: Date.now() } } }))
}

describe('reply buttons: the agent is told only while the switch is on', () => {
  it('the note names the marker, 1 to 6 buttons, and the taps message', () => {
    expect(REPLY_BUTTONS_SWITCH).toBe('wizard/reply-buttons')
    for (const part of ['[WIZARD_BUTTONS_V1]{"group":', '"buttons":[{"id":', '1 to 6 buttons', 'Tapped Turn it on · Smart inbox switch', '[WIZARD_TAPS_V1]', 'arrive together']) expect(REPLY_BUTTONS_INSTRUCTIONS).toContain(part)
  })
  it('every row explains itself: one named group directly under its item, outcome labels, a two-item example (issue 696)', () => {
    for (const rule of NAMED_ROW_RULES) expect(REPLY_BUTTONS_INSTRUCTIONS).toContain(rule)
    // The example: two items, each followed by its own group, not the groups stacked at the end.
    const lines = REPLY_BUTTONS_INSTRUCTIONS.split('\n')
    const at = lines.indexOf('Example with two items, each followed by its own group:')
    expect(at).toBeGreaterThan(-1)
    const ex = lines.slice(at + 1, at + 5)
    expect(ex.map(l => l.startsWith('[WIZARD_BUTTONS_V1]'))).toEqual([false, true, false, true])
    const groups = ex.filter(l => l.startsWith('[WIZARD_BUTTONS_V1]')).map(l => JSON.parse(l.slice('[WIZARD_BUTTONS_V1]'.length, -'[/WIZARD_BUTTONS_V1]'.length)))
    expect(groups.map(g => g.group)).toEqual(['Smart inbox switch', 'Typed messages go quiet'])
    for (const g of groups) for (const b of g.buttons) expect(b.label).not.toMatch(/^(yes|no|approve|decline)$/i)
    expect(replyButtonsNote(() => true)).toBe(REPLY_BUTTONS_INSTRUCTIONS)
    expect(replyButtonsNote(() => false)).toBe('')
    expect(replyButtonsNote(() => { throw new Error('unreadable') })).toBe('')
  })
  for (const kind of kinds) it(`main and routed runs alike, no restart / ${kind}`, async () => {
    const s: any = await scene(kind, ({ root }: any) => ({ pagesRoot: join(root, 'Pages'), pagesGitDir: join(root, 'pages-history.git'), pagesWatch: false, replyButtonsTtlMs: 0 }))
    try {
      let n = 0
      const send = async (input: string) => {
        const id = `wizard_buttons_${++n}`, before = runs(s).length // a fresh thread each time: the last run may still be going
        expect((await s.request('/api/sessions', post({ id, source: 'wizard-mobile', hidden: true }))).status).toBe(201)
        expect((await s.request('/v1/runs', post({ session_id: id, input }))).status).toBe(202)
        expect(runs(s).length).toBe(before + 1)
        return String(runs(s).at(-1).body.instructions || '')
      }
      expect(await send('no Look file')).not.toContain('Reply buttons are on')
      look(s, false)
      expect(await send('switch off')).not.toContain('Reply buttons are on')
      look(s, true)
      const on = await send('switch on')
      expect(on).toContain(REPLY_BUTTONS_INSTRUCTIONS)
      for (const rule of NAMED_ROW_RULES) expect(on).toContain(rule)
      look(s, false)
      const off = await send('switch off again')
      for (const rule of NAMED_ROW_RULES) expect(off).not.toContain(rule)
      look(s, null)
      expect(await send('switch removed')).not.toContain('Reply buttons are on')
    } finally { await s.close() }
  }, 30_000)
})
