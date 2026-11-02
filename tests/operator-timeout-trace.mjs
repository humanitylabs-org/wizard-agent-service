import {appendFileSync,readFileSync,existsSync,statSync} from 'node:fs'
import {join,resolve,sep} from 'node:path'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
let context=null, seq=0
const sha=x=>createHash('sha256').update(x).digest('hex')
export function event(label,data={}) {
 if(!process.env.RR_OPERATOR_TRACE)return
 appendFileSync(process.env.RR_OPERATOR_TRACE,JSON.stringify({seq:++seq,at:Date.now(),mono:performance.now(),case:context?.name||null,label,...data})+'\n',{mode:0o600})
}
export function begin(name){ context={name,root:null};event('case.begin') }
export function snapshot(label){
 if(!context?.root)return
 const root=resolve(context.root),base=resolve(process.env.TMPDIR)
 if(!root.startsWith(base+sep))throw Error('trace root outside synthetic TMPDIR')
 const state={root,activeResources:process.getActiveResourcesInfo()}
 try { const p=join(root,'q.db');if(existsSync(p)){const db=new DatabaseSync(p,{readOnly:true});try{state.queue=db.prepare('SELECT * FROM wizard_run_queue LIMIT 8').all()}finally{db.close()}} }catch(e){state.queue_error={name:e.name,code:e.code,message:e.message}}
 state.journals={}
 for(const name of ['model-locked-admissions.json','model-locked-admissions.json.public-selections','workers.json']){
  const p=join(root,name);if(!existsSync(p)){state.journals[name]={absent:true};continue}
  const s=statSync(p);if(!s.isFile()||s.size>1048576)throw Error('trace journal cap')
  const raw=readFileSync(p);state.journals[name]={sha256:sha(raw),bytes:raw.length,value:JSON.parse(raw)}
 }
 event('snapshot.'+label,state)
}
export function setRoot(root){if(context){context.root=root;snapshot('root')}}
export async function awaited(label,fn){event('await.before',{await:label});try{const result=await fn();event('await.after',{await:label});snapshot(label+'.after');return result}catch(e){event('await.error',{await:label,error:{name:e.name,code:e.code,status:e.status,message:e.message}});snapshot(label+'.error');throw e}}
export function wire(req,res,text){
 if(!context)return
 const id=++seq,body=(()=>{try{return JSON.parse(text||'{}')}catch{return {invalid_json:true}}})()
 const key=req.headers['idempotency-key'];event('wire.request',{id,method:req.method,path:req.url,key_sha256:key?sha(key):null,body_sha256:sha(text),body:{session_id:body.session_id,model:body.model,provider:body.provider,selection_version:body.selection_version,require_model_lock:body.require_model_lock}})
 // Observe only this synthetic fixture's ServerResponse, never production fetch/bridge.
 const end=res.end;res.end=function(...args){const raw=typeof args[0]==='string'?args[0]:Buffer.isBuffer(args[0])?args[0].toString('utf8'):'';event('wire.end',{id,status:res.statusCode,content_type:res.getHeader('Content-Type'),body:raw,body_sha256:sha(raw)});return Reflect.apply(end,this,args)}
 res.once('finish',()=>event('wire.finish',{id,status:res.statusCode,content_type:res.getHeader('Content-Type')}))
 res.once('close',()=>event('wire.close',{id,status:res.statusCode,finished:res.writableFinished}))
 req.once('close',()=>event('wire.request.close',{id,complete:req.complete}))
}
export function arm(){const t=setTimeout(()=>snapshot('before-original-5s-deadline'),4400);t.unref();return t}
export function finish(timer){clearTimeout(timer);snapshot('case.finally');event('case.end');context=null}
