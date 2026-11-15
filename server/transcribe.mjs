// wizard_transcribe: the one way a hosted agent turns an audio or video file into text (24 Oct 2026 follow-up to the
// Philosopher installing Whisper itself). Served on the `wizard` MCP gateway for every agent. It runs inside the
// Agent Service (host side), reads the agent's OWN file, and proxies it to the box's Wizard Voice Service on
// loopback, so that service never has to be exposed to containers and agents never install speech software.
//
// Identity comes from the authenticated gateway (agentId), never from arguments. Paths are confined to the agent's
// own home: a container agent names it /opt/data/... (or a path relative to it); the host path is accepted too.
// Anything that resolves (after symlinks) outside that home, or is not a regular audio/video file, is refused.
// Transcript text is returned to the caller and never logged here.
import { spawn } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { AGENT_FILE_PLACE_LIMIT } from './agent-files.mjs'

export const TRANSCRIBE_TOOL = 'wizard_transcribe'
export const TRANSCRIBE_MAX_BYTES = 32 * 1024 * 1024 // same ceiling as the shell's /wizard/voice/transcribe upload
export const TRANSCRIBE_TIMEOUT_MS = 300_000
// Long recordings (issue 508): anything over the single-upload cap, or longer than SPLIT_SECONDS, is cut by the
// Service itself with one fixed ffmpeg command per part (never agent-written shell), each part is transcribed in
// turn, and the text is joined with a timestamp per part. Up to the inbox placement limit (2 GB).
export const TRANSCRIBE_LONG_MAX_BYTES = AGENT_FILE_PLACE_LIMIT
export const TRANSCRIBE_PART_SECONDS = 600
export const TRANSCRIBE_SPLIT_SECONDS = 1800
// A call waits this long for a long job, then answers "working" so the agent calls again (Hermes stops an MCP call at 300 s).
export const TRANSCRIBE_WAIT_MS = 240_000
const LONG_TEXT_LIMIT = 1_000_000
const JOB_KEEP_MS = 30 * 60_000
const MAX_PARTS = 2000
const MAX_IN_FLIGHT = 2
const CONTAINER_HOME = '/opt/data'
const MODES = ['meeting', 'verbatim', 'dictation']
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.webm', '.mp4', '.mov', '.mkv', '.amr', '.3gp', '.wma', '.caf'])

const TOOL = {
  name: TRANSCRIBE_TOOL,
  description: '[WizardOS] Transcribe an audio or voice file (wav, mp3, m4a, ogg, opus, flac, webm, mp4 …) to text with the box\'s own Wizard Voice Service. Use this for ANY audio or voice transcription request. Never install Whisper, faster-whisper or any other local speech software, and never download speech models: this tool is the transcriber. Pass the file\'s path inside your own home, e.g. /opt/data/inbox/2026-11-11/note.m4a (or a path relative to it). Recordings of any length work (up to 2 GB): the service splits long ones itself, transcribes the parts and joins the text with [h:mm:ss] timestamps. Never split, cut or convert audio yourself (no ffmpeg, no shell loops). A long recording can take a while: if the answer says status "working", call wizard_transcribe again with the same path and arguments to wait for the transcript.',
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
 * Resolve, then open the file through ONE pinned descriptor so a container agent cannot swap the validated file for a
 * symlink between the check and the read (TOCTOU). The descriptor is opened O_NOFOLLOW, must be a single-link regular
 * file within the size cap, and its own /proc path must still sit inside the agent's home (this also catches a parent
 * directory swapped for a symlink). Returns { fd, name, info }; the caller closes fd.
 */
export function openAgentAudio(home, raw, maxBytes) {
  const file = resolveAgentAudioPath(home, raw)
  const realHome = realpathSync(resolve(home))
  let fd
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch { refuse('The file could not be opened.') }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1) refuse('That path is not a plain file.')
    if (info.size < 1) refuse('That file is empty.')
    if (info.size > maxBytes) refuse(`That file is ${Math.ceil(info.size / 1048576)} MB; the limit is ${Math.floor(maxBytes / 1048576)} MB. Ask the owner for a shorter recording.`)
    let actual = ''
    try { actual = realpathSync(`/proc/self/fd/${fd}`) } catch { /* no /proc: the O_NOFOLLOW + fstat checks above still hold */ }
    if (actual && !within(realHome, actual)) refuse('That path is outside your own files. Use a path inside your home (/opt/data/...).')
    return { fd, name: basename(file), info }
  } catch (error) { closeSync(fd); throw error }
}

