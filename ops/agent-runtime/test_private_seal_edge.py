import importlib.util
import io
from pathlib import Path
import ssl
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('edge', Path(__file__).with_name('provider-connect-proxy.py'))
edge = importlib.util.module_from_spec(spec); spec.loader.exec_module(edge)


class Wire:
    def __init__(self, data): self.data=io.BytesIO(data)
    def recv(self, size): return self.data.read(size)
    def settimeout(self, _): pass


def hello(host):
    incoming, outgoing=ssl.MemoryBIO(),ssl.MemoryBIO()
    client=ssl.create_default_context().wrap_bio(incoming,outgoing,server_hostname=host)
    try: client.do_handshake()
    except ssl.SSLWantReadError: pass
    return outgoing.read()


class EdgeTests(unittest.TestCase):
    def test_sni_passthrough_preserves_every_tls_byte(self):
        wire=hello('inference.tinfoil.sh')
        self.assertEqual(edge.client_hello(Wire(wire),'inference.tinfoil.sh'),wire)
        self.assertEqual(edge.client_hello(Wire(wire),None),(wire,'inference.tinfoil.sh'))

    def test_connect_must_match_sni(self):
        with self.assertRaises(ValueError):edge.client_hello(Wire(hello('example.com')),'inference.tinfoil.sh')

    def test_plaintext_rejected_before_any_connection(self):
        with self.assertRaises(ValueError):edge.client_hello(Wire(b'GET / HTTP/1.0\r\n\r\n'),None)

    def test_undeclared_raw_tls_never_opens_upstream(self):
        with patch.object(edge,'public_connection') as connection:
            edge.DirectTLSHandler(Wire(hello('example.com')),('synthetic',0),type('Server',(),{'allowed':{'inference.tinfoil.sh'}})())
            connection.assert_not_called()

    def test_arbitrary_port_ip_and_noncanonical_name_refused(self):
        for target in ['example.com:443','1.1.1.1:443','inference.tinfoil.sh:80','INFERENCE.tinfoil.sh:443','inference.tinfoil.sh.:443']:
            with self.assertRaises(ValueError):edge.target(target,{'inference.tinfoil.sh'})

    def test_rebinding_private_loopback_and_metadata_refused(self):
        for ip in ['127.0.0.1','10.0.0.1','169.254.169.254','::1']:
            with patch.object(edge.socket,'getaddrinfo',return_value=[(2,1,6,'',(ip,443))]),patch.object(edge.socket,'socket') as connection:
                with self.assertRaises(ValueError):edge.public_connection('inference.tinfoil.sh')
                connection.assert_not_called()


if __name__=='__main__':unittest.main()
