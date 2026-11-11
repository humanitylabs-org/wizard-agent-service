// Issue 446: Chats Channels posts. view=list rows carry firstRequest (the first owner message, cleaned, at most
// 400 code units) and firstAttachments (its images as file refs), behind WIZARD_CHANNEL_FIRST_POSTS.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { firstPostOf, firstPostOfHistory, readHermesFirstPosts } from '../server/first-post.mjs'
import { listPayload, listRow } from '../server/session-list-view.mjs'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const marker = (files: any[], tag = 'WIZARD_FILES_V1') => `\n\n[${tag}]\n${JSON.stringify(files)}\n[/${tag}]`
const photo = { id: 'file-photo-1', filename: 'garden.png', mime: 'image/png', bytes: 10, trusted_path: '/opt/data/inbox/garden.png' }
const pdf = { id: 'file-doc-1', filename: 'plan.pdf', mime: 'application/pdf', bytes: 10 }
const voice = { id: 'file-voice-1', filename: 'wizard-voice-1.webm', mime: 'audio/webm', bytes: 10, transcript: 'Plant the **roses** first.' }
const row = (id: string, extra: any = {}) => ({ id, title: 'Generated title', preview: 'Hermes 60-char head', updated_at: '2026-11-10T10:00:00Z', ...extra })

describe('firstPostOf', () => {
  it('cleans the owner words: workspace prefix, file and intent markers, the screen note, markdown', () => {
    const content = `[Workspace::v1: /opt/data]\n## Plan **the garden** with \`care\`${marker([photo])}\n\n[WIZARD_IMAGE_INTENT_V1]\nInspect images\n[/WIZARD_IMAGE_INTENT_V1]\n[WizardOS context] Window in front: Notes. Visible on screen: secret-looking screen text`
    expect(firstPostOf(content)).toEqual({ text: 'Plan the garden with care', attachments: [{ id: 'file-photo-1', name: 'garden.png', mime: 'image/png' }] })
  })
  it('cuts at 400 UTF-16 code units and never leaves half a surrogate pair', () => {
    expect(firstPostOf('a'.repeat(1000)).text).toBe('a'.repeat(400))
    const emoji = firstPostOf(`${'a'.repeat(399)}😀 more`).text
    expect(emoji).toBe('a'.repeat(399))
    expect(emoji.length).toBeLessThanOrEqual(400)
  })
  it('keeps images only, as { id, name, mime } refs, de-duplicated, from file and chip markers', () => {
    const post = firstPostOf(`Look${marker([photo, pdf, voice, { ...photo }])}${marker([{ id: 'file-photo-2', filename: 'b.JPG', mime: 'IMAGE/JPEG', bytes: 3 }], 'WIZARD_FILE_CHIPS_V1')}`)
    expect(post.attachments).toEqual([{ id: 'file-photo-1', name: 'garden.png', mime: 'image/png' }, { id: 'file-photo-2', name: 'b.JPG', mime: 'image/jpeg' }])
    expect(JSON.stringify(post)).not.toContain('trusted_path')
    expect(JSON.stringify(post)).not.toContain('/opt/data')
  })
  it('drops refs the files route cannot serve (Helm attachment envelopes, bad ids)', () => {
    const helm = `Here.\n\n<helm_attachments>${JSON.stringify({ items: [{ id: '1'.repeat(32), name: 'a.png', mime: 'image/png' }] })}</helm_attachments>`
    expect(firstPostOf(helm)).toEqual({ text: 'Here.', attachments: [] })
    expect(firstPostOf(`x${marker([{ ...photo, id: '../etc/passwd' }])}`).attachments).toEqual([])
  })
  it('a photo-only message has no words but its photos; a voice note says its transcript', () => {
    expect(firstPostOf(`Please use the attached photo.${marker([photo])}`)).toEqual({ text: '', attachments: [{ id: 'file-photo-1', name: 'garden.png', mime: 'image/png' }] })
    expect(firstPostOf(marker([voice]))).toEqual({ text: 'Plant the roses first.', attachments: [] })
  })
  it('reads the text parts of a multi-part message', () => {
    expect(firstPostOf(JSON.stringify([{ type: 'text', text: `Screenshot please${marker([photo])}` }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }])).text).toBe('Screenshot please')
  })
})

