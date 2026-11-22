// Issue 580: routed agents were told two different rules for sending a file ("anywhere inside your own home folder"
// and "only in cache/images, cache/audio, ..."), so a loosely following model wrote the path instead of sending it.
// The routed instructions now state one rule, and that rule matches what projectRoutedAgentMedia really accepts.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_RUN_INSTRUCTIONS, agentRunInstructions } from '../server/agents-http.mjs'
import { ROUTED_CHAT_MEDIA_INSTRUCTIONS, WIZARD_CHAT_MEDIA_INSTRUCTIONS } from '../server/chat-presentation.mjs'
import { projectRoutedAgentMedia } from '../server/service.mjs'
import { withAskMax } from '../server/thread-status.mjs'

const folderRules = (text: string) => text.match(/[^.;]*(?:only when the file sits|inside your own home folder|save it inside|copy it into your own cache)[^.;]*/g) ?? []

const routedVariants = {
  'AGENT_RUN_INSTRUCTIONS': AGENT_RUN_INSTRUCTIONS,
  'agentRunInstructions()': agentRunInstructions('own'),
  // agent-heavy-relay.mjs sends withAskMax(agentRunInstructions(style), askMax()).
  'heavy relay': withAskMax(agentRunInstructions('own'), 140),
}

describe('routed agents get one file-sending rule', () => {
  it('the heavy relay builds its instructions from agentRunInstructions', () => {
    const relay = readFileSync(new URL('../server/agent-heavy-relay.mjs', import.meta.url), 'utf8')
    expect(relay).toMatch(/instructions: \[withAskMax\(agentRunInstructions\(/)
  })

  for (const [name, text] of Object.entries(routedVariants)) {
    it(`${name} states the folder rule once, with no contradicting folder list`, () => {
      expect(folderRules(text)).toHaveLength(1)
      expect(text.match(/only when the file sits/g)).toHaveLength(1)
      // Never both the home rule and the main agent's cache-folder rule.
      expect(text).toContain('inside your own home folder')
      expect(text).not.toMatch(/cache\/(?:images|audio|videos|screenshots)/)
      expect(text).not.toContain(WIZARD_CHAT_MEDIA_INSTRUCTIONS)
      expect(text).toContain(ROUTED_CHAT_MEDIA_INSTRUCTIONS)
      expect(text.split('MEDIA:/absolute/path on its own line').length - 1).toBe(1)
      expect(text).toMatch(/a path written in your text, even in backticks, is not sent/)
      expect(text).toMatch(/Pictures over 5 MB do not show/)
      expect(text).toMatch(/up to 256 MB in your home/)
      expect(text).toContain('/opt/data')
    })
  }

  it('the main agent keeps its own cache-folder rule', () => {
    expect(WIZARD_CHAT_MEDIA_INSTRUCTIONS).toContain('copy it into your own cache/images first')
    expect(WIZARD_CHAT_MEDIA_INSTRUCTIONS).not.toContain('inside your own home folder')
    expect(WIZARD_CHAT_MEDIA_INSTRUCTIONS.match(/only when the file sits/g)).toHaveLength(1)
  })
})

describe('the rule matches what a routed agent can really send', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
  const payload = (content: string) => Buffer.from(JSON.stringify({ data: [{ id: 1, role: 'assistant', content }] }))
  const rows = (result: Buffer) => JSON.parse(result.toString('utf8')).data
  const items = (content: string) => [...content.matchAll(/<helm_attachments>(.*?)<\/helm_attachments>/gs)].flatMap(m => JSON.parse(m[1]).items)

  // The rule says: any folder inside your own home, which is /opt/data in a container.
  const sent = [
    ['home root', 'ranked.csv', 'a,b\n1,2\n'],
    ['a folder of the agent\'s own', 'work/results/ranked candidates.md', '# 232 ranked\n'],
    ['a deep folder', 'projects/a/b/c/report.pdf', '%PDF-1.4\n'],
    ['cache/images', 'cache/images/chart.png', png],
    ['cache/audio', 'cache/audio/note.mp3', 'ID3fake'],
  ] as const

  for (const kind of ['container', 'profile'] as const) {
    it(`${kind}: a MEDIA line for a file in each named place becomes a file card`, () => {
      const base = mkdtempSync(join(tmpdir(), 'routed-media-rule-'))
      const home = join(base, 'home')
      for (const [, rel, bytes] of sent) {
        mkdirSync(join(home, rel, '..'), { recursive: true })
        writeFileSync(join(home, rel), bytes)
      }
      writeFileSync(join(base, 'outside.md'), 'OUTSIDE')
      const root = kind === 'container' ? '/opt/data' : home
      const media = { home, artifactDir: join(base, 'wizard-artifacts'), ...(kind === 'container' ? { containerRoot: '/opt/data' } : {}) }
      for (const [where, rel] of sent) {
        const content = rows(projectRoutedAgentMedia(payload(`Here it is.\n\nMEDIA:${root}/${rel}`), media))[0].content
        expect(content, where).not.toContain('unavailable')
        expect(items(content).map((i: any) => i.name), where).toEqual([rel.split('/').at(-1)])
      }
      const outside = rows(projectRoutedAgentMedia(payload(`MEDIA:${join(base, 'outside.md')}`), media))[0].content
      expect(outside).toContain('[file: outside.md unavailable]')
      // A path only written in the text is not sent.
      const bare = rows(projectRoutedAgentMedia(payload(`All 232 at \`${root}/ranked.csv\``), media))[0].content
      expect(items(bare)).toEqual([])
    })
  }
})
