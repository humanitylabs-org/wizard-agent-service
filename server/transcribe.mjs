// wizard_transcribe: the one way a hosted agent turns an audio or video file into text (24 Oct 2026 follow-up to the
// Philosopher installing Whisper itself). Served on the `wizard` MCP gateway for every agent. It runs inside the
// Agent Service (host side), reads the agent's OWN file, and proxies it to the box's Wizard Voice Service on
// loopback, so that service never has to be exposed to containers and agents never install speech software.
//
// Identity comes from the authenticated gateway (agentId), never from arguments. Paths are confined to the agent's
// own home: a container agent names it /opt/data/... (or a path relative to it); the host path is accepted too.
// Anything that resolves (after symlinks) outside that home, or is not a regular audio/video file, is refused.
// Transcript text is returned to the caller and never logged here.
import { lstatSync, realpathSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'

export const TRANSCRIBE_TOOL = 'wizard_transcribe'
export const TRANSCRIBE_MAX_BYTES = 32 * 1024 * 1024 // same ceiling as the shell's /wizard/voice/transcribe upload
export const TRANSCRIBE_TIMEOUT_MS = 300_000
const MAX_IN_FLIGHT = 2
const CONTAINER_HOME = '/opt/data'
const MODES = ['meeting', 'verbatim', 'dictation']
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.webm', '.mp4', '.mov', '.mkv', '.amr', '.3gp', '.wma', '.caf'])

const TOOL = {
  name: TRANSCRIBE_TOOL,
  description: '[Wizard OS] Transcribe an audio or voice file (wav, mp3, m4a, ogg, opus, flac, webm, mp4 …) to text with the box\'s own Wizard Voice Service. Use this for ANY audio or voice transcription request. Never install Whisper, faster-whisper or any other local speech software, and never download speech models: this tool is the transcriber. Pass the file\'s path inside your own home, e.g. /opt/data/inbox/2026-11-11/note.m4a (or a path relative to it). Long recordings are split and joined by the service; allow a few minutes. Files up to 32 MB.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the audio/video file inside your own home, e.g. /opt/data/inbox/2026-11-11/note.m4a.' },
      mode: { type: 'string', enum: MODES, description: 'meeting (default: recorded speech or conversation, kept out of the owner\'s dictation sample buffer), verbatim (literal words) or dictation (cleaned up as if typed).' },
      language: { type: 'string', description: 'Optional ISO language code (e.g. en, es). Omit to let the service decide.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
}

const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const bad = (text) => ({ content: [{ type: 'text', text }], isError: true })

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message) }

const within = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

/**
 * Resolve the agent-supplied path to a real file under `home`. Returns the real host path.
 * Refuses: empty/NUL paths, `..` segments, anything outside the home (also via symlinks), non-files, non-audio types.
 */
export function resolveAgentAudioPath(home, raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024 || raw.includes('\0')) refuse('path must be a file path inside your own home, such as /opt/data/inbox/<date>/<file>.')
  const given = raw.trim()
  if (given.split(/[\\/]+/u).includes('..')) refuse('That path is outside your own files. Use a path inside your home (/opt/data/...).')
  if (!home) refuse('No home folder is available for this agent, so there is no file to read.')
  let realHome
  try { realHome = realpathSync(resolve(home)) } catch { refuse('Your home folder is not available on the box.') }
  let candidate
  if (given === CONTAINER_HOME || given.startsWith(`${CONTAINER_HOME}/`)) candidate = join(realHome, given.slice(CONTAINER_HOME.length))
  else if (isAbsolute(given)) candidate = resolve(given)
  else candidate = join(realHome, given)
  if (!within(realHome, resolve(candidate))) refuse('That path is outside your own files. Use a path inside your home (/opt/data/...).')
  let real
  try { real = realpathSync(candidate) } catch { refuse('No such file. Check the path (your home is /opt/data).') }
  if (!within(realHome, real)) refuse('That path is outside your own files. Use a path inside your home (/opt/data/...).')
  let info
  try { info = lstatSync(real) } catch { refuse('No such file.') }
  if (!info.isFile()) refuse('That path is not a file.')
  if (!AUDIO_EXTENSIONS.has(extname(real).toLowerCase())) refuse('That does not look like an audio or video file (wav, mp3, m4a, ogg, opus, flac, webm, mp4, …).')
  return real
}

