// Durable admission shared with main, one state DB per routed agent. New queues
// require that exact agent's HTTP authorization; existing admissions resume on startup.
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { DurableRunQueue, queuedInputTextOf } from './run-queue.mjs'
import { readSteerResentHttp } from './hermes-http-readers.mjs'
import { normalizeProviderPreflightFailure, projectProviderSignInHistory, projectProviderSignInEvent } from './run-provider-failure.mjs'
const terminal = new Set(['completed','failed','cancelled','interrupted'])
const json = (status, payload) => new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json'}})
export function createRoutedQueues({ registry, own, pollIntervalMs = 1500, maxActive = 8, onStatus, onDispatch, decorateDispatch, providerAccessRecovery = false, providerAccessWindowSeconds, providerFailureDismissed, providerSignInReady = null }) {
  const entries = new Map()
  const get = async agent => {
    if (!entries.has(agent.id)) {
      const direct = async (path,init={}) => { const headers=new Headers(init.headers);headers.set('Authorization', `Bearer ${registry.apiKey(agent.id)}`);return registry.fetchAgent(agent,path,{...init,headers,redirect:'manual',signal:init.signal||AbortSignal.timeout(10000)}) }
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
          // Agent registry providers are owner-facing account ids (e.g. anthropic),
          // not Hermes' configured transport (e.g. Claude subscription or custom).
          // Never turn a pinned model into a provider switch, including recovered admissions.
          const { provider: _displayProvider, ...body } = JSON.parse(record.body)
          const input = JSON.parse(record.dispatchBody || queue.freezeDispatchBody(record.publicRunId,
            JSON.stringify(decorateDispatch?.(agent.id, record.sessionId, body) || body)))
          const payload=await call('/v1/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':record.idempotencyKey},body:JSON.stringify(input)})
          onDispatch?.(agent.id, record.sessionId, input)
          if(record.continuation?.kind==='watch'&&record.continuation.preserve_archived===true) {
            await call(`/api/sessions/${encodeURIComponent(record.sessionId)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({archived:true})})
          }
          return {upstreamRunId:payload.run_id||payload.id,capacityStatus:payload.status,payload}
        },
        lookup:async record=>{ const payload=await call(`/v1/runs/${encodeURIComponent(record.upstreamRunId)}`); if(normalizeProviderPreflightFailure(payload).status==='completed') onStatus?.(agent.id,record.sessionId,payload.output); return {payload} },
        // A steer this agent accepted but never consumed is replayed once, like main; only this agent's history is read.
        steerDelivered:(record,text)=>readSteerResentHttp(path=>call(path),record.sessionId,record.createdAt,text,queuedInputTextOf(record.body)),
      })
      const ready = queue.initialize()
      entries.set(agent.id,{queue,ready,direct})
      own?.(async()=>{await ready.catch(()=>{});await queue.close()})
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
      const detail = method === 'GET' && (init.wizardDetail === true || parsed.searchParams.get('view') === 'detail') && parsed.pathname.match(/^\/api\/sessions\/([^/]+)$/)
      if (method === 'GET' && /^\/api\/sessions\/[^/]+(?:\/messages)?$/.test(parsed.pathname)) {
        const upstream = await registry.fetchAgent(agent,path,init)
        if (!upstream.ok) {
          if (upstream.status !== 404 || parsed.pathname.endsWith('/messages')) return upstream
          const {queue} = await get(agent), saved = queue.savedRetry(decodeURIComponent(parsed.pathname.split('/')[3]))
          if (!saved) return upstream
          return json(200, { id: saved.sessionId, wizard_retry_input: queuedInputTextOf(saved.body), wizard_retry_run_id: saved.publicRunId, status: saved.status, queue_reason: saved.waitingReason })
        }
        const {queue} = await get(agent)
        const record = queue.latestForSession(decodeURIComponent(parsed.pathname.split('/')[3]))
        const raw = Buffer.from(await upstream.arrayBuffer())
        let result = raw
        if (parsed.pathname.endsWith('/messages') && parsed.searchParams.get('view') === 'wizard') result = projectProviderSignInHistory(raw, record, parsed.searchParams)
        else if (!parsed.pathname.endsWith('/messages')) {
          const payload = JSON.parse(raw.toString('utf8')), row = payload.session || payload
          const saved = detail ? queue.savedRetry(decodeURIComponent(detail[1])) : null
          if (saved) Object.assign(row, { wizard_retry_input: queuedInputTextOf(saved.body), wizard_retry_run_id: saved.publicRunId, status: saved.status, queue_reason: saved.waitingReason })
          else if (record?.payload?.wizard_provider_auth) row.wizard_retry_input = queuedInputTextOf(record.body)
          result = Buffer.from(JSON.stringify(payload))
        }
        const headers = new Headers(upstream.headers); headers.delete('content-length')
        return new Response(result,{status:upstream.status,headers})
      }
      if (!(parsed.pathname==='/v1/runs'&&method==='POST') && !/^\/v1\/runs\/wizardq_[0-9a-f]{32}(?:\/|$)/.test(parsed.pathname)) return registry.fetchAgent(agent,path,init)
      const {queue,direct}=await get(agent)
      if(parsed.pathname==='/v1/runs'&&method==='POST') {
        const body=JSON.parse(init.body),headers=new Headers(init.headers)
        const key=headers.get('Idempotency-Key')||randomUUID()
        if (Object.hasOwn(body, 'wizard_retry_run_id')) {
          try {
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
        const requestHash=init.wizardRequestHash||createHash('sha256').update(init.body).digest('hex')
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
      if(method==='POST'&&action==='steer'&&!record.upstreamRunId) {
        const guidance=JSON.parse(init.body)
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
      if(!record.upstreamRunId)return json(409,{error:'run_queued'})
      const upstream=await direct(path.replace(record.publicRunId,record.upstreamRunId),init)
      const text=await upstream.text()
      await queue.tick(true)
      return new Response(text.replaceAll(record.upstreamRunId,record.publicRunId),{status:upstream.status,headers:upstream.headers})
    },
  }
}
