"""Fixed incoming TCP routes only. No caller-controlled destination or logs."""
import json
import os
import socket
import socketserver
import threading
from importlib.util import spec_from_file_location, module_from_spec
spec = spec_from_file_location('connect_proxy', '/app/provider-connect-proxy.py')
module = module_from_spec(spec); spec.loader.exec_module(module)
class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            self.request.settimeout(60)
            with socket.create_connection(self.server.destination, timeout=10) as peer:
                module.pump(self.request, peer)
        except OSError:
            pass
class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    def handle_error(self, *args): pass
def start(routes):
    servers = []
    for listen, host, port in routes:
        server = Server(('0.0.0.0', listen), Handler)
        server.destination = (host, port)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
    return servers

if __name__ == '__main__':
    start(json.loads(os.environ['INGRESS_ROUTES']))
    threading.Event().wait()
