#!/usr/bin/env python3
"""Test-only OpenAI response fixture. No claim of encryption, attestation or AI."""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import time


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
        self.wfile.write(json.dumps({'object':'list','data':[{'id':'synthetic-vision','object':'model','owned_by':'synthetic'}]}).encode())
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        images = [part['image_url']['url'] for message in body.get('messages',[]) if isinstance(message.get('content'),list)
                  for part in message['content'] if part.get('type')=='image_url']
        if images:
            raw = base64.b64decode(images[0].split(',',1)[1], validate=True)
            result = {'image_count':len(images), 'decoded_bytes':len(raw), 'png_signature_valid':raw.startswith(b'\x89PNG\r\n\x1a\n'),
                      'image_sha256':hashlib.sha256(raw).hexdigest(), 'scope':'synthetic fixture, not a vision model'}
            Path('/state/image-receipt.json').write_text(json.dumps(result))
            if not result['png_signature_valid']: self.send_error(400); return
        base = {'id':'chatcmpl-synthetic', 'object':'chat.completion', 'created':int(time.time()), 'model':'synthetic-vision'}
        if body.get('stream'):
            self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.send_header('Connection','close'); self.end_headers()
            for delta, finish in [({'role':'assistant','content':'SYNTHETIC_RECOVERED'},None), ({},'stop')]:
                chunk = {**base, 'object':'chat.completion.chunk', 'choices':[{'index':0,'delta':delta,'finish_reason':finish}]}
                self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode()); self.wfile.flush()
            self.wfile.write(b'data: [DONE]\n\n'); self.close_connection=True
        else:
            value = {**base, 'choices':[{'index':0,'message':{'role':'assistant','content':'SYNTHETIC_RECOVERED'},'finish_reason':'stop'}],
                     'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}}
            data=json.dumps(value).encode(); self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)


if __name__ == '__main__': ThreadingHTTPServer(('0.0.0.0',8000),Handler).serve_forever()
