// Android URLUtil's legacy parser only accepts a terminal quoted filename.
// Even appending filename*= after it makes that parser fall back to the URL ID.
export function contentDisposition(disposition, filename) {
  let name = String(filename).replace(/[\\/\p{Cc}]/gu, '_').trim().slice(0, 240)
  if (!name || name === '.' || name === '..') name = 'download'
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  if (name === fallback) return `${disposition}; filename="${name}"`
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}
