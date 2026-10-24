// Narrow compatibility adapters for the pinned Mac MVP app recipes. Never alter unrelated apps.
// The upstreams keep their root routes; only the browser-facing base path changes.
export function adaptAppView(id, path, type, bytes) {
  if (!['files', 'wizard-ai-accounts'].includes(id) || !/text\/html|(?:application|text)\/javascript/.test(type)) return bytes
  let text = bytes.toString('utf8')
  const base = `/apps/${id}`
  if (type.includes('text/html')) {
    text = text.replace(/\b(href|src|data-src)=(['"])\/(?!\/)/g, `$1=$2${base}/`)
    if (id === 'files' && text.includes('window.FileBrowser =')) {
      text = text.replace(/"BaseURL":""/g, `"BaseURL":"${base}"`)
        .replace(/"StaticURL":"\/static"/g, `"StaticURL":"${base}/static"`)
    }
  }
  if (id === 'wizard-ai-accounts' && path.endsWith('/app.js') && /javascript/.test(type)) {
    // Audited app.js routes are all root-relative /api/...; keep them on this app's projection.
    text = text.replace('fetch(path, {', `fetch(${JSON.stringify(base)} + path, {`)
  }
  return Buffer.from(text)
}
