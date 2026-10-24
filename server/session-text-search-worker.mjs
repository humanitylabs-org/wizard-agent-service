// One isolated, warm read handle per runtime. No read transaction survives a query.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { createHermesTextSearcher, indexedSearchWords } from './session-truth.mjs'

if (!isMainThread && workerData?.kind === 'wizard-session-text-search') {
  const searcher = createHermesTextSearcher(workerData.path)
  parentPort.on('message', ({ids, query}) => {
    try {
      const hits = searcher.search(ids, query)
      parentPort.postMessage({rows:[...hits], mode:hits.mode, partial:hits.partial, timings:hits.timings})
    } catch (error) { parentPort.postMessage({error:error.message}) }
  })
}
const pools = new Map()
const unavailable = message => Object.assign(new Error(message), {status:503})
const empty = () => Object.assign(new Map(), {mode:'titles',partial:false,timings:{fts_ms:0,read_ms:0,candidates:0,sessions:0}})
function start(pool) {
  if(pool.active || !pool.queue.length) return
  const task = pool.active = pool.queue.shift()
  if(!pool.worker) {
    const worker = pool.worker = new Worker(new URL(import.meta.url), {
      workerData:{kind:'wizard-session-text-search',path:pool.path}, resourceLimits:{maxOldGenerationSizeMb:256},
    })
    worker.on('message', result => {
      const task=pool.active; if(!task) return
      clearTimeout(task.timer); pool.active=null; worker.unref()
      if(result.error) task.reject(unavailable(result.error))
      else task.resolve(Object.assign(new Map(result.rows), {mode:result.mode,partial:result.partial,timings:result.timings}))
      start(pool)
    })
    const fail = () => {
      if(pool.worker!==worker) return
      pool.worker=null
      const task=pool.active; pool.active=null
      if(task) { clearTimeout(task.timer); task.reject(unavailable('session search worker stopped')) }
      void worker.terminate().then(()=>start(pool))
    }
    worker.on('error',fail); worker.on('exit',fail)
    worker.unref()
  }
  pool.worker.ref()
  task.timer=setTimeout(()=>{
    const worker=pool.worker; pool.worker=null; pool.active=null
    task.reject(unavailable('session search deadline exceeded'))
    void worker.terminate().then(()=>start(pool))
  },3000)
  pool.worker.postMessage({ids:task.ids,query:task.query})
}
export function searchHermesSessionTextAsync(path, sessionIds, query, scope='default') {
  const ids=[...new Set(sessionIds.filter(id=>typeof id==='string' && id.length<=256))]
  // Crucially no worker or SQLite work at all for short/non-ASCII queries.
  if(!ids.length || !indexedSearchWords(query).length) return Promise.resolve(empty())
  let pool=pools.get(path)
  if(!pool) { pool={path,queue:[],active:null,worker:null}; pools.set(path,pool) }
  const key=JSON.stringify([ids,query])
  if(pool.active?.key===key) return pool.active.promise
  const same=pool.queue.find(t=>t.key===key); if(same) return same.promise
  for(const task of pool.queue.filter(t=>t.scope===scope)) { pool.queue.splice(pool.queue.indexOf(task),1); task.reject(unavailable('session search superseded')) }
  if(pool.queue.length>=16) return Promise.reject(unavailable('session search busy'))
  let resolve,reject
  const promise=new Promise((a,b)=>{resolve=a;reject=b})
  pool.queue.push({ids,query,scope,key,promise,resolve,reject})
  start(pool)
  return promise
}
