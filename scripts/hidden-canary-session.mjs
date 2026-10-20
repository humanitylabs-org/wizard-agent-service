// Test traffic may share a real agent runtime; hide it before sending any input.
// Creation APIs may ignore `hidden`, so PATCH and read back before returning.
export async function createHiddenCanarySession(origin, session, fetchImpl = fetch) {
  const call = async (path, method = 'GET', body) => {
    const response = await fetchImpl(origin + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!response.ok) throw new Error(`Hidden canary ${method} failed (${response.status})`)
    return response.json()
  }
  const path = `/wizard/hermes/api/sessions/${encodeURIComponent(session.id)}`
  await call('/wizard/hermes/api/sessions', 'POST', { ...session, hidden: true })
  await call(path, 'PATCH', { hidden: true })
  const result = await call(path)
  if (result.session?.hidden !== true) throw new Error('Refusing test input: canary is not hidden')
  return result.session
}
