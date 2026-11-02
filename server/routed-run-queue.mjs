// Durable admission shared with main, one state DB per routed agent. New queues
// require that exact agent's HTTP authorization; existing admissions resume on startup.
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { DurableRunQueue, queuedInputTextOf, queueRequestHash, PENDING_STEER_REPLAY_PREFIX } from './run-queue.mjs'
import { readSteerResentHttp } from './hermes-http-readers.mjs'
import { normalizeProviderPreflightFailure, projectProviderSignInHistory, projectProviderSignInEvent } from './run-provider-failure.mjs'
import { ModelSelections, ModelSelectionConflict } from './model-selection.mjs'
import { LockedRunBridge, runtimeMatches } from './locked-run-bridge.mjs'
import { Readable } from 'node:stream'
const publicRuntimeMatches = (runtime, route) => runtimeMatches(runtime, route) && (runtime.provider !== 'custom' || (runtime.requested?.model === route.model && runtime.requested?.provider === route.provider))
// Resolve only the agent's configured provider, not a catalogue 'best' or fallback.
// A generic custom transport without a named configured route cannot prove privacy.
const agentModelShape = agent => typeof agent?.model?.provider === 'string' && agent.model.provider.length > 0
  && Array.isArray(agent.model.allowed_models)
  && agent.model.allowed_models.every(model => typeof model === 'string' && model.length > 0)
export function resolveAgentTransport(agent, options, route) {
  if (!agentModelShape(agent) || typeof options?.provider !== 'string' || !options.provider
    || !Array.isArray(options.providers) || typeof route?.model !== 'string' || !route.model
    || typeof route.provider !== 'string' || !route.provider)
    throw new ModelSelectionConflict(null, 'agent_model_route_unproven')
  const provider = options?.provider
  const p = options.providers.find(p => typeof p?.slug === 'string' && (p.slug === provider || `custom:${p.slug}` === provider))
  const canonical = p?.is_user_defined && !provider.startsWith('custom:') ? `custom:${provider}` : provider
  const display = agent.model?.provider
  const aliases = display === 'anthropic' ? ['anthropic', 'claude-subscription-directsdk-experimental']
    : display === 'tinfoil' ? ['tinfoil', 'custom:tinfoil', 'custom:wizard-tinfoil', 'custom:tinfoil-operator'] : [display]
  const listed = Array.isArray(p?.models) && p.models.some(m => (typeof m === 'string' ? m : m?.value || m?.id || m?.model) === route.model)
  if (route.provider !== display || !agent.model.allowed_models.includes(route.model)
    || !canonical || canonical === 'custom' || !aliases.includes(canonical) || !listed)
    throw new ModelSelectionConflict(null, 'agent_model_route_unproven')
  return { model: route.model, provider: canonical }
}
// Only a fresh envelope with no selection/lock/retry claims can retain native
// legacy routing. Configuration prefill is not a deliberate picker selection.
const unselectedEnvelope = body => body && typeof body === 'object' && !Array.isArray(body)
  && !Object.keys(body).some(key => /model|provider|lock|selection|version|route|runtime|transport|retry/i.test(key))
