// Durable admission shared with main, one state DB per routed agent. New queues
// require that exact agent's HTTP authorization; existing admissions resume on startup.
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { DurableRunQueue, queuedInputTextOf } from './run-queue.mjs'
import { readSteerResentHttp } from './hermes-http-readers.mjs'
import { normalizeProviderPreflightFailure, projectProviderSignInHistory, projectProviderSignInEvent } from './run-provider-failure.mjs'
import { ModelSelections, ModelSelectionConflict } from './model-selection.mjs'
import { LockedRunBridge, runtimeMatches } from './locked-run-bridge.mjs'
import { Readable } from 'node:stream'
const terminal = new Set(['completed','failed','cancelled','interrupted'])

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
const json = (status, payload) => new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json'}})
export function createRoutedQueues({ registry, own, pollIntervalMs = 1500, maxActive = 8, onStatus, onDispatch, decorateDispatch, providerAccessRecovery = false, providerAccessWindowSeconds, providerFailureDismissed, providerSignInReady = null }) {
  const entries = new Map()
  const get = async agent => {
    if (!entries.has(agent.id)) {
      const lifecycle = new AbortController()
      const raw = async (path,init={}) => { const headers=new Headers(init.headers);headers.set('Authorization', `Bearer ${registry.apiKey(agent.id)}`);return registry.fetchAgent(agent,path,{...init,headers,redirect:'manual',signal:init.signal||(path.endsWith('/chat/stream')?lifecycle.signal:AbortSignal.timeout(10000))}) }
      const state = join(registry.agentsDir,agent.id,'wizard-locked-runs.json')
      const selections = new ModelSelections({ statePath: state + '.display-selections' })
      const transports = new ModelSelections({ statePath: state + '.admitted-transports' })
      const bridge = new LockedRunBridge({ origin: 'http://routed', statePath: state,
        fetchImpl: (url, init) => raw(new URL(url).pathname + new URL(url).search, init) })
      const project = payload => {
        for (const row of [payload?.id ? payload : null, payload?.session, ...(Array.isArray(payload?.sessions) ? payload.sessions : []), ...(Array.isArray(payload?.data) ? payload.data : []), ...(Array.isArray(payload?.items) ? payload.items : [])]) {
          if (!row?.id || selections.current(row.id)) continue
          const model = row.wizard_model || row.model
          if (agentModelShape(agent) && agent.model.allowed_models.includes(model)) {
            selections.rows.set(row.id, { model, provider: agent.model.provider, version: 1, state: 'confirmed', source: 'existing_agent_lock' }); selections.save()
          }
        }
        return selections.project(payload)
      }
      const resolve = async route => {
        const response = await raw('/api/model/options')
        if (!response.ok) throw new ModelSelectionConflict(null, 'agent_model_route_unproven')
        return resolveAgentTransport(agent, await response.json(), route)
      }
      const direct = async (path, init = {}) => {
        const eventId = path.match(/^\/v1\/runs\/([^/]+)\/events(?:\?|$)/)?.[1]
        if (eventId && bridge.isLockedRun(eventId)) return new Response(Readable.toWeb(Readable.from(bridge.events.frames(eventId, -1, init.signal))),
          { headers: { 'Content-Type': 'text/event-stream' } })
        return bridge.fetch('http://routed' + path, init)
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
          const body = JSON.parse(record.body)
          // Old admitted rows must resolve safely too; never forward a lock flag to
          // native /v1/runs, whose constructor does not enforce it.
          let transport = transports.rows.get(record.requestHash)
          if (!transport && record.retrySourceId) {
            const source=queue.get(record.retrySourceId), previous=source&&JSON.parse(source.body)
            if(previous?.model===body.model&&previous?.provider===body.provider) transport=transports.rows.get(source.requestHash)
            if(transport){transports.rows.set(record.requestHash,transport);transports.save()}
          }
          if (!transport) throw new ModelSelectionConflict(null, 'admitted_agent_route_unproven')
          const envelope = body
          const input = JSON.parse(record.dispatchBody || queue.freezeDispatchBody(record.publicRunId,
            JSON.stringify(decorateDispatch?.(agent.id, record.sessionId, { ...envelope, ...transport, require_model_lock: true }) || { ...envelope, ...transport, require_model_lock: true })))
          const payload=await call('/v1/runs',{method:'POST',wizardAdmittedRoute:true,headers:{'Content-Type':'application/json','Idempotency-Key':record.idempotencyKey},body:JSON.stringify(input)})
          onDispatch?.(agent.id, record.sessionId, input)
          if(record.continuation?.kind==='watch'&&record.continuation.preserve_archived===true) {
            await call(`/api/sessions/${encodeURIComponent(record.sessionId)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({archived:true})})
          }
          return {upstreamRunId:payload.run_id||payload.id,capacityStatus:payload.status,payload}
        },
        lookup:async record=>{
          const payload=await call(`/v1/runs/${encodeURIComponent(record.upstreamRunId)}`)
          const transport = transports.rows.get(record.requestHash)
          if(payload.runtime) delete payload.runtime.wizard_selection
          if (transport && payload.runtime?.model_lock === 'confirmed' && runtimeMatches(payload.runtime, transport)) {
            const choice = JSON.parse(record.body)
            payload.runtime.wizard_selection = { model: choice.model, provider: choice.provider, agent: agent.id }
          }
          if(normalizeProviderPreflightFailure(payload).status==='completed') onStatus?.(agent.id,record.sessionId,payload.output)
          return {payload}
        },
        // A steer this agent accepted but never consumed is replayed once, like main; only this agent's history is read.
        steerDelivered:(record,text)=>readSteerResentHttp(path=>call(path),record.sessionId,record.createdAt,text,queuedInputTextOf(record.body)),
      })
      const ready = queue.initialize()
      entries.set(agent.id,{queue,ready,direct,raw,selections,transports,resolve,bridge,project})
      own?.(async()=>{lifecycle.abort();await ready.catch(()=>{});await queue.close();await Promise.allSettled([...bridge.streams])})
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
      if (method === 'POST' && modelSession) {
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
            if(!['accepted','confirmed'].includes(ack.runtime?.model_lock)||!runtimeMatches(ack.runtime,route)) throw new ModelSelectionConflict(null,'model_selection_ack_mismatch')
            return value
          })
          return json(200,{selection,runtime:{model:selection.model,provider:selection.provider,model_lock:'confirmed',selection_version:selection.version}})
        }catch(error){if(error.payload)return json(error.status,error.payload);throw error}
      }
      if (method === 'GET' && parsed.pathname === '/api/sessions') {
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
          result = Buffer.from(JSON.stringify(project(payload)))
        }
        const headers = new Headers(upstream.headers); headers.delete('content-length')
        return new Response(result,{status:upstream.status,headers})
      }
      if (!(parsed.pathname==='/v1/runs'&&method==='POST') && !/^\/v1\/runs\/wizardq_[0-9a-f]{32}(?:\/|$)/.test(parsed.pathname)) {
        const {direct,resolve}=await get(agent)
        if(method==='POST'&&/^\/v1\/runs\/[^/]+\/steer$/.test(parsed.pathname)) {
          const value=JSON.parse(init.body), route=await resolve(value)
          return direct(path,{...init,body:JSON.stringify({...value,...route})})
        }
        return direct(path,init)
      }
      const {queue,direct,selections,transports,resolve,raw,project}=await get(agent)
      if(parsed.pathname==='/v1/runs'&&method==='POST') {
        const body=JSON.parse(init.body),headers=new Headers(init.headers)
        const key=headers.get('Idempotency-Key')||randomUUID()
        const requestHash=init.wizardRequestHash||createHash('sha256').update(init.body).digest('hex')
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
        body.model ||= selections.current(body.session_id)?.model || agent.model?.model
        body.provider ||= agent.model?.provider
        // Resolve before mutation; recheck CAS synchronously after the awaited catalogue read.
        const transport=await resolve(body)
        Object.assign(body,selections.capture(body),{require_model_lock:true})
        if (Object.hasOwn(body, 'wizard_retry_run_id')) {
          try {
            const {record,replayed} = await queue.retrySaved(body.wizard_retry_run_id, body.session_id, body,
              record=>{transports.rows.set(record.requestHash,transport);transports.save()})
            const response = json(202,queue.publicPayload(record))
            if (replayed) response.headers.set('Idempotency-Replayed','true')
            return response
          } catch(error) { if(Number.isInteger(error.status))return json(error.status,{error:error.code||'saved_retry_unavailable'});throw error }
        }
        transports.rows.set(requestHash,transport);transports.save()
        const continuation=headers.get('X-Wizard-Schedule-Kind')==='watch'
          ? {kind:'watch',preserve_archived:headers.get('X-Wizard-Watcher-Preserve')==='1',agent_id:agent.id} : null
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
      if(method==='POST'&&action==='steer') {
        const guidance=JSON.parse(init.body), captured=JSON.parse(record.body)
        const route=guidance.model&&guidance.provider?guidance:selections.current(record.sessionId)
        if(!route || route.model!==captured.model || route.provider!==captured.provider)
          return json(409,new ModelSelectionConflict(null,'model_selection_steer_mismatch').payload)
        if(!record.upstreamRunId) {
          record=await queue.appendGuidance(record.publicRunId,guidance.input)
          return json(200,queue.publicPayload(record))
        }
        const transport=transports.rows.get(record.requestHash)
        if(!transport)return json(409,new ModelSelectionConflict(null,'admitted_agent_route_unproven').payload)
        init={...init,body:JSON.stringify({...guidance,...transport})}
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
      if(!record.upstreamRunId)return json(409,{error:'run_queued'})
      const upstream=await direct(path.replace(record.publicRunId,record.upstreamRunId),init)
      const text=await upstream.text()
      await queue.tick(true)
      return new Response(text.replaceAll(record.upstreamRunId,record.publicRunId),{status:upstream.status,headers:upstream.headers})
    },
  }
}
