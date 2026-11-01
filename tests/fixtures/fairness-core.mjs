// Isolated synthetic Voice Core + Hermes HTTP transport for fairness tests.
import { createServer } from 'node:http'
import { parentPort, workerData } from 'node:worker_threads'

if (parentPort) {
  const runs = new Map(), messages = workerData.messages
  let nextRun = 0
  const json = (res, value) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const url = new URL(req.url, 'http://stub.invalid'), body = Buffer.concat(chunks)
    if (url.pathname === '/v1/audio/transcriptions') {
      setTimeout(() => json(res, { text: 'Synthetic voice message.' }), 20); return
    }
    if (url.pathname === '/v1/runs' && req.method === 'POST') {
      const input = JSON.parse(body), run = { run_id: `synthetic_${++nextRun}`, session_id: input.session_id, status: 'completed', output: 'Synthetic reply.' }
      runs.set(run.run_id, run); json(res, run); return
    }
    if (url.pathname.startsWith('/v1/runs/')) { json(res, runs.get(url.pathname.split('/')[3]) ?? { status: 'completed' }); return }
    if (url.pathname === '/v1/capabilities') { json(res, { features: {} }); return }
    if (/\/messages$/.test(url.pathname)) { json(res, { data: messages.get(url.pathname.split('/')[3]) ?? [] }); return }
    if (url.pathname.startsWith('/api/sessions/')) { json(res, { session: { id: url.pathname.split('/')[3], archived: false } }); return }
    json(res, { data: [], status: 'ok' })
  })
  server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }))
  parentPort.on('message', () => {
    server.closeAllConnections(); server.close(() => parentPort.close())
  })
}
