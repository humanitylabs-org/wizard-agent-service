// Synthetic Connection Router. Never contacts Claude or reads login files.
import { createServer } from 'node:http'
export async function fakeOpusRouter() {
  const calls = [], state = { error: null, malformed: false, hold: false }
  const token = 'fixture-router-grant'
  const server = createServer(async (req,res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const json = value => { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(value)) }
    if (req.headers['x-wizard-grant'] !== token) { res.writeHead(403); res.end('{}'); return }
    if (req.url === '/v1/needs') return json({models:[{feature:'opus-direct',status: state.error ? 'blocked' : 'ready', ...(state.error ? {error:state.error} : {})}]})
    if (req.url !== '/v1/models/opus-direct/run') { res.writeHead(404); res.end(); return }
    calls.push({body:JSON.parse(raw),headers:req.headers})
    res.writeHead(200,{'Content-Type':'text/event-stream'})
    const emit = data => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
    if (state.error) emit({type:'error',...state.error})
    else {
      emit({type:'delta',text:'Synthetic Opus direct reply.'})
      if (!state.malformed) emit({type:'done',provider:'claude-connection',model:'claude-opus-5-5',tested_on:'claude-opus-5-5',chosen:'match',tier:'frontier',usage:{input_tokens:10,output_tokens:6}})
    }
    res.end()
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  return { calls,state,token,origin:`http://127.0.0.1:${server.address().port}`,
    app:{id:'fixture-router',name:'Synthetic Connection Router',view:{upstream:`http://127.0.0.1:${server.address().port}/apps/router/`},upstream:`http://127.0.0.1:${server.address().port}`,provides:['connection-router'],status:'running'},
    close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}) }
}
