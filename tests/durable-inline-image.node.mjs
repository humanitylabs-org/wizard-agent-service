import test from 'node:test'
import assert from 'node:assert/strict'
import { durableInlineImage } from '../server/service.mjs'
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), (await import('node:crypto')).randomBytes(3_800_000)])
const part = b64 => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } })
test('multi-megabyte screenshot validates without regex stack overflow', () => {
  const r = durableInlineImage(part(png.toString('base64')))
  assert.ok(r); assert.equal(r.bytes, png.length)
})
test('malformed base64 is still rejected', () => {
  const ok = png.subarray(0, 300).toString('base64')
  assert.equal(durableInlineImage(part(ok + '=')), null)
  assert.equal(durableInlineImage(part('ab=c' + ok)), null)
  assert.equal(durableInlineImage(part(ok.slice(0, -1) + '!')), null)
  assert.equal(durableInlineImage(part('')), null)
  assert.ok(durableInlineImage(part(ok)))
})
