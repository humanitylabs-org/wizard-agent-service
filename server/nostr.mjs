// Small NIP-01 / NIP-19 / BUD-02 transport. No identity keys cross the HTTP API.
import { createHash, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns'
import { isIP } from 'node:net'
import https from 'node:https'
import http from 'node:http'
import { schnorr } from '@noble/curves/secp256k1.js'

export const DEFAULT_SKINS_RELAYS = ['wss://store.wizard001.com/relay', 'wss://nos.lol', 'wss://relay.damus.io']
export const DEFAULT_SKINS_BLOSSOM = 'https://store.wizard001.com/blossom'
// Set the archive curator's public key at deployment; no untrusted key may curate by default.
export const DEFAULT_SKINS_CURATOR = '9f6deaf1a019f9393e3a044f873e508b1ac6cfa093db77ba21e70c811ee1f127'
export const hex = bytes => Buffer.from(bytes).toString('hex')
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const publicKey = key => hex(schnorr.getPublicKey(Buffer.from(key, 'hex')))
export const newSecret = () => hex(schnorr.utils.randomSecretKey())
export function eventId(event) {
  return sha256(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]))
}
export function verifyEvent(event) {
  try {
    return /^[a-f0-9]{64}$/.test(event.pubkey) && /^[a-f0-9]{64}$/.test(event.id) && /^[a-f0-9]{128}$/.test(event.sig)
      && Number.isSafeInteger(event.created_at) && event.created_at >= 0 && Number.isSafeInteger(event.kind) && event.kind >= 0
      && typeof event.content === 'string' && Array.isArray(event.tags) && event.tags.every(t => Array.isArray(t) && t.every(v => typeof v === 'string'))
      && event.id === eventId(event) && schnorr.verify(Buffer.from(event.sig, 'hex'), Buffer.from(event.id, 'hex'), Buffer.from(event.pubkey, 'hex'))
  } catch { return false }
}
export function signEvent(template, key, aux) {
  const event = { ...template, pubkey: publicKey(key) }
  event.id = eventId(event)
  event.sig = hex(schnorr.sign(Buffer.from(event.id, 'hex'), Buffer.from(key, 'hex'), aux))
  return event
}

const ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
function polymod(values) {
  let chk = 1
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  for (const value of values) {
    const top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ value
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i]
  }
  return chk >>> 0
}
const expand = hrp => [...hrp].map(c => c.charCodeAt(0) >>> 5).concat(0, [...hrp].map(c => c.charCodeAt(0) & 31))
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0; const out = []
  for (const value of data) {
    if (value < 0 || value >>> from) throw new Error('invalid_bech32')
    acc = ((acc << from) | value) & 0x7fffffff; bits += from
    while (bits >= to) { bits -= to; out.push((acc >>> bits) & ((1 << to) - 1)) }
  }
  if (pad && bits) out.push((acc << (to - bits)) & ((1 << to) - 1))
  else if (bits >= from || ((acc << (to - bits)) & ((1 << to) - 1))) throw new Error('invalid_bech32')
  return out
}
export function npub(pubkey) {
  if (!/^[a-f0-9]{64}$/.test(pubkey)) throw new Error('invalid_pubkey')
  const words = convertBits(Buffer.from(pubkey, 'hex'), 8, 5, true)
  const mod = polymod([...expand('npub'), ...words, 0, 0, 0, 0, 0, 0]) ^ 1
  return 'npub1' + [...words, ...Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31)].map(v => ALPHABET[v]).join('')
}
export function decodeNip19(value, prefix) {
  if (typeof value !== 'string' || value !== value.toLowerCase() || !value.startsWith(prefix + '1')) throw new Error('invalid_bech32')
  const words = [...value.slice(prefix.length + 1)].map(c => ALPHABET.indexOf(c))
  if (words.length !== 58 || words.includes(-1) || polymod([...expand(prefix), ...words]) !== 1) throw new Error('invalid_bech32')
  const bytes = convertBits(words.slice(0, -6), 5, 8, false)
  if (bytes.length !== 32) throw new Error('invalid_bech32')
  return hex(bytes)
}

