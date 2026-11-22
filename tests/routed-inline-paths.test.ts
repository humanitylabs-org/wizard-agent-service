// Issue 581: a routed agent that writes a file in its own home as a plain path (no MEDIA line) used to leave the
// owner a bare "[private attachment]" label. A supported file now becomes the same card a MEDIA line gives; anything
// else reads "[file: <name> not sent: ask the agent to send it]". The raw path never reaches the client.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectRoutedAgentMedia, projectRoutedInlinePaths, routedInlinePaths } from '../server/service.mjs'
import { agentReadablePaths, projectPrivateFilePaths } from '../server/private-file-projection.mjs'

const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const payload = (content: string, role = 'assistant') => Buffer.from(JSON.stringify({ data: [{ id: 1, role, content }] }))
const rows = (result: Buffer) => JSON.parse(result.toString('utf8')).data
const items = (content: string) => [...content.matchAll(/<helm_attachments>(.*?)<\/helm_attachments>/gs)].flatMap(m => JSON.parse(m[1]).items)

function box(kind: 'container' | 'profile') {
  const base = mkdtempSync(join(tmpdir(), 'routed-inline-'))
  const home = join(base, 'home')
  mkdirSync(join(home, 'cache/images'), { recursive: true })
  mkdirSync(join(home, 'work/ranked'), { recursive: true })
  mkdirSync(join(home, 'transcripts'), { recursive: true })
  mkdirSync(join(home, 'inbox/2026-11-20'), { recursive: true })
  writeFileSync(join(home, 'cache/images/report.png'), png)
  writeFileSync(join(home, 'work/ranked/candidates.csv'), 'rank,name\n1,a\n')
  writeFileSync(join(home, 'work/ranked/tool.exe'), 'MZ')
  writeFileSync(join(home, 'inbox/2026-11-20/upload.pdf'), '%PDF-1.4\n')
  const root = kind === 'container' ? '/opt/data' : home
  const media = { home, artifactDir: join(base, 'wizard-artifacts'), ...(kind === 'container' ? { containerRoot: '/opt/data' } : {}) }
  // As projectAgentHistory in service.mjs: MEDIA lines, then plain paths, then the private-path redaction.
  const show = (content: string, filesAllowed = true) => {
    const agent = { id: 'research' }
    let result = projectRoutedAgentMedia(payload(content), media)
    result = projectRoutedInlinePaths(result, media, { filesAllowed, skip: agentReadablePaths(agent, home).map(e => e.root) })
    const roots = [home, '/opt/data']
    const projected = projectPrivateFilePaths(result, roots, { readable: agentReadablePaths(agent, home) })
    expect(roots.some(r => projected.includes(Buffer.from(r))), 'no raw home path reaches the client').toBe(false)
    return rows(projected)[0].content as string
  }
  return { root, home, show, media }
}

