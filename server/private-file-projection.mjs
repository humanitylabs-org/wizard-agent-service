// Stored recovery notes can legitimately mention a server-held attachment path.
// Redact only configured attachment locations in the display response; never
// alter canonical history or turn input, or relax the separate credential guard.
export function projectPrivateFilePaths(result, trustedPaths) {
  const roots = [...new Set(trustedPaths.filter((value) => typeof value === 'string' && value.length > 1))]
    .sort((a, b) => b.length - a.length)
  if (!roots.length) return result
  const patterns = roots.map((root) => new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\s"'<>\x60\\]\\)},;]*`, 'g'))
  const visit = (value) => {
    if (typeof value === 'string') return patterns.reduce((text, pattern) => text.replace(pattern, '[private attachment]'), value)
    if (Array.isArray(value)) return value.map(visit)
    if (value && typeof value === 'object') {
      const projected = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]))
      if (value.display_kind === 'run_context' && typeof value.run_context?.original === 'string'
        && projected.run_context?.original !== value.run_context.original) projected.run_context.redacted = true
      return projected
    }
    return value
  }
  try { return Buffer.from(JSON.stringify(visit(JSON.parse(result.toString('utf8'))))) }
  catch { return result } // Malformed/non-JSON responses retain the fail-closed guard.
}
