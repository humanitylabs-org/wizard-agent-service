// Isolated review origin: only synthetic Agent Service, never a live upstream.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const web=path.resolve(process.env.PREVIEW_WEB),port=Number(process.env.PORT),backend=Number(process.env.PREVIEW_SERVICE_PORT);
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.webmanifest':'application/manifest+json','.ico':'image/x-icon'};
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value))};
http.createServer((req,res)=>{
 const u=new URL(req.url,'http://preview');
 const inc=/^\/wizard\/v1\/agents\/synthetic\/incognito(?:\/|$)/.test(u.pathname);
 if(!['GET','HEAD'].includes(req.method)&&!inc)return json(res,403,{error:'Only synthetic Incognito is writable here'});
 if(u.pathname==='/__preview/receipt')return json(res,200,{syntheticOnly:true,liveUpstreams:false,shellSha:process.env.PREVIEW_SHELL_SHA,serviceSha:process.env.PREVIEW_SERVICE_SHA});
 if(u.pathname==='/'){res.writeHead(302,{location:'/wizard-os-home/?agent=synthetic&shell=phone'});return res.end()}
 if(u.pathname.startsWith('/wizard-os-home/')){
  let rel;try{rel=decodeURIComponent(u.pathname.slice(16))||'index.html'}catch{return json(res,400,{error:'path'})}
  if(rel.split('/').some(s=>s==='..'||s.startsWith('.')))return json(res,404,{error:'not_found'});
  const file=path.resolve(web,rel);if(!file.startsWith(web+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,404,{error:'not_found'});
  res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','cache-control':'no-store','permissions-policy':'microphone=()'});
  if(req.method==='HEAD')return res.end();return fs.createReadStream(file).pipe(res);
 }
 if(!u.pathname.startsWith('/wizard/'))return json(res,404,{error:'synthetic_preview_only'});
 const headers={host:req.headers.host,accept:req.headers.accept||'*/*'};
 if(inc)for(const h of ['content-type','content-length','origin','sec-fetch-site','idempotency-key'])if(req.headers[h])headers[h]=req.headers[h];
 const p=http.request({hostname:'127.0.0.1',port:backend,path:req.url,method:req.method,headers},r=>{const h={...r.headers};delete h['set-cookie'];h['cache-control']='no-store';res.writeHead(r.statusCode,h);res.flushHeaders();r.pipe(res);res.on('close',()=>r.destroy())});
 p.setTimeout(360000,()=>p.destroy());p.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end()});req.pipe(p);
}).listen(port,'127.0.0.1');
