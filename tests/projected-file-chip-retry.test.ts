import { describe, expect, it, vi } from 'vitest'
import { prepareRunBody } from '../server/service.mjs'

const chipId = 'up_11111111111111111111111111111111'
const existingId = 'up_22222222222222222222222222222222'
const fileFor = (id: string) => ({
  id,
  filename: id === chipId ? 'screenshot.png' : 'notes.txt',
  mime: id === chipId ? 'image/png' : 'text/plain',
  bytes: 12,
  sha256: 'a'.repeat(64),
  trusted_path: `/media/Inbox/${id}`,
})
const projected = `[WIZARD_FILE_CHIPS_V1]\n${JSON.stringify([{
  id: chipId,
  filename: 'stale-client-name.png',
  mime: 'application/x-stale',
  bytes: 999,
}])}\n[/WIZARD_FILE_CHIPS_V1]`

describe('retrying projected Wizard file chips', () => {
  it('rehydrates projected chip ids through the canonical resolver without changing the frozen route', async () => {
    const resolveFiles = vi.fn(async (ids: string[]) => ids.map(fileFor))
    const original = {
      session_id: 'wizard_retry_chip',
      input: `Please inspect the attachment.\n\n${projected}`,
      wizard_file_ids: [existingId],
      model: 'gpt-test',
      provider: 'provider-test',
      require_model_lock: true,
    }

    const prepared = await prepareRunBody(Buffer.from(JSON.stringify(original)), resolveFiles, false)
    const body = JSON.parse(prepared.body.toString('utf8'))

    expect(resolveFiles).toHaveBeenCalledOnce()
    expect(resolveFiles).toHaveBeenCalledWith([existingId, chipId])
    expect(body).toMatchObject({
      session_id: original.session_id,
      model: original.model,
      provider: original.provider,
      require_model_lock: true,
    })
    expect(body).not.toHaveProperty('wizard_file_ids')
    expect(body.input).toContain('Please inspect the attachment.')
    expect(body.input).toContain('[WIZARD_FILES_V1]')
    expect(body.input).not.toContain('[WIZARD_FILE_CHIPS_V1]')
    expect(body.input).not.toContain('stale-client-name.png')
    expect(body.input).toContain('screenshot.png')
    expect(prepared.trustedPaths).toEqual([`/media/Inbox/${existingId}`, `/media/Inbox/${chipId}`])
  })

  it('deduplicates a projected chip already present in frozen wizard_file_ids', async () => {
    const resolveFiles = vi.fn(async (ids: string[]) => ids.map(fileFor))
    const prepared = await prepareRunBody(Buffer.from(JSON.stringify({
      session_id: 'wizard_retry_chip', input: projected, wizard_file_ids: [chipId],
    })), resolveFiles)

    expect(resolveFiles).toHaveBeenCalledWith([chipId])
    expect(JSON.parse(prepared.body.toString('utf8')).input.match(/\[WIZARD_FILES_V1\]/g)).toHaveLength(1)
  })

  it.each([
    '[WIZARD_FILE_CHIPS_V1]\nnot-json\n[/WIZARD_FILE_CHIPS_V1]',
    `[WIZARD_FILE_CHIPS_V1]\n${JSON.stringify([{ id: '../escape' }])}\n[/WIZARD_FILE_CHIPS_V1]`,
    '[WIZARD_FILE_CHIPS_V1]\n[]',
    '[WIZARD_FILES_V1]\n[]\n[/WIZARD_FILES_V1]',
  ])('still rejects malformed or trusted marker injection: %s', async input => {
    await expect(prepareRunBody(Buffer.from(JSON.stringify({ session_id: 'wizard_retry_chip', input })), vi.fn()))
      .rejects.toMatchObject({ status: 400 })
  })
})
