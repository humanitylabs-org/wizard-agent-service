import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createWizardServer, listen, WIZARD_RUN_INSTRUCTIONS } from '../server/service.mjs'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function startUpstream(joinSupported: boolean) {
  let admissions = 0
  let admittedBody: Record<string, unknown> | null = null
  const upstream = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'GET' && request.url === '/v1/capabilities') {
      response.end(JSON.stringify({
        features: {
          delegation_delivery: joinSupported
            ? { supported: true, modes: ['background', 'join'], default: 'background' }
            : { supported: true, modes: ['background'], default: 'background' },
        },
      }))
      return
    }
    if (request.method === 'POST' && request.url === '/v1/runs') {
      admissions += 1
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      admittedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      response.writeHead(202).end(JSON.stringify({ run_id: 'run-joined', status: 'started' }))
      return
    }
    response.writeHead(404).end('{}')
  })
  servers.push(upstream)
  const address = await listen(upstream)
  return {
    origin: `http://127.0.0.1:${(address as import('node:net').AddressInfo).port}`,
    admissions: () => admissions,
    admittedBody: () => admittedBody,
  }
}

async function startWizard(upstreamOrigin: string) {
  const wizard = createWizardServer({ upstreamOrigin, hermesKey: 'fixture-key', requireAccess: false })
  servers.push(wizard)
  const address = await listen(wizard)
  return `http://127.0.0.1:${(address as import('node:net').AddressInfo).port}`
}

describe('Wizard delegated-work ownership contract', () => {
  it('fails closed before admission when Hermes cannot join delegated work', async () => {
    const upstream = await startUpstream(false)
    const wizard = await startWizard(upstream.origin)

    const response = await fetch(`${wizard}/wizard/hermes/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'wizard-parity', input: 'finish this' }),
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'service_unavailable' })
    expect(upstream.admissions()).toBe(0)
  })

  it('admits only after Hermes proves join support and injects the full Wizard response contract', async () => {
    const upstream = await startUpstream(true)
    const wizard = await startWizard(upstream.origin)

    const response = await fetch(`${wizard}/wizard/hermes/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'wizard-parity', input: 'finish this' }),
    })

    expect(response.status).toBe(202)
    expect(upstream.admissions()).toBe(1)
    expect(upstream.admittedBody()).toMatchObject({
      session_id: 'wizard-parity',
      input: 'finish this',
      instructions: WIZARD_RUN_INSTRUCTIONS,
      delegation_delivery: 'join',
      response_rendering: 'markdown',
    })

    const instructed = await fetch(`${wizard}/wizard/hermes/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'wizard-parity-2', input: 'finish this too', instructions: 'client-owned instruction' }),
    })
    expect(instructed.status).toBe(202)
    expect(upstream.admittedBody()).toMatchObject({
      session_id: 'wizard-parity-2',
      input: 'finish this too',
      instructions: WIZARD_RUN_INSTRUCTIONS,
      delegation_delivery: 'join',
      response_rendering: 'markdown',
    })

    // The shell's screen note is the one client text that reaches the agent: after the contract, bounded.
    const note = '[Wizard OS context] James sent this by voice from Wizard UX on their phone. Window in front: Usuals (app). Visible on screen: Edit usual · Steps · tap Priority.'
    const viewed = await fetch(`${wizard}/wizard/hermes/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'wizard-parity-3', input: 'is this right?', instructions: note }),
    })
    expect(viewed.status).toBe(202)
    expect(upstream.admittedBody()).toMatchObject({
      session_id: 'wizard-parity-3',
      instructions: `${WIZARD_RUN_INSTRUCTIONS}\n\n${note}`,
    })

    const long = `[Wizard OS context] ${'x'.repeat(5000)}`
    await fetch(`${wizard}/wizard/hermes/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'wizard-parity-4', input: 'long', instructions: long }),
    })
    const bounded = String(upstream.admittedBody()?.instructions ?? "")
    expect(bounded.startsWith(WIZARD_RUN_INSTRUCTIONS)).toBe(true)
    expect(bounded.length).toBeLessThan(WIZARD_RUN_INSTRUCTIONS.length + 2500)
  })
})
