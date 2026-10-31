import { parentPort, workerData } from 'node:worker_threads'
import { createListEvidenceReader } from './list-evidence.mjs'

const reader = parentPort ? createListEvidenceReader(workerData.hermesStatePath) : null
parentPort?.on('message', ({ id, input }) => {
  try { parentPort.postMessage({ id, value: reader.read(input) }) }
  catch { parentPort.postMessage({ id, error: 'list evidence read failed' }) }
})
parentPort?.on('close', () => reader.close())
