// Files-backed My skins and verified Nostr Store. The browser only sees local blob URLs.
import { chmodSync, constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { MY_SKIN_MAX_BYTES, mySkinEmpty, sanitizeMySkin, validSkinId } from './my-skin.mjs'
import { DEFAULT_SKINS_RELAYS, DEFAULT_SKINS_BLOSSOM, DEFAULT_SKINS_CURATOR, sha256, newSecret, publicKey, signEvent, verifyEvent, npub, blobUrl, blossomRequest, blossomGet, blossomUpload, relayRequest, relayPublish } from './nostr.mjs'

export class SkinsError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}
const fail = (code, status = 400) => { throw new SkinsError(status, code) }
const HEX = /^[a-f0-9]{64}$/
const BASE = /^[a-z0-9-]{1,32}$/
const TWEAK = /^[a-z0-9-]+\/[a-z0-9-]+$/
function recipe(input) {
  const out = {}
  if (input.base !== undefined) { if (typeof input.base !== 'string' || !BASE.test(input.base)) fail('invalid_base'); out.base = input.base }
  if (input.tweaks !== undefined) {
    if (!input.tweaks || typeof input.tweaks !== 'object' || Array.isArray(input.tweaks) || Object.keys(input.tweaks).length > 64 || Object.entries(input.tweaks).some(([id, on]) => !TWEAK.test(id) || typeof on !== 'boolean')) fail('invalid_tweaks')
    out.tweaks = { ...input.tweaks }
  }
  return out
}
const SLUG = /^[a-z0-9-]{1,48}$/
const ADDRESS = /^30117:([a-f0-9]{64}):([a-z0-9-]{1,48})$/
const CAPS = { 'skin.css': ['text/css', MY_SKIN_MAX_BYTES], 'preview.webp': ['image/webp', 512 * 1024], 'composition.json': ['application/json', 8 * 1024] }
const nowSeconds = () => Math.floor(Date.now() / 1000)
const tagsOf = (e, key) => e.tags.filter(t => t[0] === key)
const one = (e, key, required = true) => {
  const found = tagsOf(e, key)
  if (found.length > 1 || (required && found.length !== 1) || (found.length && found[0].length !== 2)) fail('invalid_' + key)
  return found[0]?.[1]
}
const shortText = (value, max, required = false) => typeof value === 'string' && [...value].length <= max && (!required || value.trim().length > 0) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
const integer = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value))
export const addressOf = event => `30117:${event.pubkey}:${one(event, 'd')}`
export function slugFromName(name) {
  const slug = String(name).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
  return slug || 'my-skin'
}

export function validateListing(event, { allowPrivate = false } = {}) {
  if (!verifyEvent(event) || event.kind !== 30117 || Buffer.byteLength(JSON.stringify(event)) > 32768) fail('invalid_skin_event')
  let content
  try { content = JSON.parse(event.content) } catch { fail('invalid_schema') }
  if (!content || content.schema !== 1) fail('invalid_schema')
  const slug = one(event, 'd'), name = one(event, 'name'), summary = one(event, 'summary', false) || ''
  const published = one(event, 'published_at'), version = one(event, 'version'), base = one(event, 'base'), ux = one(event, 'ux')
  if (!SLUG.test(slug) || !shortText(name, 48, true) || !shortText(summary, 140) || one(event, 'alt') !== `Wizard OS skin: ${name}`) fail('invalid_skin_tags')
  if (!tagsOf(event, 't').some(t => t.length === 2 && t[1] === 'wizard-skin')) fail('missing_skin_tag')
  if (!integer(published) || Number(published) > event.created_at || !integer(version) || Number(version) < 1 || base !== 'nebula' || ux !== '1') fail('unsupported_skin')
  const files = tagsOf(event, 'file').map(t => {
    const [, name, hash, mime, bytes] = t, cap = CAPS[name]
    if (t.length !== 5 || !cap || mime !== cap[0] || !HEX.test(hash) || !integer(bytes) || Number(bytes) > cap[1]) fail('invalid_skin_file')
    return { name, sha256: hash, mime, size: Number(bytes) }
  })
  if (!files.some(f => f.name === 'skin.css') || new Set(files.map(f => f.name)).size !== files.length) fail('missing_or_duplicate_file')
  const servers = tagsOf(event, 'server').map(t => {
    if (t.length !== 2) fail('invalid_server')
    let url
    try { url = blobUrl(t[1], '0'.repeat(64)) } catch { fail('invalid_server') }
    if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) fail('invalid_server')
    return t[1].replace(/\/$/, '')
  })
  if (!servers.length || servers.length > 8) fail('invalid_server')
  const forks = tagsOf(event, 'a').filter(t => t[3] === 'fork')
  if (forks.length > 1 || (forks.length && (forks[0].length !== 4 || !ADDRESS.test(forks[0][1]) || !tagsOf(event, 'p').some(t => t[1] === forks[0][1].split(':')[1])))) fail('invalid_fork')
  return { a: addressOf(event), event_id: event.id, pubkey: event.pubkey, npub: npub(event.pubkey), author: null, name, summary, slug,
    version: Number(version), published_at: Number(published), updated_at: event.created_at, base, ux: Number(ux), files,
    preview: files.find(f => f.name === 'preview.webp') ? `/wizard/v1/skins/store/blob/${files.find(f => f.name === 'preview.webp').sha256}` : null,
    forked_from: forks[0]?.[1] || null, forks: 0, featured: false, servers }
}