/**
 * Built-in gateway tool for createAgentBridge({ builtins }).
 * `homeOf(agentId)` -> the agent's home folder on the host ('' = none). `allowed(agentId)` says whether the agent may use
 * the tool at all (private agents may not: their audio must not reach the shared voice service's owner buffers). `sttOrigin` is the Wizard Voice Service.
 * `enabled()` false (WIZARD_STT_ENABLED=0) hides the tool, so no agent is promised a transcriber the box lacks.
 */
export function transcribeTool({ homeOf, allowed = () => true, sttOrigin, fetchImpl = fetch, enabled = () => true, maxBytes = TRANSCRIBE_MAX_BYTES, timeoutMs = TRANSCRIBE_TIMEOUT_MS, log = () => {} }) {
  let inFlight = 0
  return {
    list: (agentId) => (enabled() && (!agentId || allowed(agentId)) ? [TOOL] : []),
    async call(name, args = {}, agentId) {
      if (name !== TRANSCRIBE_TOOL) return undefined
      if (!enabled()) return bad('Transcription is switched off on this box. Tell the owner; do not install speech software.')
      if (!agentId || !allowed(agentId)) return bad('wizard_transcribe is not available to this agent.')
      if (!args || typeof args !== 'object' || Array.isArray(args)) return bad('Arguments must be an object with a path.')
      const mode = args.mode === undefined ? 'meeting' : args.mode
      if (!MODES.includes(mode)) return bad(`mode must be one of ${MODES.join(', ')}.`)
      let language = ''
      if (args.language !== undefined) {
        language = typeof args.language === 'string' ? args.language.trim() : ''
        if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/u.test(language)) return bad('language must be an ISO code such as en or es.')
      }
      let file
      try {
        file = resolveAgentAudioPath(homeOf(agentId), args.path)
        const size = statSync(file).size
        if (size < 1) return bad('That file is empty.')
        if (size > maxBytes) return bad(`That file is ${Math.ceil(size / 1048576)} MB; the limit is ${Math.floor(maxBytes / 1048576)} MB. Ask the owner for a shorter recording, or split it.`)
      } catch (error) {
        if (error instanceof Refusal) return bad(error.message)
        return bad('The file could not be read.')
      }
      if (inFlight >= MAX_IN_FLIGHT) return bad('The transcriber is busy with other recordings. Try again in a minute.')
      inFlight += 1
      const started = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const form = new FormData()
        form.append('file', new Blob([readFileSync(file)]), basename(file))
        form.append('mode', mode)
        if (language) form.append('language', language)
        let upstream
        try {
          upstream = await fetchImpl(`${sttOrigin}/v1/audio/transcriptions`, { method: 'POST', body: form, redirect: 'error', signal: controller.signal })
        } catch (error) {
          const timedOut = controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError'
          log(`transcribe ${agentId}: ${timedOut ? 'timeout' : 'voice service unreachable'}`)
          return bad(timedOut
            ? 'The transcription took too long and was stopped. Try a shorter recording.'
            : 'The Wizard Voice Service is not reachable right now, so nothing was transcribed. Tell the owner and try again later; do not install speech software.')
        }
        const raw = Buffer.from(await upstream.arrayBuffer())
        if (raw.length > 4 * 1024 * 1024) { log(`transcribe ${agentId}: oversize reply`); return bad('The transcriber returned an unusable reply.') }
        let value = null
        try { value = JSON.parse(raw.toString('utf8')) } catch { /* not JSON */ }
        if (upstream.status === 422 && /^no speech detected$/iu.test(String(value?.detail ?? '').trim())) return ok({ text: '', no_speech: true, mode, ms: Date.now() - started })
        if (!upstream.ok || typeof value?.text !== 'string') {
          log(`transcribe ${agentId}: voice service answered ${upstream.status}`)
          return bad(`The Wizard Voice Service could not transcribe this file (HTTP ${upstream.status}). Tell the owner; do not install speech software.`)
        }
        const text = value.text.trim().slice(0, 200_000)
        return ok({
          text, ...(text ? {} : { no_speech: true }), mode,
          provider: typeof value.provider === 'string' ? value.provider.slice(0, 80) : '',
          model: typeof value.model === 'string' ? value.model.slice(0, 120) : '',
          ms: Date.now() - started,
        })
      } finally {
        clearTimeout(timer)
        inFlight -= 1
      }
    },
  }
}