for (const kind of ['container', 'profile'] as const) {
  describe(`${kind}: a plain path into the agent's own home`, () => {
    it('to a picture becomes the same image card a MEDIA line gives, right after its line', () => {
      const { root, show } = box(kind)
      const content = show(`Chart: \`${root}/cache/images/report.png\`\nNext line.`)
      expect(items(content).map((i: any) => [i.name, i.kind])).toEqual([['report.png', 'image']])
      expect(content).not.toContain('[private attachment]')
      expect(content.indexOf('<helm_attachments>')).toBeLessThan(content.indexOf('Next line.'))
      expect(content.startsWith('Chart: `report.png`')).toBe(true)
    })

    it('to a CSV becomes a file card and the sentence keeps only the name', () => {
      const { root, show } = box(kind)
      const content = show(`Full data on disk: all 232 ranked candidates at \`${root}/work/ranked/candidates.csv\`, per-recording transcripts alongside.`)
      expect(items(content).map((i: any) => [i.name, i.kind])).toEqual([['candidates.csv', 'file']])
      expect(content).toContain('all 232 ranked candidates at `candidates.csv`, per-recording transcripts alongside.')
      expect(content).not.toContain('[private attachment]')
    })

    it('without backticks, with sentence punctuation after it', () => {
      const { root, show } = box(kind)
      const content = show(`Saved to ${root}/work/ranked/candidates.csv.`)
      expect(content.split('\n')[0]).toBe('Saved to candidates.csv.')
      expect(items(content)).toHaveLength(1)
    })

    it('a file name with spaces in backticks is one path; a command in backticks keeps its words', () => {
      const { root, home, show } = box(kind)
      writeFileSync(join(home, 'work/ranked/my file.csv'), 'a\n')
      const spaced = show(`Here: \`${root}/work/ranked/my file.csv\` done.`)
      expect(items(spaced).map((i: any) => i.name)).toEqual(['my file.csv'])
      expect(spaced.split('\n')[0]).toBe('Here: `my file.csv` done.')
      const command = show(`Run \`head ${root}/work/ranked/candidates.csv -n 3\``)
      expect(command.split('\n')[0]).toBe('Run `head candidates.csv -n 3`')
      expect(items(command).map((i: any) => i.name)).toEqual(['candidates.csv'])
    })

    it('a file already sent with MEDIA gets no second card', () => {
      const { root, show } = box(kind)
      const content = show(`See \`${root}/work/ranked/candidates.csv\`\nMEDIA:${root}/work/ranked/candidates.csv`)
      expect(items(content)).toHaveLength(1)
    })

    for (const [what, rel, name] of [
      ['a folder', 'transcripts', 'transcripts'],
      ['a folder with a slash', 'transcripts/', 'transcripts'],
      ['a missing file', 'work/ranked/gone.csv', 'gone.csv'],
      ['an unsupported type', 'work/ranked/tool.exe', 'tool.exe'],
      ['a parent hop out of the home', 'work/../../outside.csv', 'outside.csv'],
    ] as const) {
      it(`${what} reads "not sent" with only the name`, () => {
        const { root, show } = box(kind)
        const content = show(`Here: \`${root}/${rel}\` and more.`)
        expect(content).toBe(`Here: [file: ${name} not sent: ask the agent to send it] and more.`)
        expect(items(content)).toEqual([])
      })
    }

    it('with permissions.files none nothing is sent', () => {
      const { root, show } = box(kind)
      const content = show(`At \`${root}/work/ranked/candidates.csv\` and \`${root}/cache/images/report.png\``, false)
      expect(content).toBe('At [file: candidates.csv not sent: ask the agent to send it] and [file: report.png not sent: ask the agent to send it]')
    })

    it('owner inbox files keep their own label, code blocks and user turns are left alone', () => {
      const { root, show } = box(kind)
      expect(show(`Your upload \`${root}/inbox/2026-11-20/upload.pdf\``)).toBe('Your upload `[private attachment: upload.pdf]`')
      const fenced = show('```\ncat ' + root + '/work/ranked/candidates.csv\n```')
      expect(items(fenced)).toEqual([])
      expect(fenced).toContain('[private attachment]')
    })
  })
}

describe('restricted homes are read through the mirror', () => {
  it('routedInlinePaths lists container paths written in assistant text, not in user turns or code blocks', () => {
    const text = 'At `/opt/data/work/a.csv`, and /opt/data/cache/images/b.png. Inbox /opt/data/inbox/2026-11-20/x.pdf\n```\n/opt/data/c.md\n```'
    expect(routedInlinePaths(payload(text), '/opt/data', { skip: ['/opt/data/inbox'] })).toEqual(['/opt/data/work/a.csv', '/opt/data/cache/images/b.png'])
    expect(routedInlinePaths(payload(text, 'user'), '/opt/data')).toEqual([])
    expect(routedInlinePaths(payload('See `/opt/data/work/my file.csv`'), '/opt/data')).toContain('/opt/data/work/my file.csv')
  })

  it('an unreadable home resolves the path from the mirror copy', () => {
    const base = mkdtempSync(join(tmpdir(), 'routed-inline-mirror-'))
    const mirror = join(base, 'mirror')
    mkdirSync(join(mirror, 'work'), { recursive: true })
    writeFileSync(join(mirror, 'work/a.csv'), 'a\n')
    const media = { home: join(base, 'missing-home'), artifactDir: join(base, 'artifacts'), containerRoot: '/opt/data', mirror }
    const content = rows(projectRoutedInlinePaths(payload('Data: `/opt/data/work/a.csv`'), media))[0].content
    expect(items(content).map((i: any) => i.name)).toEqual(['a.csv'])
  })
})