describe('first post readers', () => {
  it('state.db: the first visible owner message; an agent-started thread is null; an unknown thread is absent', () => {
    const d = mkdtempSync(join(tmpdir(), 'first-post-')); dirs.push(d)
    const path = join(d, 'state.db'), db = new DatabaseSync(path)
    db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, display_kind TEXT, timestamp REAL)')
    const put = db.prepare('INSERT INTO messages(session_id, role, content, display_kind, timestamp) VALUES(?,?,?,?,?)')
    db.prepare('INSERT INTO sessions(id) VALUES(?)').run('owner'); db.prepare('INSERT INTO sessions(id) VALUES(?)').run('agent')
    put.run('owner', 'user', '[ASYNC DELEGATION BATCH COMPLETE — d1]\nworker transcript', 'async_delegation_complete', 1)
    put.run('owner', 'user', `${'Long owner words '.repeat(40)}${marker([photo, pdf])}`, null, 2)
    put.run('owner', 'user', 'A later message', null, 3)
    put.run('agent', 'assistant', 'I started this', 'final', 1)
    db.prepare('INSERT INTO sessions(id) VALUES(?)').run('huge')
    put.run('huge', 'user', `${'x'.repeat(200_000)}${marker([photo])}`, null, 1)
    db.close()
    const posts = readHermesFirstPosts(path, ['owner', 'agent', 'missing', 'huge'])
    expect(posts.get('owner')?.text.startsWith('Long owner words Long')).toBe(true)
    expect(posts.get('owner')?.text.length).toBe(400)
    expect(posts.get('owner')?.attachments).toEqual([{ id: 'file-photo-1', name: 'garden.png', mime: 'image/png' }])
    expect(posts.get('agent')).toBeNull()
    expect(posts.has('missing')).toBe(false)
    // A very long first message keeps its photos: the file marker sits after the words.
    expect(posts.get('huge')?.attachments).toEqual([{ id: 'file-photo-1', name: 'garden.png', mime: 'image/png' }])
    expect(posts.get('huge')?.text).toBe('x'.repeat(400))
    expect(readHermesFirstPosts(join(d, 'unreadable.db'), ['owner']).size).toBe(0)
  })
  it('history page (a restricted agent, read through its runtime)', () => {
    expect(firstPostOfHistory([{ role: 'user', content: '[Your active task list was preserved across context compression]\n- x' }, { role: 'user', content: `Hi${marker([photo])}` }], false))
      .toEqual({ text: 'Hi', attachments: [{ id: 'file-photo-1', name: 'garden.png', mime: 'image/png' }] })
    expect(firstPostOfHistory([{ role: 'assistant', content: 'Agent note', display_kind: 'final' }], false)).toBeNull()
    expect(firstPostOfHistory([], false)).toBeUndefined()
    // A voice note still being transcribed: not decided yet, so it is read again later.
    expect(firstPostOfHistory([{ role: 'user', content: '' }], false)).toBeUndefined()
  })
})

describe('list rows', () => {
  const post = { text: 'Plan the garden', attachments: [{ id: 'file-photo-1', name: 'garden.png', mime: 'image/png' }] }
  it('switch on: rows carry both fields; an agent-started or unread row carries neither', () => {
    expect(listRow(row('a', { wizard_first_post: post }), '', null, { firstPosts: true })).toMatchObject({ firstRequest: 'Plan the garden', firstAttachments: post.attachments })
    for (const extra of [{ wizard_first_post: null }, {}]) {
      const listed = listRow(row('b', extra), '', null, { firstPosts: true })
      expect(listed).not.toHaveProperty('firstRequest'); expect(listed).not.toHaveProperty('firstAttachments')
    }
    // With the channel store also on, Hermes' short preview never stands in for the post.
    const channels = { channelOf: () => 'chan-1' }
    const both = listRow(row('c'), '', channels, { firstPosts: true })
    expect(both).toMatchObject({ channel: 'chan-1' }); expect(both).not.toHaveProperty('firstRequest')
    const page = listPayload({ data: [row('a', { wizard_first_post: post })] }, '', null, { firstPosts: true })
    expect(page.data[0]).toMatchObject({ firstRequest: 'Plan the garden' })
    expect(JSON.stringify(page)).not.toContain('wizard_first_post')
  })
  it('switch off: rows are unchanged', () => {
    const listed = listRow(row('a', { wizard_first_post: post }))
    expect(listed).not.toHaveProperty('firstRequest'); expect(listed).not.toHaveProperty('firstAttachments')
    expect(listRow(row('a', { wizard_first_post: post }), '', null, null)).toEqual(listRow(row('a')))
  })
})
