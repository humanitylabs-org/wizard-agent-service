// James, 6 Nov 2026: "We don't need to limit the number of attachments ... don't impose arbitrary limits on the
// user." A voice note plus Jonathan's install screenshots (more than eight files) failed with "Too many
// attachments including the recording". There is no per-message file COUNT cap anywhere in the Agent Service;
// the real limits are per-file upload size and the inline-image byte budget (images past it go to the agent as
// trusted paths with a vision_analyze note).
import { describe, expect, it, vi } from 'vitest'
import { prepareRunBody, projectWizardFileMarkers } from '../server/service.mjs'
import { parseShareRequest } from '../server/uploads.mjs'

const id = (n: number) => `up_${n.toString(16).padStart(32, '0')}`
const ids = (count: number) => Array.from({ length: count }, (_, i) => id(i + 1))
const fileFor = (fid: string, i: number) => ({
  id: fid,
  filename: i === 0 ? 'wizard-voice-1.webm' : `screenshot-${i}.png`,
  mime: i === 0 ? 'audio/webm' : 'image/png',
  bytes: 12,
  sha256: 'a'.repeat(64),
  trusted_path: `/media/Inbox/${fid}`,
})
const resolver = () => vi.fn(async (list: string[]) => list.map(fileFor))

describe('no per-message attachment count limit', () => {
  it('admits a run with 20 attachments plus the recording (21 wizard_file_ids)', async () => {
    const resolveFiles = resolver()
    const all = ids(21)
    const prepared = await prepareRunBody(Buffer.from(JSON.stringify({
      session_id: 'wizard_many_files', input: 'Jonathan’s install screenshots', wizard_file_ids: all,
      model: 'm', provider: 'p', require_model_lock: true,
    })), resolveFiles, false)
    expect(resolveFiles).toHaveBeenCalledWith(all)
    const body = JSON.parse(prepared.body.toString('utf8'))
    const marker = /\[WIZARD_FILES_V1\]\s*([\s\S]*?)\s*\[\/WIZARD_FILES_V1\]/.exec(body.input)
    expect(marker).not.toBeNull()
    expect(JSON.parse(marker![1])).toHaveLength(21)
    expect(prepared.trustedPaths).toHaveLength(21)
    expect(prepared.audioPaths).toHaveLength(1)
  })

  it('retries projected chips carrying 21 files', async () => {
    const resolveFiles = resolver()
    const chips = ids(21).map((fid, i) => ({ id: fid, filename: `f${i}`, mime: 'image/png', bytes: 12 }))
    const input = `again\n\n[WIZARD_FILE_CHIPS_V1]\n${JSON.stringify(chips)}\n[/WIZARD_FILE_CHIPS_V1]`
    const prepared = await prepareRunBody(Buffer.from(JSON.stringify({ session_id: 'wizard_many_files', input })), resolveFiles)
    expect(resolveFiles).toHaveBeenCalledWith(ids(21))
    expect(prepared.trustedPaths).toHaveLength(21)
  })

  it('projects every file of a 21-file message as chips, none dropped', () => {
    const files = ids(21).map((fid, i) => ({ id: fid, filename: `f${i}.png`, mime: 'image/png', bytes: 12, trusted_path: `/x/${fid}` }))
    const history = JSON.stringify({ messages: [{ role: 'user', content: `hi\n\n[WIZARD_FILES_V1]\n${JSON.stringify(files)}\n[/WIZARD_FILES_V1]` }] })
    const out = JSON.parse(String(projectWizardFileMarkers(Buffer.from(history))))
    const chips = /\[WIZARD_FILE_CHIPS_V1\]\s*([\s\S]*?)\s*\[\/WIZARD_FILE_CHIPS_V1\]/.exec(out.messages[0].content)
    expect(JSON.parse(chips![1]).map((f: { id: string }) => f.id)).toEqual(ids(21))
  })

  it('accepts a share of 12 files', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ filename: `s${i}.png`, mime: 'image/png', bytes: 10 }))
    expect(parseShareRequest({ client_share_id: 'share-many', files }).files).toHaveLength(12)
  })

  it('keeps the real validation: ids must be well-formed and unique', async () => {
    await expect(prepareRunBody(Buffer.from(JSON.stringify({ session_id: 's', input: 'x', wizard_file_ids: [id(1), id(1)] })), vi.fn()))
      .rejects.toMatchObject({ status: 400 })
    await expect(prepareRunBody(Buffer.from(JSON.stringify({ session_id: 's', input: 'x', wizard_file_ids: 'nope' })), vi.fn()))
      .rejects.toMatchObject({ status: 400 })
  })
})
