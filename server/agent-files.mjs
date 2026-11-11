import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'

// Small files go to a container agent inline (base64 in one JSON request to the runtime helper).
export const AGENT_FILE_INLINE_LIMIT = 25 * 1024 * 1024
// Larger owner attachments (long recordings, videos) are streamed to the runtime helper instead.
// Keep equal to PLACE_STREAM_LIMIT in ops/agent-runtime/agent_runtime.py.
export const AGENT_FILE_PLACE_LIMIT = 2 * 1024 * 1024 * 1024

const MB = 1024 * 1024
export const megabytes = (bytes) => `${Math.max(1, Math.round(Number(bytes) / MB))} MB`

class PlacementError extends Error {
  constructor(code) { super(code); this.code = code }
}

async function hashFile(path) {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) { hash.update(chunk); size += chunk.length }
  return { size, sha256: hash.digest('hex') }
}

/**
 * Plain reason for a refused or failed copy, written so the agent can pass it on to the owner.
 * Fixed wording plus the file's own name and size only: never helper errors or host paths.
 */
export function placementReason(code, file, limit = AGENT_FILE_PLACE_LIMIT) {
  const name = String(file?.filename || 'The file').replace(/\p{Cc}/gu, '').slice(0, 200)
  switch (code) {
    case 'too_large':
    case 'file_too_large':
      return `${name} is ${megabytes(file?.bytes)}; the limit for files sent to an agent is ${megabytes(limit)}.`
    case 'empty':
      return `${name} is empty.`
    case 'changed':
      return `${name} changed after it was attached; attach it again.`
    case 'insufficient_space':
      return `there is not enough free disk space in this agent's home for ${name} (${megabytes(file?.bytes)}).`
    case 'agent_files_disabled':
      return 'this agent is not allowed to receive files.'
    case 'runtime_unreachable':
    case 'unavailable':
    case 'stream_unavailable':
    case 'not_found':
      return `${name} could not be copied because the agent runtime is not reachable or is out of date.`
    default:
      return `${name} could not be copied to this agent.`
  }
}

const placementError = (reason) => `Not copied to your files: ${reason} Tell the owner this reason plainly. Use native image content if provided; otherwise the file's contents are unavailable.`

/** Project owner-resolved files into an agent's view; never serialize host paths. */
export async function placeAgentFiles(agent, files, runtime, { inlineLimit = AGENT_FILE_INLINE_LIMIT, limit = AGENT_FILE_PLACE_LIMIT } = {}) {
  const projected = []
  for (const file of files) {
    const localPath = Object.hasOwn(file, 'localPath') ? file.localPath : file.trusted_path
    const publicFile = { id: file.id, filename: file.filename, mime: file.mime, bytes: file.bytes, sha256: file.sha256, localPath }
    try {
      if (!(file.bytes >= 1)) throw new PlacementError('empty')
      if (agent.runtime.kind !== 'profile' && file.bytes > limit) throw new PlacementError('too_large')
      // Streamed hash: a recording of hundreds of MB is never held in memory just to check it.
      const seen = await hashFile(localPath)
      if (seen.size !== file.bytes || seen.sha256 !== file.sha256) throw new PlacementError('changed')
      if (agent.runtime.kind === 'profile') {
        // /p/<profile> runs in the same Hermes API host/filesystem view as
        // main. Use the already-resolved agent-visible path (not Service's
        // localPath and never a path guessed from the profile's home). This
        // is an explicit owner attachment, not a broader file grant. Nothing
        // is copied, so no size cap applies.
        if (typeof file.trusted_path !== 'string' || !file.trusted_path.startsWith('/')) throw new PlacementError('unavailable')
        publicFile.trusted_path = file.trusted_path
        projected.push(publicFile)
        continue
      }
      let placed
      if (file.bytes <= inlineLimit) {
        if (!runtime?.place) throw new PlacementError('unavailable')
        const chunks = []
        for await (const chunk of createReadStream(localPath)) chunks.push(chunk)
        const bytes = Buffer.concat(chunks)
        if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new PlacementError('changed')
        placed = await runtime.place(agent.id, { filename: file.filename, data_base64: bytes.toString('base64'), sha256: file.sha256 })
      } else {
        // The helper re-hashes what it wrote, so a file that changes mid-stream is refused there.
        if (!runtime?.placeStream) throw new PlacementError('stream_unavailable')
        placed = await runtime.placeStream(agent.id, { filename: file.filename, sha256: file.sha256, bytes: file.bytes, open: () => createReadStream(localPath) })
      }
      if (!placed?.verified || !/^\/opt\/data\/inbox\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(placed.path)) throw new PlacementError('invalid_path')
      publicFile.trusted_path = placed.path
    } catch (error) {
      // Native image parts are still built from localPath. Only fixed reasons reach the agent:
      // helper errors are bounded symbolic codes that are mapped, never echoed, so host paths cannot leak.
      const code = error instanceof PlacementError ? error.code : String(error?.code || '')
      publicFile.placement_error = placementError(placementReason(code, file, limit))
    }
    projected.push(publicFile)
  }
  return projected
}