// Only exact source-derived original bytes prove absent authority. No live
// session/config/picker read belongs in historical admission classification.
export function historicalUnselected(record, agentId) {
  if (record.runtime !== 'direct' || record.agent_id !== agentId || record.retrySourceId
    || typeof record.sessionId !== 'string' || /(?:^|[:/])incog_/u.test(record.sessionId)
    || !/^[0-9a-f]{64}$/.test(record.requestHash)) return false
  let original
  try { original = JSON.parse(record.body) } catch { return false }
  if (!original || typeof original !== 'object' || Array.isArray(original)
    || original.session_id !== record.sessionId || JSON.stringify(original) !== record.body) return false
  if (Object.hasOwn(original, 'model')) {
    // Absent model was appended by baseline prefill, not overwritten in place.
    if (Object.keys(original).at(-1) !== 'model' || typeof original.model !== 'string' || !original.model) return false
    delete original.model
  }
  if (!unselectedEnvelope(original)) return false
  const matches = value => createHash('sha256').update(JSON.stringify(value)).digest('hex') === record.requestHash
  if (matches(original)) return true
  // Baseline HTTP proxy appended instructions when the inbound key was absent.
  // Original instructions/removed fields/non-roundtripping encodings stay unknown.
  if (Object.keys(original).at(-1) !== 'instructions') return false
  delete original.instructions
  return matches(original)
}
const terminal = new Set(['completed','failed','cancelled','interrupted'])
const json = (status, payload) => new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json'}})
export function createRoutedQueues({ registry, own, pollIntervalMs = 1500, maxActive = 8, onStatus, onDispatch, decorateDispatch, providerAccessRecovery = false, providerAccessWindowSeconds, providerFailureDismissed, providerSignInReady = null }) {
  const entries = new Map()
  const get = async agent => {
    if (!entries.has(agent.id)) {
      let direct = async (path,init={}) => { const headers=new Headers(init.headers);headers.set('Authorization', `Bearer ${registry.apiKey(agent.id)}`);return registry.fetchAgent(agent,path,{...init,headers,redirect:'manual',signal:init.signal||AbortSignal.timeout(10000)}) }
      const publicAgent = agent.privacy === 'standard'
      const raw = direct
      const lifecycle = new AbortController()
      let selections, transports, bridge, project, resolve
      if (publicAgent) {
        const state = join(registry.agentsDir, agent.id, 'wizard-public-locked-runs.json')
        selections = new ModelSelections({statePath: state + '.display'})
        transports = new ModelSelections({statePath: state + '.transports'})
        bridge = new LockedRunBridge({origin: 'http://routed', statePath: state,
          isPublicSession: sid => typeof sid === 'string' && !/(?:^|[:/])incog_/u.test(sid),
          fetchImpl: (url, init) => raw(new URL(url).pathname + new URL(url).search, {...init, ...(new URL(url).pathname.endsWith('/chat/stream') ? {signal: lifecycle.signal} : {})})})
        direct = async (path, init = {}) => {
          const runId = path.match(/^\/v1\/runs\/([^/]+)\/events(?:\?|$)/)?.[1]
          if (runId && bridge.isLockedRun(runId)) return new Response(Readable.toWeb(Readable.from(bridge.events.frames(runId, -1, init.signal))), {headers: {'Content-Type': 'text/event-stream'}})
          return bridge.fetch('http://routed' + path, init)
        }
        project = payload => {
          for (const row of [payload?.id ? payload : null, payload?.session, ...(payload?.sessions || []), ...(payload?.data || []), ...(payload?.items || [])]) {
            const model = row?.wizard_model || row?.model
            if (row?.id && !selections.current(row.id) && agentModelShape(agent) && agent.model.allowed_models.includes(model)) {
              selections.rows.set(row.id, {model, provider: agent.model.provider, version: 1, state: 'confirmed', source: 'existing_agent_lock'}); selections.save()
            }
          }
          return selections.project(payload)
        }
        resolve = async route => {
          const response = await raw('/api/model/options')
          if (!response.ok) throw new ModelSelectionConflict(null, 'agent_model_route_unproven')
          let options
          try { options = await response.json() }
          catch { throw new ModelSelectionConflict(null, 'agent_model_route_unproven') }
          return resolveAgentTransport(agent, options, route)
        }
      }
      const call = async (path,init={}) => {
        const response = await direct(path,init)
        const payload = await response.json()
        if (!response.ok) throw Object.assign(new Error('routed admission unavailable'),{status:response.status,upstreamError:payload.error,retryAfter:response.headers.get('retry-after')})
        return payload
      }
      const queue = new DurableRunQueue({providerAccessRecovery,providerAccessWindowSeconds,providerFailureDismissed,providerSignInReady,agentId:agent.id,statePath:join(registry.agentsDir,agent.id,'wizard-run-queue.sqlite3'),maxActive,pollIntervalMs,
        // An external CLI turn remains protected by Hermes' 409 admission. Only
        // this agent's queue is reconciled here, never another agent's state.db.
        activeSessionIds:async()=>[],canDispatch:async()=>true,
        launch:async record=>{
          let input, payload
          if (publicAgent) {
            const body = JSON.parse(record.body)
            let transport = transports.rows.get(record.requestHash)
            const sourceId = record.retrySourceId || (record.idempotencyKey.startsWith(PENDING_STEER_REPLAY_PREFIX) ? record.idempotencyKey.slice(PENDING_STEER_REPLAY_PREFIX.length) : '')
            if (!transports.rows.has(record.requestHash) && sourceId) {
              const source = queue.get(sourceId), previous = source && JSON.parse(source.body)
              if (previous?.model === body.model && previous?.provider === body.provider) transport = transports.rows.get(source.requestHash)
              if (transport) { transports.rows.set(record.requestHash, transport); transports.save() }
            }
            if (!transports.rows.has(record.requestHash) && historicalUnselected(record, agent.id)) {
              transport={legacyUnselected:true};transports.rows.set(record.requestHash,transport);transports.save()
            }
            if (!transport) throw new ModelSelectionConflict(null, 'admitted_agent_route_unproven')
            if (transport.legacyUnselected === true) {
              // This marker is server-owned admission custody, never request JSON.
              // Unknown old queue rows remain held; today's picker cannot recast them.
              const { provider: _displayProvider, ...legacy } = body
              input = JSON.parse(record.dispatchBody || queue.freezeDispatchBody(record.publicRunId,
                JSON.stringify(decorateDispatch?.(agent.id, record.sessionId, legacy) || legacy)))
              const response = await raw('/v1/runs', {method:'POST', headers:{'Content-Type':'application/json','Idempotency-Key':record.idempotencyKey}, body:JSON.stringify(input)})
              payload = await response.json()
              if (!response.ok) throw Object.assign(new Error('routed admission unavailable'), {status:response.status,upstreamError:payload.error,retryAfter:response.headers.get('retry-after')})
            } else {
            input = JSON.parse(record.dispatchBody || queue.freezeDispatchBody(record.publicRunId,
              JSON.stringify(decorateDispatch?.(agent.id, record.sessionId, {...body, ...transport, require_model_lock: true}) || {...body, ...transport, require_model_lock: true})))
            payload = await call('/v1/runs', {method:'POST', wizardAdmittedRoute:true, headers:{'Content-Type':'application/json','Idempotency-Key':record.idempotencyKey}, body:JSON.stringify(input)})
            }
          } else {
          // Agent registry providers are owner-facing account ids (e.g. anthropic),
          // not Hermes' configured transport (e.g. Claude subscription or custom).
          // Never turn a pinned model into a provider switch, including recovered admissions.
          const { provider: _displayProvider, ...body } = JSON.parse(record.body)
          input = JSON.parse(record.dispatchBody || queue.freezeDispatchBody(record.publicRunId,
            JSON.stringify(decorateDispatch?.(agent.id, record.sessionId, body) || body)))
          payload=await call('/v1/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':record.idempotencyKey},body:JSON.stringify(input)})
          }
          onDispatch?.(agent.id, record.sessionId, input)
          if(record.continuation?.kind==='watch'&&record.continuation.preserve_archived===true) {
            await call(`/api/sessions/${encodeURIComponent(record.sessionId)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({archived:true})})
          }
          return {upstreamRunId:payload.run_id||payload.id,capacityStatus:payload.status,payload}
        },
        lookup:async record=>{ const payload=await call(`/v1/runs/${encodeURIComponent(record.upstreamRunId)}`);
          if (selections) { const transport=transports.rows.get(record.requestHash); if(transport && payload.runtime?.model_lock === 'confirmed' && publicRuntimeMatches(payload.runtime,transport)) { const choice=JSON.parse(record.body); payload.runtime.wizard_selection={model:choice.model,provider:choice.provider,agent:agent.id} } }
           if(normalizeProviderPreflightFailure(payload).status==='completed') onStatus?.(agent.id,record.sessionId,payload.output); return {payload} },
        // A steer this agent accepted but never consumed is replayed once, like main; only this agent's history is read.
        steerDelivered:(record,text)=>readSteerResentHttp(path=>call(path),record.sessionId,record.createdAt,text,queuedInputTextOf(record.body)),
      })
      const ready = queue.initialize()
      entries.set(agent.id,{queue,ready,direct,raw,selections,transports,resolve,project})
      own?.(async()=>{if(bridge) lifecycle.abort();await ready.catch(()=>{});await queue.close();if(bridge) await Promise.allSettled([...bridge.streams])})
    }
    const entry=entries.get(agent.id);await entry.ready;return entry
  }
  // Resume previously admitted work even when its Chats window is closed. Only
  // service-owned queue metadata is discovered; no private homes/history scans.
  const ready = Promise.allSettled(registry.list().filter(agent => agent.id !== 'hermes' && existsSync(join(registry.agentsDir, agent.id, 'wizard-run-queue.sqlite3'))).map(get))
  return {
    ready,
    async mutationOwner(agent, sessionId) { const { queue } = await get(agent); return queue.mutationOwnerForSession(sessionId) },
    async fetch(agent,path,init={}) {
      const method=init.method||'GET', parsed=new URL(path,'http://routed')
      const modelSession = parsed.pathname.match(/^\/api\/sessions\/([^/]+)\/model$/)?.[1]
      if (agent.privacy === 'standard' && method === 'POST' && modelSession) {
        const {selections,resolve,raw,project}=await get(agent), sid=decodeURIComponent(modelSession), value=JSON.parse(init.body)
        if (!selections.current(sid)) { const response=await raw('/api/sessions/'+encodeURIComponent(sid)); if(response.ok) project(await response.json()); else await response.body?.cancel() }
        value.selection_request_id ||= 'legacy-'+createHash('sha256').update(JSON.stringify(value)).digest('hex')
        try {
          const selection = await selections.change(sid,value,async()=>{
            let route
            try { route=await resolve(value) } catch(error) { error.selectionNotApplied=true; throw error }
            const response=await raw(parsed.pathname,{...init,body:JSON.stringify({...value,...route,require_model_lock:true})})
            if(!response.ok) throw Object.assign(new ModelSelectionConflict(null,'agent_model_not_confirmed'),{selectionNotApplied:response.status>=400&&response.status<500})
            const ack=await response.json()
            if(!['accepted','confirmed'].includes(ack.runtime?.model_lock)||!publicRuntimeMatches(ack.runtime,route)) throw new ModelSelectionConflict(null,'model_selection_ack_mismatch')
            return value
          })
          return json(200,{selection,runtime:{model:selection.model,provider:selection.provider,model_lock:'accepted',selection_version:selection.version}})
        }catch(error){if(error.payload)return json(error.status,error.payload);throw error}
      }
      if (agent.privacy === 'standard' && method === 'GET' && parsed.pathname === '/api/sessions') {
        const upstream=await registry.fetchAgent(agent,path,init)
        if(!upstream.ok)return upstream
        const {project}=await get(agent)
        return json(200,project(await upstream.json()))
      }
      const detail = method === 'GET' && (init.wizardDetail === true || parsed.searchParams.get('view') === 'detail') && parsed.pathname.match(/^\/api\/sessions\/([^/]+)$/)
      if (method === 'GET' && /^\/api\/sessions\/[^/]+(?:\/messages)?$/.test(parsed.pathname)) {
        const upstream = await registry.fetchAgent(agent,path,init)
        if (!upstream.ok) {
          if (upstream.status !== 404 || parsed.pathname.endsWith('/messages')) return upstream
          const {queue} = await get(agent), saved = queue.savedRetry(decodeURIComponent(parsed.pathname.split('/')[3]))
          if (!saved) return upstream
          return json(200, { id: saved.sessionId, wizard_retry_input: queuedInputTextOf(saved.body), wizard_retry_run_id: saved.publicRunId, status: saved.status, queue_reason: saved.waitingReason })
        }
        const {queue,project} = await get(agent)
        const record = queue.latestForSession(decodeURIComponent(parsed.pathname.split('/')[3]))
        const raw = Buffer.from(await upstream.arrayBuffer())
        let result = raw
        if (parsed.pathname.endsWith('/messages') && parsed.searchParams.get('view') === 'wizard') result = projectProviderSignInHistory(raw, record, parsed.searchParams)
        else if (!parsed.pathname.endsWith('/messages')) {
          const payload = JSON.parse(raw.toString('utf8')), row = payload.session || payload
          const saved = detail ? queue.savedRetry(decodeURIComponent(detail[1])) : null
          if (saved) Object.assign(row, { wizard_retry_input: queuedInputTextOf(saved.body), wizard_retry_run_id: saved.publicRunId, status: saved.status, queue_reason: saved.waitingReason })
          else if (record?.payload?.wizard_provider_auth) row.wizard_retry_input = queuedInputTextOf(record.body)
          result = Buffer.from(JSON.stringify(project ? project(payload) : payload))
        }
        const headers = new Headers(upstream.headers); headers.delete('content-length')
        return new Response(result,{status:upstream.status,headers})
      }
      if (!(parsed.pathname==='/v1/runs'&&method==='POST') && !/^\/v1\/runs\/wizardq_[0-9a-f]{32}(?:\/|$)/.test(parsed.pathname)) return registry.fetchAgent(agent,path,init)
      const {queue,direct,selections,transports,resolve,raw,project}=await get(agent)
      if(parsed.pathname==='/v1/runs'&&method==='POST') {
        const body=JSON.parse(init.body),headers=new Headers(init.headers)
        const key=headers.get('Idempotency-Key')||randomUUID()
        const requestHash=init.wizardRequestHash||createHash('sha256').update(init.body).digest('hex')
        let transport
        if (selections) {
        const replay = queue.replay('direct', body.session_id, key, requestHash)
        if (replay) { const response=json(202,queue.publicPayload(replay));response.headers.set('Idempotency-Replayed','true');return response }
        const retryReplay = body.wizard_retry_run_id && queue.byIdempotencyKey('direct', `wizard-saved-retry-${body.wizard_retry_run_id}`)
        if (retryReplay) {
          const {record}=await queue.retrySaved(body.wizard_retry_run_id,body.session_id,body)
          const response=json(202,queue.publicPayload(record));response.headers.set('Idempotency-Replayed','true');return response
        }
        if (!selections.current(body.session_id)) {
          const response=await raw(`/api/sessions/${encodeURIComponent(body.session_id)}`)
          if(response.ok) project(await response.json()); else await response.body?.cancel()
        }
        if (!selections.current(body.session_id) && !selections.pending.has(body.session_id)
          && !/(?:^|[:/])incog_/u.test(body.session_id) && unselectedEnvelope(body)) {
          transport = {legacyUnselected:true}
        } else {
          body.model ||= selections.current(body.session_id)?.model || agent.model?.model
          body.provider ||= agent.model?.provider
          // Resolve before mutation; recheck CAS synchronously after the awaited catalogue read.
          transport=await resolve(body)
          Object.assign(body,selections.capture(body),{require_model_lock:true})
        }
        }
        if (Object.hasOwn(body, 'wizard_retry_run_id')) {
          try {
            // retrySaved dispatches before returning. Persist custody under its exact
            // source-owned envelope hash first, never the caller's preview input.
            const source = queue.get(body.wizard_retry_run_id)
            if (selections && source?.sessionId === body.session_id) {
              const value = JSON.parse(source.body)
              if (body.model) Object.assign(value, {model:body.model, ...(body.provider ? {provider:body.provider} : {}), require_model_lock:true})
              transports.rows.set(queueRequestHash(source.runtime, JSON.stringify(value)), transport);transports.save()
            }
            const {record,replayed} = await queue.retrySaved(body.wizard_retry_run_id, body.session_id, body)
            const response = json(202,queue.publicPayload(record))
            if (replayed) response.headers.set('Idempotency-Replayed','true')
            return response
          } catch(error) { if(Number.isInteger(error.status))return json(error.status,{error:error.code||'saved_retry_unavailable'});throw error }
        }
        if (!body.model) {
          let session = null
          try { const response = await direct(`/api/sessions/${encodeURIComponent(body.session_id)}`); if(response.ok) { const payload=await response.json();session=payload.session||payload } else await response.body?.cancel() } catch {}
          body.model = session?.model || agent.model?.model
        }

        const continuation=headers.get('X-Wizard-Schedule-Kind')==='watch'
          ? {kind:'watch',preserve_archived:headers.get('X-Wizard-Watcher-Preserve')==='1',agent_id:agent.id} : null
        if (transport?.legacyUnselected && (selections.current(body.session_id) || selections.pending.has(body.session_id)))
          throw new ModelSelectionConflict(selections.current(body.session_id))
        if (selections) {
          if (transports.rows.has(requestHash)) {
            if (JSON.stringify(transports.rows.get(requestHash)) !== JSON.stringify(transport)) throw new ModelSelectionConflict(null, 'admitted_agent_route_unproven')
          } else {transports.rows.set(requestHash,transport);transports.save()}
        }
        try {
          const replay = queue.replay('direct', body.session_id, key, requestHash)
          const {record}=await queue.admit({runtime:'direct',sessionId:body.session_id,idempotencyKey:key,requestHash,body:JSON.stringify(body),agent_id:agent.id,continuation})
          const response=json(202,queue.publicPayload(record)); if(replay)response.headers.set('Idempotency-Replayed','true');return response
        } catch(error) { if(Number.isInteger(error.status))return json(error.status,{error:error.code||'run_admission_failed'});throw error }
      }
      const match=parsed.pathname.match(/^\/v1\/runs\/(wizardq_[0-9a-f]{32})(?:\/(events|steer|stop|approval|clarify|resolve-unknown))?$/)
      if(!match) return json(404,{error:'not_found'})
      await queue.tick(true)
      let record=queue.get(match[1]);if(!record)return json(404,{error:'not_found'})
      const action=match[2]
      if(method==='GET'&&!action)return json(200,queue.publicPayload(record))
      if(method==='POST'&&action==='stop') {
        queue.markOwnerStop(record.publicRunId)
        if(!record.upstreamRunId){record=await queue.cancel(record.publicRunId);return json(200,queue.publicPayload(record))}
      }
      if(method==='POST'&&action==='steer'&&!record.upstreamRunId) {
        const guidance=JSON.parse(init.body)
        if (selections && !(transports.rows.get(record.requestHash)?.legacyUnselected === true && unselectedEnvelope(guidance))) selections.assertQueuedGuidance(record.sessionId, guidance, JSON.parse(record.body))
        record=await queue.appendGuidance(record.publicRunId,guidance.input)
        return json(200,queue.publicPayload(record))
      }
      if(method==='GET'&&action==='events') {
        const stream=new ReadableStream({
          async start(controller) {
            const encoder=new TextEncoder();let cancelled=false
            const abort=()=>{cancelled=true};init.signal?.addEventListener('abort',abort,{once:true})
            try {
              controller.enqueue(encoder.encode(`event: run.queued\ndata: ${JSON.stringify(queue.publicPayload(record))}\n\n`))
              while(!record.upstreamRunId&&!terminal.has(record.status)&&!cancelled){await queue.tick(true);record=queue.get(record.publicRunId);if(!record.upstreamRunId)await new Promise(r=>setTimeout(r,250))}
              if(cancelled)return
              if(!record.upstreamRunId){controller.enqueue(encoder.encode(`event: run.${record.status}\ndata: ${JSON.stringify(queue.publicPayload(record))}\n\n`));return}
              const upstream=await direct(`/v1/runs/${encodeURIComponent(record.upstreamRunId)}/events`,init)
              if(!upstream.ok||!upstream.body)throw new Error('routed event stream unavailable')
              // Carry split UTF-8/identifier frames across transport chunks.
              const reader=upstream.body.getReader(),decoder=new TextDecoder();let pending=''
              while(!cancelled){const {value,done}=await reader.read();pending+=decoder.decode(value||new Uint8Array(),{stream:!done});const cut=done?pending.length:pending.lastIndexOf('\n\n')+2;if(cut>1){controller.enqueue(encoder.encode(pending.slice(0,cut).split(/(?<=\n\n)/).map(projectProviderSignInEvent).join('').replaceAll(record.upstreamRunId,record.publicRunId)));pending=pending.slice(cut)}if(done)break}
              if(pending&&!cancelled)controller.enqueue(encoder.encode(projectProviderSignInEvent(pending).replaceAll(record.upstreamRunId,record.publicRunId)))
              if(cancelled)await reader.cancel()
            }catch(error){if(!cancelled)controller.error(error)}finally{init.signal?.removeEventListener('abort',abort);if(!cancelled)try{controller.close()}catch{}}
          },
        })
        return new Response(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store'}})
      }
      if (selections && method === 'POST' && action === 'steer' && record.upstreamRunId) {
        const guidance=JSON.parse(init.body), captured=JSON.parse(record.body), transport=transports.rows.get(record.requestHash)
        if (transport?.legacyUnselected === true && unselectedEnvelope(guidance)) {
          // Native unselected admission remains native even after a later picker.
          const upstream=await raw(path.replace(record.publicRunId,record.upstreamRunId),init)
          return new Response((await upstream.text()).replaceAll(record.upstreamRunId,record.publicRunId),{status:upstream.status,headers:upstream.headers})
        }
        selections.assertQueuedGuidance(record.sessionId,guidance,captured)
        const response=await direct(`/v1/runs/${encodeURIComponent(record.upstreamRunId)}`)
        if (!response.ok) throw new ModelSelectionConflict(null,'model_selection_steer_mismatch')
        const active=await response.json()
        if(!transport || active.runtime?.model_lock !== 'confirmed' || !publicRuntimeMatches(active.runtime,transport)) throw new ModelSelectionConflict(null,'model_selection_steer_mismatch')
        init={...init,body:JSON.stringify({...guidance,...transport})}
      }
      if(!record.upstreamRunId)return json(409,{error:'run_queued'})
      const upstream=await direct(path.replace(record.publicRunId,record.upstreamRunId),init)
      const text=await upstream.text()
      await queue.tick(true)
      return new Response(text.replaceAll(record.upstreamRunId,record.publicRunId),{status:upstream.status,headers:upstream.headers})
    },
  }
}
