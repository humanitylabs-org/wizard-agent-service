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
        # Bind incoming-only routes to the external interface, never the agent
        # seal or provider-egress interface. Socket connect selects a route but
        # sends no packet. Explicit addresses are used by reviewed fixed rigs.
        bind = os.environ.get('INGRESS_BIND_IP', '')
        if not bind:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
                route.connect(('192.0.2.1', 9))
                bind = route.getsockname()[0]
        if bind in ('0.0.0.0', '127.0.0.1'):
            raise ValueError('ingress_interface_required')
        server = Server((bind, listen), Handler)
        server.destination = (host, port)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
    return servers

if __name__ == '__main__':
    start(json.loads(os.environ['INGRESS_ROUTES']))
    threading.Event().wait()