export function relayRequest(url, filters, { timeoutMs = 6000, maxEvents = 2000, WebSocketImpl = WebSocket } = {}) {
  return new Promise(resolve => {
    let socket, timer, settled = false; const events = [], id = randomBytes(8).toString('hex')
    const finish = ok => { if (settled) return; settled = true; clearTimeout(timer); try { socket?.close() } catch {} resolve({ url, ok, events }) }
    try { socket = new WebSocketImpl(url) } catch { finish(false); return }
    timer = setTimeout(() => finish(false), timeoutMs)
    socket.addEventListener('open', () => socket.send(JSON.stringify(['REQ', id, ...filters])))
    socket.addEventListener('message', message => {
      try {
        if (typeof message.data !== 'string' || message.data.length > 256 * 1024) return
        const frame = JSON.parse(message.data)
        if (frame[1] !== id) return
        if (frame[0] === 'EOSE') { socket.send(JSON.stringify(['CLOSE', id])); finish(true) }
        else if (frame[0] === 'EVENT' && events.length < maxEvents) events.push(frame[2])
        else if (frame[0] === 'CLOSED') finish(false)
      } catch { /* malformed relay frames aren't events */ }
    })
    socket.addEventListener('error', () => finish(false))
    socket.addEventListener('close', () => finish(false))
  })
}
export function relayPublish(url, event, { timeoutMs = 6000, WebSocketImpl = WebSocket } = {}) {
  return new Promise(resolve => {
    let socket, timer, settled = false
    const finish = (ok, message = '') => { if (settled) return; settled = true; clearTimeout(timer); try { socket?.close() } catch {} resolve({ url, ok, message }) }
    try { socket = new WebSocketImpl(url) } catch { finish(false, 'connection_failed'); return }
    timer = setTimeout(() => finish(false, 'timeout'), timeoutMs)
    socket.addEventListener('open', () => socket.send(JSON.stringify(['EVENT', event])))
    socket.addEventListener('message', message => {
      try {
        if (typeof message.data !== 'string' || message.data.length > 8192) return
        const frame = JSON.parse(message.data)
        if (frame[0] === 'OK' && frame[1] === event.id) finish(frame[2] === true, String(frame[3] || ''))
      } catch {}
    })
    socket.addEventListener('error', () => finish(false, 'connection_failed'))
    socket.addEventListener('close', () => finish(false, 'closed'))
  })
}

// Validate the actual connected address (including DNS answers); redirects are not followed.
// Local HTTP is an explicit constructor option for synthetic tests, never an HTTP request option.
function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return !([0, 10, 127].includes(a) || a >= 224 || (a === 169 && b === 254) || (a === 192 && [0, 168].includes(b)) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)))
  }
  return isIP(address) === 6 && /^2[0-9a-f]{3}:/i.test(address) && !/^2001:(?:db8|0):/i.test(address)
}
export function blobUrl(server, sha) {
  const url = new URL(server)
  if (url.username || url.password || url.search || url.hash || !/^[a-f0-9]{64}$/.test(sha)) throw new Error('invalid_blob_url')
  url.pathname = url.pathname.replace(/\/$/, '') + '/' + sha
  return url
}
export function blossomRequest(url, { method = 'GET', body, headers = {}, maxBytes = 1024 * 1024, allowPrivate = false, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    url = new URL(url)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (url.username || url.password || (!allowPrivate && url.protocol !== 'https:') || !['http:', 'https:'].includes(url.protocol)
      || (!allowPrivate && isIP(host) && !publicAddress(host))) { reject(new Error('unsafe_blossom_url')); return }
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method, headers, lookup: (name, options, callback) => lookup(name, options, (error, address, family) => {
        if (error) return callback(error)
        const addresses = Array.isArray(address) ? address : [{ address, family }]
        if (!allowPrivate && addresses.some(a => !publicAddress(a.address))) return callback(new Error('unsafe_blossom_address'))
        callback(null, address, family)
      }),
    }, res => {
      const chunks = []; let size = 0
      if (Number(res.headers['content-length']) > maxBytes && method !== 'HEAD') { res.destroy(new Error('blob_too_large')); return }
      res.on('data', chunk => { size += chunk.length; if (size > maxBytes) res.destroy(new Error('blob_too_large')); else chunks.push(chunk) })
      res.on('error', reject)
      res.on('end', () => { if (res.statusCode < 200 || res.statusCode >= 300) reject(new Error('blossom_http_' + res.statusCode)); else resolve({ body: Buffer.concat(chunks), headers: res.headers }) })
    })
    const timer = setTimeout(() => req.destroy(new Error('blossom_timeout')), timeoutMs)
    req.on('close', () => clearTimeout(timer)); req.on('error', reject)
    req.end(body)
  })
}
export async function blossomGet(server, file, options) {
  const { body } = await blossomRequest(blobUrl(server, file.sha256), { ...options, maxBytes: file.size })
  if (body.length !== file.size || sha256(body) !== file.sha256) throw new Error('blob_hash_mismatch')
  return body
}
export async function blossomUpload(server, body, mime, key, options) {
  const sha = sha256(body), now = Math.floor(Date.now() / 1000)
  const auth = signEvent({ kind: 24242, created_at: now, tags: [['t', 'upload'], ['x', sha], ['expiration', String(now + 300)]], content: 'Upload Wizard skin blob' }, key)
  const url = new URL(server); url.pathname = url.pathname.replace(/\/$/, '') + '/upload'
  await blossomRequest(url, { ...options, method: 'PUT', body, headers: { Authorization: 'Nostr ' + Buffer.from(JSON.stringify(auth)).toString('base64'), 'X-SHA-256': sha, 'Content-Type': mime, 'Content-Length': String(body.length) } })
  // A server's 2xx upload response is not evidence that it stored the expected bytes.
  await blossomGet(server, { sha256: sha, size: body.length }, options)
  return sha
}
