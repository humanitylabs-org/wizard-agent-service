#!/usr/bin/env node
// Maintenance CLI only. Never runs in the HTTP service and never logs private keys.
import { pathToFileURL } from 'node:url'
import { basename, join, resolve } from 'node:path'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DEFAULT_SKINS_RELAYS, DEFAULT_SKINS_BLOSSOM, decodeNip19, publicKey, signEvent, verifyEvent, relayRequest, relayPublish } from '../server/nostr.mjs'
import { createSkins } from '../server/skins.mjs'

const ADDRESS = /^30117:[a-f0-9]{64}:[a-z0-9-]{1,48}$/
export function curatorSecret(env = process.env) {
  let key = env.WIZARD_SKINS_CURATOR_NSEC
  if (!key && env.WIZARD_SKINS_CURATOR_KEY_FILE) key = JSON.parse(readFileSync(env.WIZARD_SKINS_CURATOR_KEY_FILE, 'utf8')).secret_hex
  if (typeof key !== 'string') throw new Error('Set WIZARD_SKINS_CURATOR_NSEC or WIZARD_SKINS_CURATOR_KEY_FILE')
  if (key.startsWith('nsec1')) key = decodeNip19(key, 'nsec')
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid curator key format')
  publicKey(key) // Reject zero/out-of-range secret scalars without printing them.
  return key
}
export async function runCurator(args, { env = process.env, output = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n'), transport = {} } = {}) {
  const relays = env.WIZARD_SKINS_RELAYS?.split(/[\s,]+/).filter(Boolean) || DEFAULT_SKINS_RELAYS
  const blossom = env.WIZARD_SKINS_BLOSSOM || DEFAULT_SKINS_BLOSSOM
  const key = curatorSecret(env), pubkey = publicKey(key)
  const query = transport.relayRequest || relayRequest, send = transport.relayPublish || relayPublish
  if (args[0] === 'publish-skin') {
    if (!args[1]) throw new Error('publish-skin requires a folder')
    const flags = {}
    for (let i = 2; i < args.length; i += 2) { if (!['--slug', '--name', '--summary'].includes(args[i]) || args[i + 1] === undefined) throw new Error('Invalid publish-skin flags'); flags[args[i].slice(2)] = args[i + 1] }
    if (!flags.slug || !flags.name || flags.summary === undefined) throw new Error('publish-skin requires --slug --name --summary')
    const source = resolve(args[1]), scratch = mkdtempSync(join(tmpdir(), 'skins-curator-'))
    try {
      const root = join(scratch, 'files'), folder = join(root, 'Skins', 'Seed')
      mkdirSync(folder, { recursive: true })
      // Only schema-1 files can leave the supplied folder. skin.js is deliberately not copied.
      for (const [name, cap] of [['skin.css', 65536], ['composition.json', 8192]]) {
        const file = join(source, name)
        if (!existsSync(file)) continue
        const st = lstatSync(file)
        if (!st.isFile() || st.size > cap) throw new Error('Invalid skin file: ' + name)
        copyFileSync(file, join(folder, name))
      }
      const meta = existsSync(join(source, 'skin.json')) ? JSON.parse(readFileSync(join(source, 'skin.json'), 'utf8')) : {}
      writeFileSync(join(folder, 'skin.json'), JSON.stringify({ ...meta, name: flags.name, summary: flags.summary }))
      const skins = createSkins({ root, stateDir: join(scratch, 'state'), relays, blossom, transport })
      const pack = await skins.pack('Seed', { slug: flags.slug, summary: flags.summary })
      const event = signEvent(pack.unsigned, key)
      output(await skins.publish('Seed', event))
      // Preserve publication state for the next seed update, but never copy any key into the source folder.
      copyFileSync(join(folder, 'skin.json'), join(source, 'skin.json'))
      if (JSON.parse(readFileSync(join(source, 'skin.json'), 'utf8')).published.event_id !== event.id) throw new Error('Publication metadata readback failed')
    } finally { rmSync(scratch, { recursive: true, force: true }) }
    return
  }
  const [set, action, target] = args
  if (!['featured', 'blocked'].includes(set) || !['add', 'remove', 'list'].includes(action) || (action !== 'list' && !target) || args.length > 3) throw new Error('Usage: skins-curator <featured|blocked> <add|remove|list> [a-or-npub]')
  const d = 'wizard-skins-' + set
  const results = await Promise.all(relays.map(url => query(url, [{ kinds: [30004], authors: [pubkey], '#d': [d], limit: 1 }], transport)))
  if (!results.some(r => r.ok)) throw new Error('No relay available; refusing to replace an unknown set')
  const events = results.flatMap(r => r.events).filter(e => verifyEvent(e) && e.kind === 30004 && e.pubkey === pubkey && e.tags.filter(t => t[0] === 'd').length === 1 && e.tags.some(t => t[0] === 'd' && t[1] === d))
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
  let tags = (events[0]?.tags || []).filter(t => ['a', 'p'].includes(t[0]))
  if (action === 'list') { output({ pubkey, set, entries: tags }); return }
  let entry
  if (ADDRESS.test(target)) entry = ['a', target]
  else if (set === 'blocked' && target.startsWith('npub1')) entry = ['p', decodeNip19(target, 'npub')]
  else throw new Error('Expected a skin address (or npub for a blocked author)')
  tags = tags.filter(t => !(t[0] === entry[0] && t[1] === entry[1]))
  if (action === 'add') tags.push(entry)
  const event = signEvent({ kind: 30004, created_at: Math.max(Math.floor(Date.now() / 1000), (events[0]?.created_at || 0) + 1), tags: [['d', d], ...tags], content: '' }, key)
  const published = await Promise.all(relays.map(url => send(url, event, transport)))
  if (!published.some(r => r.ok)) throw new Error('Curator publish failed')
  const readback = await Promise.all(relays.map(url => query(url, [{ ids: [event.id], limit: 1 }], transport)))
  if (!readback.some(r => r.events.some(e => e?.id === event.id && verifyEvent(e)))) throw new Error('Curator event not found on readback')
  output({ event_id: event.id, pubkey, set, entries: tags, relays: published })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCurator(process.argv.slice(2)).catch(() => {
    // Provider/library errors can embed inputs. Keep the CLI failure output secret-free.
    process.stderr.write('Skins curator failed. Check command arguments, key configuration and relay/Blossom availability.\n')
    process.exitCode = 1
  })
}