export function atomicWrite(file, body, mode = 0o600) {
  const tmp = join(dirname(file), `.skins-${randomBytes(12).toString('hex')}.tmp`)
  try { writeFileSync(tmp, body, { mode, flag: 'wx' }); chmodSync(tmp, mode); renameSync(tmp, file) }
  finally { rmSync(tmp, { force: true }) }
}
function boundedRead(file, cap) {
  let fd
  try {
    const st = lstatSync(file)
    if (!st.isFile() || st.size > cap) fail('invalid_skin_file')
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const body = readFileSync(fd)
    if (body.length > cap) fail('skin_too_large', 413)
    return body
  } finally { if (fd !== undefined) closeSync(fd) }
}
function readJson(file) {
  try { const value = JSON.parse(boundedRead(file, 32768)); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} } catch { return {} }
}
const newer = (a, b) => !b || a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id)
function latest(events, key) {
  const out = new Map()
  for (const e of events) { if (!verifyEvent(e)) continue; let id; try { id = key(e) } catch { continue }; if (id && newer(e, out.get(id))) out.set(id, e) }
  return out
}
async function mapLimited(items, concurrency, fn) {
  let next = 0
  const result = new Array(items.length)
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => { while (next < items.length) { const i = next++; result[i] = await fn(items[i]) } }))
  return result
}

