#!/usr/bin/env python3
"""Explicit deterministic OpenAI protocol fixture, NOT a confidential-provider proof.
It only echoes memory present in actual stock prompts and actual returned tool results.
No request bodies, responses, canaries, credentials or conversation logging.
"""
import json,re,time,uuid
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
COUNTS={'requests':0,'tool_requests':0,'memory_context_seen':False}
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*_):pass
 def do_GET(self):
  data=json.dumps(COUNTS).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
 def do_POST(self):
  req=json.loads(self.rfile.read(int(self.headers.get('content-length','0'))));COUNTS['requests']+=1
  messages=req.get('messages',[]);functions={t['function']['name']:t['function'] for t in req.get('tools',[]) if t.get('type')=='function'}
  latest=max((i for i,m in enumerate(messages) if m.get('role')=='user'),default=0)
  current=messages[latest:];prompt=str(messages[latest].get('content',''))
  context='\n'.join(str(m.get('content','')) for m in messages if m.get('role')=='system')
  animal=re.search(r'Synthetic identity animal:\s*([a-z0-9-]+)',context)
  COUNTS['memory_context_seen']=bool(animal)
  markers=re.findall(r'INC-[a-f0-9]{40}',prompt)
  returned='\n'.join(str(m.get('content','')) for m in current if m.get('role')=='tool')
  called={c.get('function',{}).get('name') for m in current for c in m.get('tool_calls',[])}
  calls=[]
  def invoke(name,args):
   calls.append({'id':'call_'+uuid.uuid4().hex,'type':'function','function':{'name':name,'arguments':json.dumps(args)}})
  memory=next((n for n in functions if n=='memory'),None)
  tool=next((n for n in functions if 'synthetic_echo' in n),None)
  # Stock Hermes can keep MCP behind tool_search/tool_call instead of promoting
  # it into the OpenAI tools array. Resolve only the actual search result.
  for message in current:
   if message.get('role')!='tool':continue
   try: discovered=json.loads(message.get('content',''))
   except (TypeError,ValueError):continue
   if isinstance(discovered,dict):tool=tool or next((n for n in discovered.get('tools',{}) if 'synthetic_echo' in n),None)
  invoked=set(called)
  for message in current:
   for call in message.get('tool_calls',[]):
    if call.get('function',{}).get('name')!='tool_call':continue
    try: invoked.update(c.get('name') for c in json.loads(call['function']['arguments']).get('calls',[]))
    except (TypeError,ValueError):pass
  if 'SAVE_MEMORY' in prompt and memory and memory not in called:invoke(memory,{'action':'add','target':'memory','content':markers[-1] if markers else 'missing-marker'})
  if 'CALL_SYNTHETIC' in prompt and tool and tool not in invoked:
   args={'marker':markers[0] if markers else 'missing-marker'}
   if tool in functions:invoke(tool,args)
   elif 'tool_call' in functions:invoke('tool_call',{'calls':[{'name':tool,'arguments':args}]})
  if 'CALL_SYNTHETIC' in prompt and not tool and 'tool_search' in functions and 'tool_search' not in called:
   schema=functions['tool_search'].get('parameters',{}).get('properties',{})
   invoke('tool_search',{'queries':['synthetic_echo']} if 'queries' in schema else {'query':'synthetic_echo'})
  # The answer is constructed only from actual context and actual returned tool data.
  answer=(animal.group(1) if animal else 'MEMORY_NOT_PRESENT')+'\n'+returned
  if calls:COUNTS['tool_requests']+=len(calls)
  mid='chatcmpl-'+uuid.uuid4().hex;finish='tool_calls' if calls else 'stop'
  if req.get('stream'):
   self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Connection','close');self.end_headers()
   delta={'role':'assistant','tool_calls':[{'index':i,**c} for i,c in enumerate(calls)]} if calls else {'role':'assistant','content':answer}
   for d,f in [(delta,None),({},finish)]:
    obj={'id':mid,'object':'chat.completion.chunk','created':int(time.time()),'model':'synthetic-incognito','choices':[{'index':0,'delta':d,'finish_reason':f}]}
    self.wfile.write(('data: '+json.dumps(obj)+'\n\n').encode())
   self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush();self.close_connection=True
  else:
   message={'role':'assistant','content':None,'tool_calls':calls} if calls else {'role':'assistant','content':answer}
   obj={'id':mid,'object':'chat.completion','created':int(time.time()),'model':'synthetic-incognito','choices':[{'index':0,'message':message,'finish_reason':finish}],'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}}
   data=json.dumps(obj).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
ThreadingHTTPServer(('0.0.0.0',18888),Handler).serve_forever()
