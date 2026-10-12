// Agent Service's opt-in route boundary: route to the selected harness BEFORE
// normal Hermes directBody/runInstructions/model-lock admission. Off by default.
import { streamConversationEvents, ConversationError } from './claude-conversation.mjs'
export const jsonReply=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
export async function boundedJson(req,max=160000){let bytes=0,chunks=[];for await(const c of req){bytes+=c.length;if(bytes>max)throw new ConversationError(413,'request_too_large');chunks.push(c)}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}')}catch{throw new ConversationError(400,'invalid_json')}}
export function createConversationRouter({agents,resolveSources=async(_a,_t,s)=>{if(s.length)throw new ConversationError(403,'history_grant_required');return[]}}){
  return async(req,res)=>{
    const url=new URL(req.url,'http://local');const m=/^\/wizard\/agents\/([a-z0-9-]+)(?:\/(.*))?$/.exec(url.pathname);if(!m)return false;
    const a=agents[m[1]];if(!a){jsonReply(res,404,{error:'agent_not_found'});return true}
    try{
      if(req.headers['sec-fetch-site']==='cross-site')throw new ConversationError(403,'cross_origin_request');
      if(req.headers.origin){const o=new URL(req.headers.origin);if(o.host!==(req.headers['x-forwarded-host']||req.headers.host))throw new ConversationError(403,'cross_origin_request')}
      const route=(m[2]||'').split('/'),method=req.method;
      if(method==='GET'&&!m[2])jsonReply(res,200,{agent:m[1],harness:'claude-code',provider:'firstParty',model_alias:a.model,clean_context:true,capabilities:{stream:true,resume:true,stop:true,steering:false,tool_approvals:false,history:'host-mediated-optional'}});
      else if(route[0]==='threads'&&route.length===1){
        if(method==='GET')jsonReply(res,200,{threads:a.list({query:url.searchParams.get('q')||'',archived:url.searchParams.get('archived')==='true'})});
        else if(method==='POST')jsonReply(res,201,a.create(await boundedJson(req)));else throw new ConversationError(405,'method_not_allowed');
      } else if(route[0]==='threads'&&route.length===2){
        if(method==='GET')jsonReply(res,200,a.read(route[1]));else if(method==='PATCH')jsonReply(res,200,a.patch(route[1],await boundedJson(req)));else throw new ConversationError(405,'method_not_allowed');
      } else if(route[0]==='threads'&&route[2]==='runs'&&route.length===3&&method==='POST'){
        const body=await boundedJson(req);a.thread(route[1]);if(typeof body.key!=='string'||!body.key.trim()||body.key.length>120)throw new ConversationError(400,'idempotency_key_required');const prior=a.db.prepare('SELECT * FROM runs WHERE thread_id=? AND key=?').get(route[1],body.key);if(prior){jsonReply(res,202,prior);return true}const sources=await resolveSources(m[1],route[1],body.sources||[],body);jsonReply(res,202,a.submit(route[1],{message:body.message,key:body.key,sources}));
      } else if(route[0]==='runs'&&route.length===2&&method==='GET')jsonReply(res,200,a.run(route[1]));
      else if(route[0]==='runs'&&route[2]==='events'&&route.length===3&&method==='GET'){
        const after=Number(req.headers['last-event-id']||url.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)throw new ConversationError(400,'invalid_cursor');streamConversationEvents(a,route[1],res,after);
      } else if(route[0]==='runs'&&route[2]==='stop'&&route.length===3&&method==='POST')jsonReply(res,200,a.stop(route[1]));
      else if(route[0]==='runs'&&route[2]==='retry'&&route.length===3&&method==='POST')jsonReply(res,202,a.retry(route[1],await boundedJson(req)));
      else throw new ConversationError(404,'route_not_found');
    }catch(e){if(!res.headersSent)jsonReply(res,e.status||500,{error:e.code||'agent_service_error'})}return true
  }
}
