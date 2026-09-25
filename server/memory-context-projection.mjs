// Hermes multimodal turns retain injected recall beside the user's text.
// Only the display projection changes; canonical/model history stays intact.
const MEMORY_NOTE = /^\[System note: The following is recalled memory context, NOT new user input\. Treat as (?:authoritative reference data|informational background data)/

export function visibleMemoryText(text) {
  const lines = text.split(/(?<=\n)/)
  const visible = []
  let fence = null
  let changed = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trimEnd()
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && /^ {0,3}(`+|~+)\s*$/.test(line)) fence = null
    }
    if (!fence && line === '<memory-context>' && MEMORY_NOTE.test(lines[index + 1] ?? '')) {
      let end = index + 2
      while (end < lines.length && lines[end].trim() !== '</memory-context>') end += 1
      // Incomplete display excerpts must not expose the remainder of recall.
      index = end
      changed = true
      continue
    }
    visible.push(lines[index])
  }
  return changed ? visible.join('').trimEnd() : text
}

export function projectMemoryContent(content) {
  if (typeof content === 'string') return visibleMemoryText(content)
  if (Array.isArray(content)) return content.map(projectMemoryContent).filter(part => !(part && ['text', 'input_text'].includes(part.type) && part.text === ''))
  if (!content || typeof content !== 'object') return content
  const result = { ...content }
  // Preserve image/file blocks and metadata; only text-bearing content changes.
  for (const key of ['text', 'content']) {
    if (Object.hasOwn(result, key)) result[key] = projectMemoryContent(result[key])
  }
  return result
}