export function createSkins({ root = '', stateDir = '', relays = DEFAULT_SKINS_RELAYS, blossom = DEFAULT_SKINS_BLOSSOM,
  curator = process.env.WIZARD_SKINS_CURATOR || DEFAULT_SKINS_CURATOR, transport = {}, now = nowSeconds, cacheSeconds = 300 } = {}) {
  if (!root || !stateDir) return null
  const filesRoot = resolve(root), skinsRoot = join(filesRoot, 'Skins'), state = resolve(stateDir)
  const net = { allowPrivate: false, ...transport }
  const query = transport.relayRequest || relayRequest, broadcast = transport.relayPublish || relayPublish
  const trashRoot = join(state, 'trash')
  const cacheRoot = join(state, 'blobs'), packsRoot = join(state, 'packs'), publishedRoot = join(state, 'published')
  let cached = null, pending = null
  const busy = new Set()
  async function exclusive(id, action) {
    if (busy.has(id)) fail('skin_busy', 409)
    busy.add(id)
    try { return await action() } finally { busy.delete(id) }
  }
  function storage() {
    for (const dir of [state, cacheRoot, packsRoot, publishedRoot, trashRoot]) { mkdirSync(dir, { recursive: true, mode: 0o700 }); if (!lstatSync(dir).isDirectory()) fail('skins_state_unavailable', 503) }
  }
  function folders() {
    if (!lstatSync(filesRoot).isDirectory()) fail('skins_unavailable', 503)
    if (existsSync(skinsRoot)) { if (!lstatSync(skinsRoot).isDirectory()) fail('skins_unavailable', 503) }
    else mkdirSync(skinsRoot, { mode: 0o775 })
    // Require a real, immediate child; never follow Skins or skin-folder symlinks.
    if (dirname(realpathSync(skinsRoot)) !== realpathSync(filesRoot)) fail('skins_unavailable', 503)
  }
  function folder(id) {
    if (!validSkinId(id)) fail('invalid_skin_id')
    folders()
    const path = join(skinsRoot, id)
    try { if (!lstatSync(path).isDirectory()) fail('skin_not_found', 404) } catch (e) { if (e.code === 'ENOENT') fail('skin_not_found', 404); throw e }
    return path
  }
  function migrate() {
    folders()
    if (!existsSync(join(skinsRoot, 'active')) && lstatSafe(join(skinsRoot, 'My skin'))?.isDirectory()) atomicWrite(join(skinsRoot, 'active'), 'My skin\n', 0o664)
  }
  function active() {
    migrate()
    try { const id = boundedRead(join(skinsRoot, 'active'), 512).toString().replace(/\r?\n$/, ''); return validSkinId(id) && lstatSafe(join(skinsRoot, id))?.isDirectory() ? id : null } catch { return null }
  }
  function metadata(id) { return { name: id, ...readJson(join(folder(id), 'skin.json')) } }
  function list() {
    pruneTrash()
    const selected = active()
    const skins = readdirSync(skinsRoot, { withFileTypes: true }).filter(d => d.isDirectory() && validSkinId(d.name)).map(d => {
      const meta = metadata(d.name), path = folder(d.name)
      let css = Buffer.alloc(0), bytes = 0
      try { bytes = lstatSync(join(path, 'skin.css')).size; css = boundedRead(join(path, 'skin.css'), MY_SKIN_MAX_BYTES) } catch {}
      return { id: d.name, name: meta.name, summary: meta.summary || '', base: meta.base || 'nebula', tweaks: meta.tweaks || {}, has_recipe: Object.hasOwn(meta, 'base') || Object.hasOwn(meta, 'tweaks'), bytes, empty: mySkinEmpty(sanitizeMySkin(css)),
        has_script: Boolean(lstatSafe(join(path, 'skin.js'))?.isFile()), forked_from: meta.forked_from || null, published: meta.published || null }
    })
    return { active: selected, skins }
  }
  function setActive(id) {
    if (id !== null) folder(id)
    else folders()
    atomicWrite(join(skinsRoot, 'active'), id === null ? '' : id + '\n', 0o664)
    return list()
  }
  function create({ name, css = '', base = undefined, tweaks = undefined, migration_key = undefined, activate = false, meta = {}, extra = {} }) {
    const values = recipe({ base, tweaks })
    if (typeof activate !== 'boolean') fail('invalid_activate')
    if (!validSkinId(name)) fail('invalid_skin_name')
    if (typeof css !== 'string' || css.includes('\0')) fail('invalid_css')
    if (Buffer.byteLength(css) > MY_SKIN_MAX_BYTES) fail('skin_too_large', 413)
    if (migration_key !== undefined && (typeof migration_key !== 'string' || !/^[a-z0-9-]{1,80}$/.test(migration_key))) fail('invalid_migration_key')
    folders()
    if (migration_key) {
      const prior = list().skins.find(s => metadata(s.id).migration_key === migration_key)
      if (prior) { if (activate) setActive(prior.id); return { id: prior.id } }
    }
    let id = name, path
    for (let count = 1; count < 10000; count++) {
      const suffix = count === 1 ? '' : ` ${count}`
      id = [...name].slice(0, 64 - suffix.length).join('') + suffix
      if (id === 'active') continue // The pointer occupies this filename; preserve the requested display name.
      path = join(skinsRoot, id)
      try { mkdirSync(path, { mode: 0o775 }); break } catch (e) { if (e.code !== 'EEXIST') throw e; path = null }
    }
    if (!path) fail('too_many_skins', 409)
    try {
      atomicWrite(join(path, 'skin.css'), css, 0o664)
      atomicWrite(join(path, 'skin.json'), JSON.stringify({ name, base: 'nebula', ...meta, ...values, ...(migration_key ? { migration_key } : {}) }) + '\n', 0o664)
      for (const [file, body] of Object.entries(extra)) { if (file !== 'skin.css' && CAPS[file]) atomicWrite(join(path, file), body, 0o664) }
    } catch (e) { rmSync(path, { recursive: true, force: true }); throw e }
    if (activate) setActive(id)
    return { id }
  }
  function patch(id, input) {
    const values = recipe(input), path = folder(id), meta = metadata(id)
    if (input.name !== undefined) { if (!shortText(input.name, 64, true)) fail('invalid_skin_name'); values.name = input.name }
    if (values.tweaks) values.tweaks = recipe({ tweaks: { ...(meta.tweaks || {}), ...values.tweaks } }).tweaks
    atomicWrite(join(path, 'skin.json'), JSON.stringify({ ...meta, ...values }) + '\n', 0o664)
    return list()
  }
  function pruneTrash() {
    storage()
    for (const entry of readdirSync(trashRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue
      const path = join(trashRoot, entry.name), info = readJson(join(path, 'trash.json'))
      if (typeof info.removed_at === 'number' && now() - info.removed_at > 7 * 86400) rmSync(path, { recursive: true, force: true })
    }
  }
  function remove(id) {
    if (busy.has(id)) fail('skin_busy', 409)
    const path = folder(id), selected = active()
    pruneTrash()
    const trash = randomBytes(16).toString('hex'), target = join(trashRoot, trash)
    mkdirSync(target, { mode: 0o700 })
    atomicWrite(join(target, 'trash.json'), JSON.stringify({ id, removed_at: now() }))
    // Write the empty pointer before moving: legacy My skin must not migrate back.
    if (selected === id) setActive(null)
    renameSync(path, join(target, 'skin'))
    return { trash, list: list() }
  }
  function restore({ trash }) {
    if (typeof trash !== 'string' || !/^[a-f0-9]{32}$/.test(trash)) fail('invalid_trash')
    pruneTrash(); folders()
    const target = join(trashRoot, trash), info = readJson(join(target, 'trash.json'))
    if (!lstatSafe(target)?.isDirectory() || !validSkinId(info.id) || info.id === 'active' || !lstatSafe(join(target, 'skin'))?.isDirectory()) fail('trash_not_found', 404)
    if (lstatSafe(join(skinsRoot, info.id))) fail('skin_exists', 409)
    renameSync(join(target, 'skin'), join(skinsRoot, info.id))
    rmSync(target, { recursive: true, force: true })
    return { id: info.id, list: list() }
  }
  function uploadKey() {
    storage()
    const file = join(state, 'upload-key.hex')
    if (!existsSync(file)) {
      try { writeFileSync(file, newSecret() + '\n', { mode: 0o600, flag: 'wx' }) } catch (e) { if (e.code !== 'EEXIST') throw e }
    }
    const key = boundedRead(file, 128).toString().trim()
    if (!HEX.test(key)) fail('upload_key_unavailable', 503)
    chmodSync(file, 0o600)
    return key
  }
  function cachedBlob(file) {
    try { const body = boundedRead(join(cacheRoot, file.sha256), file.size); if (body.length === file.size && sha256(body) === file.sha256) return body } catch {}
    return null
  }
  async function fetchBlob(file, servers, force = false) {
    const hit = !force && cachedBlob(file)
    if (hit) return hit
    for (const server of servers) {
      try { const body = await blossomGet(server, file, net); storage(); atomicWrite(join(cacheRoot, file.sha256), body); return body } catch {}
    }
    fail('skin_blob_unavailable', 422)
  }
  async function fetchStore() {
    const results = await Promise.all(relays.map(url => query(url, [
      { kinds: [30117], '#t': ['wizard-skin'], limit: 1000 },
      ...(HEX.test(curator) ? [{ kinds: [30004], authors: [curator], '#d': ['wizard-skins-featured', 'wizard-skins-blocked'], limit: 2 }] : []),
    ], net)))
    const events = results.flatMap(r => r.events).filter(e => e && typeof e === 'object')
    const listings = latest(events.filter(e => e.kind === 30117), addressOf)
    const sets = latest(events.filter(e => e.kind === 30004 && e.pubkey === curator), e => one(e, 'd'))
    const featured = tagsOf(sets.get('wizard-skins-featured') || { tags: [] }, 'a').map(t => t[1]).filter(a => ADDRESS.test(a))
    const blocked = sets.get('wizard-skins-blocked') || { tags: [] }
    const blockedA = new Set(tagsOf(blocked, 'a').map(t => t[1])), blockedP = new Set(tagsOf(blocked, 'p').map(t => t[1]))
    const candidates = [...listings].filter(([a, e]) => !blockedA.has(a) && !blockedP.has(e.pubkey)).slice(0, 1000)
    const valid = await mapLimited(candidates, 8, async ([, event]) => {
      try { const item = validateListing(event, net); await Promise.all(item.files.map(f => fetchBlob(f, item.servers))); return item } catch { return null }
    })
    const items = valid.filter(Boolean), authors = [...new Set(items.map(i => i.pubkey))]
    const profiles = authors.length ? await Promise.all(relays.map(url => query(url, [{ kinds: [0], authors, limit: authors.length }], net))) : []
    const newestProfiles = latest(profiles.flatMap(r => r.events).filter(e => e && e.kind === 0 && authors.includes(e.pubkey)), e => e.pubkey)
    for (const item of items) {
      item.featured = featured.includes(item.a)
      item.forks = items.filter(other => other.forked_from === item.a).length
      try { const profile = JSON.parse(newestProfiles.get(item.pubkey)?.content || 'null'); if (profile) item.author = { name: typeof profile.name === 'string' ? profile.name.slice(0, 256) : '', picture: typeof profile.picture === 'string' && /^https:\/\//.test(profile.picture) ? profile.picture.slice(0, 2048) : '' } } catch {}
    }
    items.sort((a, b) => {
      const ai = featured.indexOf(a.a), bi = featured.indexOf(b.a)
      return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || b.updated_at - a.updated_at || a.a.localeCompare(b.a)
    })
    return { items, featured: [...new Set(featured)].filter(a => items.some(i => i.a === a)), fetched_at: now(), relays: results.map(({ url, ok }) => ({ url, ok })) }
  }
  async function store({ refresh = false, authors = '' } = {}) {
    if (!cached || refresh || now() - cached.fetched_at >= cacheSeconds) {
      if (!pending) pending = fetchStore().then(value => { cached = value; return value }).finally(() => { pending = null })
      await pending
    }
    const filter = authors ? String(authors).split(',') : null
    if (filter && (filter.length > 200 || filter.some(a => !HEX.test(a)))) fail('invalid_authors')
    return { ...cached, items: cached.items.filter(i => !filter || filter.includes(i.pubkey)).map(({ servers, ...item }) => item) }
  }
  async function blob(sha) {
    if (!HEX.test(sha)) fail('invalid_blob')
    await store()
    const file = cached.items.flatMap(i => i.files).find(f => f.sha256 === sha)
    if (!file) fail('blob_not_found', 404)
    const body = cachedBlob(file)
    if (!body) fail('blob_not_found', 404)
    return { body, mime: file.mime }
  }
  async function add(a) {
    await store()
    const item = cached.items.find(i => i.a === a)
    if (!item) fail('skin_not_found', 404)
    const extra = {}
    for (const file of item.files) extra[file.name] = await fetchBlob(file, item.servers)
    const made = create({ name: item.name, css: sanitizeMySkin(extra['skin.css']), extra,
      meta: { summary: item.summary, forked_from: { a, event_id: item.event_id, author: item.pubkey }, published: null } })
    setActive(made.id)
    return made
  }
  async function report({ a, reason }) {
    if (!ADDRESS.test(a) || !shortText(reason, 1000, true)) fail('invalid_report')
    const event = signEvent({ kind: 1984, created_at: now(), tags: [['a', a], ['p', a.split(':')[1]], ['report', 'other']], content: reason }, uploadKey())
    const result = await broadcast(relays[0], event, net)
    if (!result.ok) fail('report_failed', 502)
    return { ok: true }
  }
  async function previousEvent(meta) {
    if (!meta.published) return null
    if (!HEX.test(meta.published.event_id) || !ADDRESS.test(meta.published.a)) fail('invalid_published_metadata')
    storage()
    const cachedEvent = readJson(join(publishedRoot, meta.published.event_id + '.json'))
    if (verifyEvent(cachedEvent) && cachedEvent.id === meta.published.event_id) return cachedEvent
    if (!ADDRESS.test(meta.published.a)) fail('invalid_published_metadata')
    const [, pubkey, slug] = meta.published.a.split(':')
    const results = await Promise.all(relays.map(url => query(url, [{ kinds: [30117], authors: [pubkey], '#d': [slug], limit: 1 }], net)))
    const event = latest(results.flatMap(r => r.events).filter(e => e && e.kind === 30117), addressOf).get(meta.published.a)
    if (!event) fail('previous_publication_unavailable', 503)
    return event
  }
  async function pack(id, input = {}) {
    const path = folder(id), meta = metadata(id)
    const name = meta.name, summary = input.summary ?? meta.summary ?? ''
    const previous = await previousEvent(meta)
    const slug = input.slug ?? meta.published?.slug ?? slugFromName(name)
    if (!shortText(name, 48, true) || !shortText(summary, 140) || !SLUG.test(slug)) fail('invalid_pack_metadata')
    const bodies = [{ name: 'skin.css', mime: 'text/css', body: Buffer.from(sanitizeMySkin(boundedRead(join(path, 'skin.css'), MY_SKIN_MAX_BYTES))) }]
    if (input.preview_webp_b64 !== undefined) {
      const encoded = input.preview_webp_b64
      if (typeof encoded !== 'string' || encoded.length > 700000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail('invalid_preview')
      const body = Buffer.from(encoded, 'base64')
      if (body.length > CAPS['preview.webp'][1] || body.length < 12 || body.toString('ascii', 0, 4) !== 'RIFF' || body.toString('ascii', 8, 12) !== 'WEBP') fail('invalid_preview')
      bodies.push({ name: 'preview.webp', mime: 'image/webp', body })
    }
    if (existsSync(join(path, 'composition.json'))) {
      const body = boundedRead(join(path, 'composition.json'), 8192)
      try { JSON.parse(body) } catch { fail('invalid_composition') }
      bodies.push({ name: 'composition.json', mime: 'application/json', body })
    }
    const key = uploadKey(), files = []
    for (const file of bodies) {
      const hash = await blossomUpload(blossom, file.body, file.mime, key, net)
      atomicWrite(join(cacheRoot, hash), file.body)
      files.push(['file', file.name, hash, file.mime, String(file.body.length)])
    }
    const created = Math.max(now(), previous ? previous.created_at + 1 : 0)
    const tags = [['d', slug], ['t', 'wizard-skin'], ['name', name], ['summary', summary],
      ['published_at', previous ? one(previous, 'published_at') : String(created)], ['version', String(previous ? Number(one(previous, 'version')) + 1 : 1)],
      ['base', 'nebula'], ['ux', '1'], ...files, ['server', blossom]]
    if (meta.forked_from) {
      const parent = meta.forked_from
      if (!ADDRESS.test(parent.a) || parent.author !== parent.a.split(':')[1]) fail('invalid_fork')
      tags.push(['a', parent.a, relays[0], 'fork'], ['p', parent.author])
    }
    tags.push(['alt', `Wizard OS skin: ${name}`])
    const unsigned = { kind: 30117, created_at: created, tags, content: '{"schema":1}' }
    storage()
    atomicWrite(join(packsRoot, sha256(id) + '.json'), JSON.stringify({ unsigned, css: files[0][2], previous: meta.published?.event_id || null }))
    return { unsigned, slug }
  }
  async function publish(id, event) {
    folder(id)
    const item = validateListing(event, net), meta = metadata(id)
    const packed = readJson(join(packsRoot, sha256(id) + '.json'))
    if (!packed.unsigned || JSON.stringify({ kind: event.kind, created_at: event.created_at, tags: event.tags, content: event.content }) !== JSON.stringify(packed.unsigned)
      || (meta.published?.event_id || null) !== packed.previous) fail('pack_mismatch', 409)
    const currentCss = Buffer.from(sanitizeMySkin(boundedRead(join(folder(id), 'skin.css'), MY_SKIN_MAX_BYTES)))
    if (sha256(currentCss) !== packed.css) fail('pack_mismatch', 409)
    // HEAD checks availability, GET establishes that an untrusted server still holds these exact bytes.
    for (const file of item.files) {
      let verified = false
      for (const server of item.servers) {
        try { await blossomRequest(blobUrl(server, file.sha256), { ...net, method: 'HEAD' }); await blossomGet(server, file, net); verified = true; break } catch {}
      }
      if (!verified) fail('skin_blob_unavailable', 422)
    }
    const results = await Promise.all(relays.map(url => broadcast(url, event, net)))
    if (!results.some(r => r.ok)) fail('publish_failed', 502)
    storage()
    atomicWrite(join(publishedRoot, event.id + '.json'), JSON.stringify(event))
    atomicWrite(join(folder(id), 'skin.json'), JSON.stringify({ ...meta, published: { a: item.a, event_id: event.id, created_at: event.created_at, slug: item.slug } }) + '\n', 0o664)
    rmSync(join(packsRoot, sha256(id) + '.json'), { force: true })
    cached = null
    return { event_id: event.id, a: item.a, relays: results }
  }
  return { list, setActive, create, patch, remove, restore, store, blob, add, report,
    pack: (id, input) => exclusive(id, () => pack(id, input)),
    publish: (id, event) => exclusive(id, () => publish(id, event)), migrate }
}
function lstatSafe(file) { try { return lstatSync(file) } catch { return null } }
