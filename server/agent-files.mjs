import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export const AGENT_FILE_PLACE_LIMIT = 25 * 1024 * 1024

/** Project owner-resolved files into an agent's view; never serialize host paths. */
export async function placeAgentFiles(agent, files, runtime) {
  const projected = []
  for (const file of files) {
    const localPath = Object.hasOwn(file, 'localPath') ? file.localPath : file.trusted_path
    const publicFile = { id: file.id, filename: file.filename, mime: file.mime, bytes: file.bytes, sha256: file.sha256, localPath }
    try {
      if (agent.runtime.kind === 'profile' || !runtime?.place) throw new Error('unavailable')
      if (file.bytes < 1 || file.bytes > AGENT_FILE_PLACE_LIMIT) throw new Error('too_large')
      const bytes = readFileSync(localPath)
      if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('changed')
      const placed = await runtime.place(agent.id, { filename: file.filename, data_base64: bytes.toString('base64'), sha256: file.sha256 })
      if (!placed?.verified || !/^\/opt\/data\/inbox\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(placed.path)) throw new Error('invalid_path')
      publicFile.trusted_path = placed.path
    } catch {
      // Native image parts are still built from localPath. Do not leak helper errors/host paths.
      publicFile.placement_error = 'Durable copy unavailable; use native image content if provided. Non-image file contents are unavailable.'
    }
    projected.push(publicFile)
  }
  return projected
}
