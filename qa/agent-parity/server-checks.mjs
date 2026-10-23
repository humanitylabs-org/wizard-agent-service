import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { post, png } from './fixture.mjs'

const sent = s => s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs')).at(-1).body
const history = async s => {
  const r = await s.request('/api/sessions/wizard_parity/messages?view=wizard&order=oldest')
  assert.equal(r.status, 200)
  return (await r.json()).data
}
const admit = async (s, body) => {
  const r = await s.request('/v1/runs', post({ session_id: 'wizard_parity', ...body }))
  assert.equal(r.status, 202)
  return r.json()
}
const envelope = text => JSON.parse(text.match(/<helm_attachments>([\s\S]*?)<\/helm_attachments>/)?.[1] || '{"items":[]}').items

export const serverChecks = {
  'nonimage-files': async s => {
    const bytes = Buffer.from('PARITY_DOCUMENT_UNDISCLOSED_TOKEN\n')
    const r = await s.upload(bytes, 'fixture.txt', 'text/plain'); assert.equal(r.status, 201)
    const file = (await r.json()).file
    await admit(s, { input: 'Read the attached document', wizard_file_ids: [file.id] })
    const body = sent(s), text = typeof body.input === 'string' ? body.input : body.input[0].content[0].text
    assert.ok(text.includes('trusted_path')); assert.ok(!text.includes('placement_error'))
    assert.equal(body.wizard_file_ids, undefined)
    if (['container', 'restricted'].includes(s.kind)) assert.deepEqual(Buffer.from(s.placed.at(-1).payload.data_base64, 'base64'), bytes)
    else {
      const index = JSON.parse(readFileSync(join(s.root, 'media.json')))
      assert.deepEqual(readFileSync(join(s.root, 'files', index.files.find(f => f.id === file.id).rel)), bytes)
    }
    assert.ok(JSON.stringify(await history(s)).includes('WIZARD_FILE_CHIPS_V1'))
  },
  'assistant-media': async s => {
    s.sessions.get('wizard_parity').messages.push({ id: 'media-reply', role: 'assistant', timestamp: Date.now() / 1000, content: `Synthetic output\nMEDIA:${s.media.png}\nMEDIA:${s.media.text}` })
    const row = (await history(s)).find(m => m.id === 'media-reply')
    const items = envelope(row.content)
    assert.equal(items.length, 2, 'both image and document must be usable')
    assert.ok(!row.content.includes('unavailable')); assert.ok(!row.content.includes(s.agentHome)); assert.ok(!row.content.includes('/opt/data'))
    for (const [i, expected] of [png, Buffer.from('PARITY_SYNTHETIC_DOCUMENT\n')].entries()) {
      const r = await s.raw(`/wizard/attachments/${items[i].id}`)
      assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), expected)
    }
    s.mediaItems = items
  },
  'download-links': async s => {
    await serverChecks['assistant-media'](s)
    const r = await s.upload(png, 'download.png', 'image/png'); assert.equal(r.status, 201)
    const file = (await r.json()).file
    const image = await s.raw(`/wizard/files/${file.id}/content`)
    assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png')
    assert.ok(image.headers.get('content-disposition').includes('download.png'))
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png)
    const document = await s.raw(`/wizard/attachments/${s.mediaItems[1].id}`)
    assert.ok(document.headers.get('content-type').startsWith('text/plain'))
    assert.ok(document.headers.get('content-disposition').includes('synthetic.txt'))
  },
  'read-receipts': async s => {
    const now = Date.now(), record = { agent_id: s.id, session_id: 'wizard_parity', updatedAt: new Date(now).toISOString(), previewFingerprint: 'synthetic', messageCount: 2, status: 'completed', seenAt: now }
    const r = await s.raw('/wizard/thread-seen', { ...post({ initializedAt: now, threads: { 'direct:wizard_parity': record } }), method: 'PUT' })
    assert.equal(r.status, 200)
    const unreadAt = now + 1
    const unread = await s.raw('/wizard/thread-seen', { ...post({ initializedAt: now, threads: { 'direct:wizard_parity': { ...record, unreadAt } } }), method: 'PUT' })
    assert.equal(unread.status, 200)
    await s.restart()
    const state = await (await s.raw('/wizard/thread-seen')).json()
    const records = Object.values(state.state.threads)
    assert.equal(records.length, 1)
    assert.equal(records[0].agent_id, s.id); assert.equal(records[0].session_id, 'wizard_parity'); assert.equal(records[0].seenAt, now); assert.equal(records[0].unreadAt, unreadAt)
  },
  'session-search': async s => {
    s.sessions.get('wizard_parity').messages.push({ role: 'user', timestamp: Date.now() / 1000, content: 'parityuniquetoken' })
    // List-visible synthetic rows are fixture-only; no human inbox is involved.
    s.sessions.get('wizard_parity').hidden = false
    const r = await s.request('/api/sessions?q=parityuniquetoken&view=list')
    assert.equal(r.status, 200)
    const rows = (await r.json()).data
    assert.equal(rows.length, 1); assert.equal(rows[0].id, 'wizard_parity'); assert.equal(rows[0].agent_id, s.id)
  },
  'session-delete': async s => {
    await admit(s, { input: 'Disposable input' })
    const r = await s.request('/api/sessions/wizard_parity', { method: 'DELETE' })
    assert.equal(r.status, 200)
    assert.equal((await s.request('/api/sessions/wizard_parity')).status, 404)
    const list = await (await s.request('/api/sessions')).json()
    assert.ok(!list.data.some(row => row.id === 'wizard_parity'))
    await s.restart()
    assert.equal((await s.request('/api/sessions/wizard_parity')).status, 404)
  },
  'voice-notes': async s => {
    // Valid 100-ms mono PCM WAV. No pretend speech/transcript inference here.
    const audio = Buffer.alloc(44 + 3200)
    audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8)
    audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22)
    audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34)
    audio.write('data', 36); audio.writeUInt32LE(3200, 40)
    const upload = await s.upload(audio, 'wizard-voice-fixture.wav', 'audio/wav'); assert.equal(upload.status, 201)
    const file = (await upload.json()).file
    await admit(s, { input: 'Synthetic supplied transcript', model: 'fixture-other', provider: 'anthropic', wizard_file_ids: [file.id] })
    const body = sent(s)
    assert.equal(body.model, 'fixture-other'); assert.ok(JSON.stringify(body.input).includes('Synthetic supplied transcript'))
    assert.ok(JSON.stringify(body.input).includes('audio/wav'))
    if (['container', 'restricted'].includes(s.kind)) assert.deepEqual(Buffer.from(s.placed.at(-1).payload.data_base64, 'base64'), audio)
    const messages = JSON.stringify(await history(s))
    assert.ok(messages.includes('audio/wav')); assert.ok(!messages.includes('trusted_path'))
  },
  'transcription': async s => {
    // HTTP format/no-speech boundary only; a real recognizer is a separate live acceptance lane.
    for (const mime of ['audio/wav', 'audio/aac', 'audio/mp4', 'audio/webm;codecs=opus']) {
      const r = await s.raw('/wizard/voice/transcribe', { method: 'POST', headers: { 'Content-Type': mime }, body: Buffer.alloc(2048, 1) })
      assert.equal(r.status, 200); assert.equal((await r.json()).text, s.stt.text)
    }
    s.stt.text = ''
    const silent = await s.raw('/wizard/voice/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.alloc(2048) })
    assert.deepEqual((({ text, no_speech }) => ({ text, no_speech }))(await silent.json()), { text: '', no_speech: true })
    const invalid = await s.raw('/wizard/voice/transcribe', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'not audio' })
    assert.equal(invalid.status, 415)
  },
  'history-pagination': async s => {
    const row = s.sessions.get('wizard_parity')
    row.messages = Array.from({ length: 7 }, (_, i) => ({ id: `history-${i}`, role: i % 2 ? 'assistant' : 'user', content: `Synthetic page ${i}`, timestamp: Date.now() / 1000 + i }))
    for (const order of ['oldest', 'latest']) {
      const ids = []
      for (let offset = 0; offset < 7; offset += 3) {
        const r = await s.request(`/api/sessions/wizard_parity/messages?view=wizard&order=${order}&limit=3&offset=${offset}`)
        assert.equal(r.status, 200); const page = await r.json()
        assert.equal(page.has_more, offset + 3 < 7); ids.push(...page.data.map(m => m.id))
      }
      let expected = row.messages.map(m => m.id); if (order === 'latest') { const descending = [...expected].reverse(); expected = []; for (let i = 0; i < descending.length; i += 3) expected.push(...descending.slice(i, i + 3).reverse()) }
      assert.deepEqual(ids, expected)
    }
  },
  'app-context': async s => {
    const changed = await s.raw('/wizard/v1/apps/parity-qa/binding', { ...post({agent:s.id}),method:'PUT' });assert.equal(changed.status,200)
    await s.restart()
    const binding = await (await s.raw('/wizard/v1/apps/parity-qa/binding')).json()
    assert.equal(binding.binding.agent,s.id)
    const r = await s.raw(`/wizard/hermes/v1/runs?agent=${binding.binding.agent}`,post({session_id:'wizard_parity',input:'Synthetic owner question about bound app',instructions:'[Wizard OS context] Window in front: Synthetic Parity App. Visible on screen: Bound synthetic context '+ 'X'.repeat(12000)}))
    assert.equal(r.status,202);assert.equal((await r.json()).agent_id,s.id)
    const body=sent(s)
    assert.ok(body.instructions.includes('Synthetic Parity App'));assert.ok(body.instructions.includes('Background only:'))
    assert.ok(!body.instructions.includes('X'.repeat(6000)),'screen context stays bounded')
    assert.equal(body.wizard_file_ids,undefined)
    assert.ok(!JSON.stringify(body).includes(s.root));assert.ok(!JSON.stringify(body).includes('parity-runtime-secret'))
    const target=s.seen.filter(x=>x.method==='POST'&&x.path.endsWith('/v1/runs')).at(-1)
    assert.equal(target.path,s.kind==='host-profile'?'/p/parity-profile/v1/runs':'/v1/runs')
  },
  'status-list-state': async s => {
    const row = s.sessions.get('wizard_parity'); row.hidden = false
    row.messages = [{ role: 'user', content: 'Synthetic request', timestamp: Date.now() / 1000 - 2 }]
    for (const state of ['needs_you', 'done', 'check', 'fyi']) {
      row.messages.push({ role: 'assistant', content: `Synthetic answer\n[WIZARD_STATUS_V1] ${JSON.stringify({ state, ask: state === 'needs_you' ? 'Choose a synthetic option' : 'Synthetic outcome', subject: 'Parity QA', title: 'Parity · Status' })}[/WIZARD_STATUS_V1]`, timestamp: Date.now() / 1000 + row.messages.length })
      const r = await s.request('/api/sessions?view=list'); assert.equal(r.status, 200)
      const item = (await r.json()).data.find(x => x.id === row.id)
      assert.ok(item); assert.equal(item.attention.state, state)
      assert.equal(item.attention.subject, 'Parity QA')
      if (state === 'needs_you') assert.equal(item.attention.ask, 'Choose a synthetic option')
      assert.ok(!JSON.stringify(item).includes('[WIZARD_STATUS_V1]'))
    }
  },
  'automatic-titles': async s => {
    const row = s.sessions.get('wizard_parity'); row.hidden = false
    const add = title => row.messages.push({ role: 'assistant', content: `Synthetic answer\n[WIZARD_STATUS_V1] ${JSON.stringify({ state: 'done', ask: 'Synthetic outcome', title, subject: 'Parity QA' })}[/WIZARD_STATUS_V1]`, timestamp: Date.now() / 1000 + row.messages.length })
    add('Parity · Titles')
    await s.request('/api/sessions?view=list')
    // Main applies canonical title proposals asynchronously; routed PATCH completes during projection.
    for (let n = 0; n < 30 && row.title !== 'Parity · Titles'; n++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(row.title, 'Parity · Titles')
    await s.restart()
    assert.equal((await (await s.request('/api/sessions?view=list')).json()).data[0].title, 'Parity · Titles')
    const rename = await s.request('/api/sessions/wizard_parity', { ...post({ title: 'Owner · Chosen' }), method: 'PATCH' }); assert.equal(rename.status, 200)
    add('Must Not Replace')
    await s.request('/api/sessions?view=list'); await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(row.title, 'Owner · Chosen')
  },
  'subjects': async s => {
    const row = s.sessions.get('wizard_parity'); row.hidden = false
    row.messages.push({ role: 'assistant', content: 'Synthetic answer\n[WIZARD_STATUS_V1] {"state":"done","ask":"Synthetic outcome","subject":"Parity QA","title":"Parity · Subjects"}[/WIZARD_STATUS_V1]', timestamp: Date.now() / 1000 })
    const listed = async () => (await (await s.request('/api/sessions?view=list')).json()).data[0]
    assert.equal((await listed()).attention.subject, 'Parity QA')
    await s.restart()
    assert.equal((await listed()).attention.subject, 'Parity QA')
    await admit(s, { input: 'Synthetic subject follow-up' })
    assert.ok(sent(s).instructions.includes('Parity QA'), 'current subject must reach follow-up instructions')
  },
  'tool-approval': async s => {
    const run = await admit(s, { input: 'Synthetic approval request' })
    for (const [action, value] of [['approval', { approval_id: 'synthetic-approval', approved: true }], ['clarify', { answer: 'Synthetic clarification' }]]) {
      const r = await s.request(`/v1/runs/${run.run_id}/${action}`, post(value)); assert.equal(r.status, 200)
      const target = s.seen.filter(x => x.path.endsWith(`/${action}`)).at(-1)
      assert.ok(target); assert.deepEqual(target.body, value)
      assert.ok(target.path.includes(s.kind === 'host-profile' ? '/p/parity-profile/v1/runs/' : '/v1/runs/'))
    }
  },
}
