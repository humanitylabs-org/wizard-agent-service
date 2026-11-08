// Chats list v1. Keep the display normalizer in parity with wizard-ux web/live.js.
const WORKING = new Set(['submitting', 'queued', 'running', 'stopping']);
const ALIASES = { started: 'running', accepted: 'queued', pending: 'queued', waiting: 'waiting_for_approval' };
  const iso = v => {
    if (typeof v === 'number' && isFinite(v)) return new Date(Math.abs(v) < 1e12 ? v * 1000 : v).toISOString();
    const p = Date.parse(String(v ?? '')); return isFinite(p) ? new Date(p).toISOString() : new Date(0).toISOString();
  };
  const optIso = v => { if (v == null || v === '') return undefined; const s = iso(v); return s === new Date(0).toISOString() ? undefined : s; };
  const text = v => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(p => typeof p === 'string' ? p : p?.text || '').join(' ');
    if (v && typeof v === 'object') return text(v.content ?? v.text ?? '');
    return '';
  };
  const chipLabel = raw => {
    try {
      const files = JSON.parse(raw);
      if (!Array.isArray(files) || !files.length) return ' ';
      const voice = files.every(f => /^audio\//.test(f.mime || '') || /^wizard-voice-/.test(f.filename || ''));
      if (voice) return ' 🎙 Voice note ';
      const img = files.every(f => /^image\//.test(f.mime || ''));
      return img ? ` 🖼 ${files.length === 1 ? 'Photo' : files.length + ' photos'} ` : ` 📎 ${files.length === 1 ? (files[0].filename || 'File') : files.length + ' files'} `;
    } catch (e) { return ' '; }
  };
  const clean = s => String(s || '')
    .replace(/\[WIZARD_FILES_V1\]\s*([\s\S]*?)\s*\[\/WIZARD_FILES_V1\]/g, (_, j) => chipLabel(j))
    .replace(/\[WIZARD_FILE_CHIPS_V1\]\s*([\s\S]*?)\s*\[\/WIZARD_FILE_CHIPS_V1\]/g, (_, j) => chipLabel(j))
    .replace(/\[WIZARD_IMAGE_INTENT_V1\][\s\S]*?\[\/WIZARD_IMAGE_INTENT_V1\]/g, ' ')
    .replace(/^Please use the attached files?\.\s*/, '')
    .replace(/<memory-context>[\s\S]*?<\/memory-context>/g, ' ')
    .replace(/\[(?:Browser dogfooding|System note)[^\]]*\][\s\S]*$/m, ' ')
    .replace(/[#*_`>]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Provider sign-in expired (Agent Service provider-reconnect.mjs): which connection app fixes it.
  const RECONNECT = { claude: ['wizard-claude', 'Claude'], chatgpt: ['wizard-chatgpt', 'ChatGPT'] };
  function reconnectRow(v) {
    const app = v && typeof v === 'object' && v.kind === 'provider_signed_out' ? RECONNECT[v.provider] : null;
    if (!app || v.app_id !== app[0]) return null;
    return { provider: v.provider, appId: app[0], name: app[1], installed: v.installed !== false,
      appStatus: ['connected', 'signed_out', 'expired'].includes(v.app_status) ? v.app_status : 'unknown' };
  }
  const ATTN = new Set(['needs_you', 'check', 'done', 'fyi']);
  function attentionOf(v) {
    if (!v || typeof v !== 'object' || !ATTN.has(v.state)) return null;
    const ask = String(v.ask || '').replace(/\s+/g, ' ').trim().slice(0, 140); if (!ask) return null;
    return { state: v.state, ask, subject: String(v.subject || '').replace(/\s+/g, ' ').trim().slice(0, 40) };
  }
  function normalizeFull(item) {
    const id = item.id || item.session_id; if (!id) return null;
    const raw = String(item.status || item.run_status || '');
    const status = ALIASES[raw] || raw || undefined;
    const lastUserAt = optIso(item.wizard_last_user_at ?? item.last_user_at);
    const lastAssistantAt = optIso(item.wizard_last_assistant_at ?? item.last_assistant_at);
    const latest = item.latest_message && typeof item.latest_message === 'object' ? item.latest_message : null;
    const lastUser = item.last_user_message && typeof item.last_user_message === 'object' ? item.last_user_message : null;
    const working = WORKING.has(status) || status === 'waiting_for_approval';
    const latestText = clean(text(latest?.content ?? latest?.text));
    const userText = clean(text(lastUser?.content ?? lastUser?.text) || text(item.wizard_request_preview));
    const preview = working ? (userText || latestText) : (latestText || userText || clean(text(item.preview)));
    const latestAt = optIso(latest?.timestamp ?? latest?.created_at);
    const userAt = optIso(lastUser?.timestamp ?? lastUser?.created_at);
    return {
      id, runtime: 'direct',
      title: String(item.title || item.name || 'Untitled chat'),
      source: item.source || '',
      status,
      safeError: typeof item.wizard_safe_error === 'string' ? item.wizard_safe_error : '',
      // Provider sign-in expired: the connection app that fixes it (provider-reconnect.mjs).
      reconnect: reconnectRow(item.wizard_reconnect),
      archived: !!item.archived, hidden: !!item.hidden,
      messageCount: Number.isSafeInteger(item.message_count) ? item.message_count : undefined,
      lastUserAt, lastAssistantAt,
      updatedAt: lastUserAt ?? iso(item.wizard_started_at ?? item.updated_at ?? item.last_active ?? item.started_at),
      activityAt: optIso(item.wizard_activity_at) || optIso(item.last_active),
      runId: String(item.wizard_run_id || ''),
      // The idempotency key of the newest run Wizard knows for this thread (= the outbox item id for our sends).
      lastRunKey: String(item.wizard_last_run_idempotency_key || ''),
      preview, previewRole: latest?.role === 'assistant' ? 'assistant' : latest?.role === 'user' ? 'user' : undefined,
      previewAt: latestAt,
      requestAt: userAt || lastUserAt,
      assignedAt: optIso(item.wizard_assigned_at),
      critical: (item.wizard_attention_level || item.attention_level) === 'critical',
      waitingOn: item.wizard_waiting_on === 'helper' ? 'helper' : '',
      helperStatus: item.wizard_helper_status && typeof item.wizard_helper_status === 'object' ? item.wizard_helper_status : null,
      // What the finished thread asks of James (the agent's hidden status line): needs_you / check / done / fyi.
      attention: attentionOf(item.wizard_attention),
      // Thread titles (Agent Service thread-titles.mjs): every rename with its time, so the thread shows
      // "Renamed from …" right after the reply that renamed it. The list shows only the current title.
      renames: Array.isArray(item.wizard_title_renames) ? item.wizard_title_renames.filter(r => r && typeof r.from === 'string' && isFinite(r.at)).slice(-6).map(r => ({ from: r.from.slice(0, 120), to: String(r.to || '').slice(0, 120), at: Number(r.at), by: r.by === 'you' ? 'you' : 'agent' })) : [],
      // The thread's model route (chat-models.js shows and changes it).
      model: typeof item.model === 'string' ? item.model : '', provider: typeof item.provider === 'string' ? item.provider : '',
      modelLockAt: Number(item.wizard_model_lock_updated_at) || 0,
      // The last thing asked (Retry on a failed thread sends it again: controller.ts retryServerFailedSession).
      request: userText,
      // Agents MVP: the agent this thread is pinned to (server metadata). '' = the main agent.
      agent: typeof item.agent === 'string' ? item.agent : item.agent && typeof item.agent === 'object' && typeof item.agent.id === 'string' ? item.agent.id : '',
    };
  }

export function listRow(item, q = '') {
  const s = normalizeFull(item);
  if (!s) return null;
  const { request, renames, source, runtime, ...row } = s;
  for (const key of ['safeError','reconnect','critical','waitingOn','helperStatus','attention']) if (!row[key]) delete row[key];
  const needle = String(q || '').toLowerCase().trim().split(/\s+/)[0];
  const body = [s.preview, s.request, clean(item.wizard_search_text), s.title].find(t => needle && t.toLowerCase().includes(needle));
  const at = body ? Math.max(0, body.toLowerCase().indexOf(needle)-40) : 0;
  return { ...row, preview: s.preview.slice(0, 140), listVersion: 1,
    ...(body ? { searchSnippet: (at ? '…' : '') + body.slice(at, at+140) } : {}) };

}
export function listPayload(payload, q = '') {
  for (const key of ['data', 'sessions', 'items']) if (Array.isArray(payload[key])) payload[key] = payload[key].map(row => listRow(row, q)).filter(Boolean);
  const { window_projected, ...visible } = payload;
  return { ...visible, view: 'list', list_version: 1 };
}
export { normalizeFull, clean };
