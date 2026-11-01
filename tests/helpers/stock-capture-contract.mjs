// Evidence decoder only. NOT a route-admission predicate and NOT endpoint/privacy proof.
import { createHash } from 'node:crypto'
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export function events(bytes) {
 return bytes.toString().split(/\r?\n\r?\n/).filter(Boolean).map(block=>{
  const lines=block.split(/\r?\n/), event=lines.find(x=>x.startsWith('event: '))?.slice(7)
  return {event,data:JSON.parse(lines.filter(x=>x.startsWith('data: ')).map(x=>x.slice(6)).join('\n'))}
 })
}
export function observedFinal(runtime, requested, canonical) {
 // A captured primary-turn final needs ALL these fields. This still cannot attest endpoint/title custody.
 return runtime?.model_lock==='confirmed' && runtime.model===requested.model &&
  runtime.provider===canonical && runtime.requested?.provider===requested.provider &&
  runtime.requested?.model===requested.model
}
export function classifyWire(path,body,source) {
 if(path==='/api/show' && Object.keys(body).length===1 && ['fixture-alpha','fixture-beta'].includes(body.name))return 'metadata'
 if(path!=='/v1/chat/completions'||!['fixture-alpha','fixture-beta'].includes(body.model)||!Array.isArray(body.messages)||!body.messages.length)return 'unclassified'
 const m=body.messages
 const title=m.length===2 && m[0]?.role==='system' && m[0].content===source.system_prompt &&
  sha256(Buffer.from(m[0].content))===source.system_prompt_sha256 && m[1]?.role==='user' &&
  typeof m[1].content==='string' && JSON.stringify(body.response_format)===JSON.stringify(source.response_format) &&
  Object.keys(body).sort().join(',')==='messages,model,reasoning_effort,response_format'
 if(title)return 'title_inference'
 if(m[0]?.role==='system' && !body.response_format && body.stream===true && m.some(x=>x.role==='user' && x.content==='Synthetic fixture response only.'))return 'reply_inference'
 return 'other_inference'
}