const readAll = (fd, size) => {
  const buffer = Buffer.alloc(size)
  let got = 0
  let n
  while (got < buffer.length && (n = readSync(fd, buffer, got, buffer.length - got, 0 + got)) > 0) got += n
  return buffer.subarray(0, got)
}

/** openAgentAudio, then read the whole file (within maxBytes). Returns { name, bytes }. */
export function readAgentAudio(home, raw, maxBytes) {
  const { fd, name, info } = openAgentAudio(home, raw, maxBytes)
  try { return { name, bytes: readAll(fd, info.size) } } finally { closeSync(fd) }
}

/**
 * The fixed ffmpeg/ffprobe commands the Service owns. The pinned descriptor is handed to the child as fd 3 and read as
 * /dev/fd/3 (a fresh, seekable open of the SAME file, so mp4/m4a with the index at the end work too). No shell, no
 * agent text in argv. `probe` -> seconds or null; `cut` -> one mono 16 kHz WAV part (Buffer, possibly empty).
 */
export function ffmpegMedia({ ffmpeg = process.env.WIZARD_FFMPEG || 'ffmpeg', ffprobe = process.env.WIZARD_FFPROBE || 'ffprobe', spawnImpl = spawn, timeoutMs = 120_000 } = {}) {
  const run = (bin, args, fd, limit) => new Promise((resolveRun, rejectRun) => {
    let child
    try { child = spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe', fd], windowsHide: true }) } catch (error) { rejectRun(error); return }
    const out = []
    let size = 0
    let err = ''
    let over = false
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', (chunk) => { size += chunk.length; if (size > limit) { over = true; child.kill('SIGKILL') } else out.push(chunk) })
    child.stderr.on('data', (chunk) => { if (err.length < 4096) err += chunk })
    child.on('error', (error) => { clearTimeout(timer); rejectRun(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (over) rejectRun(Object.assign(new Error('part too large'), { code: 'EPART' }))
      else if (code !== 0) rejectRun(Object.assign(new Error(`exit ${code}`), { code: 'EMEDIA', detail: err.slice(0, 300) }))
      else resolveRun(Buffer.concat(out))
    })
  })
  return {
    async probe(fd) {
      try {
        const raw = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', '/dev/fd/3'], fd, 4096)
        const seconds = Number.parseFloat(raw.toString('utf8').trim())
        return Number.isFinite(seconds) && seconds > 0 ? seconds : null
      } catch { return null }
    },
    async cut(fd, start, seconds) {
      const wav = await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(seconds), '-i', '/dev/fd/3', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-f', 'wav', 'pipe:1'], fd, 64 * 1024 * 1024)
      return sealWav(wav)
    },
  }
}

// ffmpeg writing WAV to a pipe cannot seek back, so the RIFF and data sizes stay 0xFFFFFFFF: fill them in, so every
// transcriber reads the part as an ordinary WAV.
export function sealWav(wav) {
  if (wav.length >= 44 && wav.toString('latin1', 0, 4) === 'RIFF' && wav.toString('latin1', 36, 40) === 'data') {
    wav.writeUInt32LE(wav.length - 8, 4)
    wav.writeUInt32LE(wav.length - 44, 40)
  }
  return wav
}

const clock = (seconds) => {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
// 16 kHz mono 16-bit = 32,000 bytes a second; a part with under a quarter second of audio is the end of the file.
const WAV_HEADER = 44
const audioSeconds = (wav) => Math.max(0, wav.length - WAV_HEADER) / 32_000

/**
 * Built-in gateway tool for createAgentBridge({ builtins }).
 * `homeOf(agentId)` -> the agent's home folder on the host ('' = none). `allowed(agentId)` says whether the agent may use
 * the tool at all (private agents may not: their audio must not reach the shared voice service's owner buffers). `sttOrigin` is the Wizard Voice Service.
 * `modelInfo()` -> {id, segments} of a Speaches-shaped transcriber (the same discovery the shell's voice routes use); `readingOf`
 * turns its reply into text (drops Whisper's invented words for silence). `enabled()` false (WIZARD_STT_ENABLED=0) hides the tool, so no agent is promised a transcriber the box lacks.
 */
export function transcribeTool({ homeOf, allowed = () => true, sttOrigin, fetchImpl = fetch, enabled = () => true, maxBytes = TRANSCRIBE_MAX_BYTES, longMaxBytes = TRANSCRIBE_LONG_MAX_BYTES, partSeconds = TRANSCRIBE_PART_SECONDS, splitSeconds = TRANSCRIBE_SPLIT_SECONDS, waitMs = TRANSCRIBE_WAIT_MS, media = ffmpegMedia(), modelInfo = async () => ({}), readingOf = (value) => (typeof value?.text === 'string' ? value.text : ''), timeoutMs = TRANSCRIBE_TIMEOUT_MS, log = () => {} }) {
  let inFlight = 0
  // Long jobs by agent + file identity + options, so a repeat call (after a "working" answer) joins the same job.
  const jobs = new Map()

  // One upload to the voice service. Returns { text, no_speech?, provider, model } or { error } (an agent-facing line).
  async function transcribeBytes(agentId, bytes, name, mode, language) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const form = new FormData()
      form.append('file', new Blob([bytes]), name)
      const info = await modelInfo().catch(() => ({}))
      if (info?.id) form.append('model', info.id)
      if (info?.segments) form.append('response_format', 'verbose_json')
      form.append('mode', mode)
      if (language) form.append('language', language)
      let upstream
      try {
        upstream = await fetchImpl(`${sttOrigin}/v1/audio/transcriptions`, { method: 'POST', body: form, redirect: 'error', signal: controller.signal })
      } catch (error) {
        const timedOut = controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError'
        log(`transcribe ${agentId}: ${timedOut ? 'timeout' : 'voice service unreachable'}`)
        return {
          error: timedOut
            ? 'The transcription took too long and was stopped. Try a shorter recording.'
            : 'The Wizard Voice Service is not reachable right now, so nothing was transcribed. Tell the owner and try again later; do not install speech software.',
          retry: true,
        }
      }
      const raw = Buffer.from(await upstream.arrayBuffer())
      if (raw.length > 4 * 1024 * 1024) { log(`transcribe ${agentId}: oversize reply`); return { error: 'The transcriber returned an unusable reply.' } }
      let value = null
      try { value = JSON.parse(raw.toString('utf8')) } catch { /* not JSON */ }
      if (upstream.status === 422 && /^no speech detected$/iu.test(String(value?.detail ?? '').trim())) return { text: '', no_speech: true, provider: '', model: '' }
      if (!upstream.ok || !value || typeof value !== 'object') {
        log(`transcribe ${agentId}: voice service answered ${upstream.status}`)
        return { error: `The Wizard Voice Service could not transcribe this file (HTTP ${upstream.status}). Tell the owner; do not install speech software.`, retry: upstream.status >= 500 }
      }
      const text = readingOf(value).trim().slice(0, 200_000)
      return {
        text, ...(text ? {} : { no_speech: true }),
        provider: typeof value.provider === 'string' ? value.provider.slice(0, 80) : '',
        model: typeof value.model === 'string' ? value.model.slice(0, 120) : '',
      }
    } finally { clearTimeout(timer) }
  }

  // The whole long job: cut part after part with the fixed ffmpeg command, transcribe each, join with timestamps.
  async function runLong(job, agentId, fd, duration, mode, language) {
    const started = Date.now()
    const lines = []
    let provider = ''
    let model = ''
    let heard = 0
    const total = duration ? Math.max(1, Math.ceil(duration / partSeconds)) : null
    job.total = total
    // The probed duration is a hint (VBR mp3 estimates run short): keep cutting until a part comes back empty.
    const last = total === null ? MAX_PARTS : Math.min(MAX_PARTS, total + 2)
    for (let index = 0; index < last; index += 1) {
      const start = index * partSeconds
      const past = index > 0 && (total === null || index >= total)
      let wav
      try { wav = await media.cut(fd, start, partSeconds) } catch (error) {
        if (error?.code === 'ENOENT') return { error: 'This box cannot split long recordings yet (ffmpeg is missing from the Agent Service). Tell the owner; do not split or convert the file yourself.' }
        if (past) break
        log(`transcribe ${agentId}: could not cut part ${index + 1}`)
        return { error: 'The Agent Service could not read this recording to split it (it may be damaged or not really audio). Tell the owner; do not split or convert the file yourself.' }
      }
      if (audioSeconds(wav) < 0.25) { if (past || total === null) break; continue }
      let reply = await transcribeBytes(agentId, wav, `part-${String(index + 1).padStart(4, '0')}.wav`, mode, language)
      if (reply.error && reply.retry) reply = await transcribeBytes(agentId, wav, `part-${String(index + 1).padStart(4, '0')}.wav`, mode, language)
      if (reply.error) return { error: `${reply.error} (stopped at ${clock(start)} of the recording)` }
      if (reply.text) { lines.push(`[${clock(start)}] ${reply.text}`); heard += 1 }
      provider ||= reply.provider
      model ||= reply.model
      job.done = index + 1
    }
    let text = lines.join('\n\n')
    const truncated = text.length > LONG_TEXT_LIMIT
    if (truncated) text = text.slice(0, LONG_TEXT_LIMIT)
    return {
      value: {
        text, ...(heard ? {} : { no_speech: true }), mode, provider, model,
        parts: job.done, ...(duration ? { duration_s: Math.round(duration) } : {}), timestamps: true, ...(truncated ? { truncated: true } : {}),
        ms: Date.now() - started,
      },
    }
  }

  const answer = (job) => (job.result.error ? bad(job.result.error) : ok(job.result.value))

  async function waitFor(job) {
    let timer
    const finished = await Promise.race([job.promise.then(() => true), new Promise((r) => { timer = setTimeout(() => r(false), waitMs) })])
    clearTimeout(timer)
    if (finished) return answer(job)
    return ok({
      status: 'working', parts_done: job.done, ...(job.total ? { parts_total: job.total } : {}),
      message: 'Still transcribing this long recording. Call wizard_transcribe again with the same path and arguments to keep waiting for the transcript. Do not split or convert the file yourself.',
    })
  }

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
      let opened
      try {
        opened = openAgentAudio(homeOf(agentId), args.path, Math.max(maxBytes, longMaxBytes))
      } catch (error) {
        if (error instanceof Refusal) return bad(error.message)
        return bad('The file could not be read.')
      }
      const { fd, info } = opened
      let handedOff = false
      try {
        const key = [agentId, info.dev, info.ino, info.size, info.mtimeMs, mode, language].join('\0')
        const existing = jobs.get(key)
        if (existing) return await waitFor(existing)
        const duration = await media.probe(fd)
        const long = info.size > maxBytes || (duration !== null && duration > splitSeconds)
        if (inFlight >= MAX_IN_FLIGHT) return bad('The transcriber is busy with other recordings. Try again in a minute.')
        if (!long) {
          inFlight += 1
          try {
            const started = Date.now()
            const reply = await transcribeBytes(agentId, readAll(fd, info.size), opened.name, mode, language)
            if (reply.error) return bad(reply.error)
            return ok({ text: reply.text, ...(reply.no_speech ? { no_speech: true } : {}), mode, provider: reply.provider, model: reply.model, ms: Date.now() - started })
          } finally { inFlight -= 1 }
        }
        inFlight += 1
        handedOff = true
        const job = { done: 0, total: null, result: null, promise: null }
        job.promise = runLong(job, agentId, fd, duration, mode, language)
          .catch(() => ({ error: 'The transcription failed. Tell the owner; do not split or convert the file yourself.' }))
          .then((result) => {
            job.result = result
            inFlight -= 1
            closeSync(fd)
            setTimeout(() => { if (jobs.get(key) === job) jobs.delete(key) }, JOB_KEEP_MS).unref?.()
          })
        jobs.set(key, job)
        return await waitFor(job)
      } finally {
        if (!handedOff) closeSync(fd)
      }
    },
  }
}
