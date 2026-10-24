import { describe, expect, it } from 'vitest'
import { controlBoundary } from '../server/control-boundary.mjs'

const opts = { allowedHosts: ['127.0.0.1:48023'], appsOrigin: 'http://localhost:48023' }
const req = (url: string, headers: Record<string, string>, method = 'GET') =>
  ({ method, url, headers: { host: '127.0.0.1:48023', ...headers }, socket: {} })
const nav = (site: string) => ({ 'sec-fetch-site': site, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })

describe('control boundary entry navigation (#95)', () => {
  it('lets the Mac front door (:48030) hand off to Wizard (:48023) with a same-site top-level load', () => {
    expect(controlBoundary(req('/wizard-os-home/?session=x', nav('same-site')), opts)).toBe(true)
    for (const p of ['/wizard', '/wizard/', '/wizard-os-home']) expect(controlBoundary(req(p, nav('same-site')), opts)).toBe(true)
  })
  it('keeps every other same-site or cross-site request out', () => {
    expect(controlBoundary(req('/wizard/v1/sessions', nav('same-site')), opts)).toBe(false)
    expect(controlBoundary(req('/wizard-os-home/', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }), opts)).toBe(false)
    expect(controlBoundary(req('/wizard-os-home/', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }), opts)).toBe(false)
    expect(controlBoundary(req('/wizard-os-home/', nav('same-site'), 'POST'), opts)).toBe(false)
    expect(controlBoundary(req('/wizard/v1/sessions', nav('cross-site')), opts)).toBe(false)
  })
  it('never lets the apps origin act as the control origin', () => {
    expect(controlBoundary({ method: 'GET', url: '/wizard-os-home/', headers: { host: 'localhost:48023', ...nav('same-site') }, socket: {} }, opts)).toBe(false)
  })
  it('leaves same-origin, none and cross-site entry as before', () => {
    for (const s of ['none', 'same-origin', 'cross-site']) expect(controlBoundary(req('/wizard-os-home/', nav(s)), opts)).toBe(true)
  })
})
