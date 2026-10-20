"""Policy and real loopback CONNECT/TLS parser tests (no Internet/key)."""
import copy
import ipaddress
import json
import socket
import ssl
import threading
import unittest
from unittest.mock import patch
from provider_egress import ProviderEgress, declared_hosts, _proxy as proxy


class Failure(Exception):
    def __init__(self, code, status=500): self.code = code


class PolicyTests(unittest.TestCase):
    def test_manifest_exact_hostnames(self):
        for bad in ['*.tinfoil.sh', '1.1.1.1', '[::1]', 'EXAMPLE.com', 'example.com.', 'example.com:443', 'https://example.com', '-a.example', 'a..example', 'a_b.example']:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                declared_hosts({'kind':'attested-relay', 'egress':[bad]})
        for bad in (None, '', [{}], ['example.com', 'example.com']):
            with self.assertRaises(ValueError): declared_hosts({'kind':'attested-relay', 'egress':bad})
        with self.assertRaises(ValueError): declared_hosts({'kind':'local', 'egress':['example.com']})
        self.assertEqual(declared_hosts({'kind':'local', 'egress':[]}), [])

    def test_authority_no_suffix_port_or_ip_bypass(self):
        for value in ('example.com:443', 'inference.tinfoil.sh.evil.com:443', '1.1.1.1:443', '[::1]:443', 'inference.tinfoil.sh:80', 'inference.tinfoil.sh:0443', 'INFERENCE.tinfoil.sh:443', 'inference.tinfoil.sh.:443', 'inference.tinfoil.sh@evil.com:443'):
            with self.subTest(value=value), self.assertRaises(ValueError): proxy.target(value, {'inference.tinfoil.sh'})
        self.assertEqual(proxy.target('inference.tinfoil.sh:443', {'inference.tinfoil.sh'}), 'inference.tinfoil.sh')

    def test_dns_refuses_entire_mixed_answer_and_no_reresolve(self):
        for address in ('127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1'):
            with patch.object(socket, 'getaddrinfo', return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, '', (address,443))]), patch.object(socket, 'socket') as sock:
                with self.assertRaises(ValueError): proxy.public_connection('inference.tinfoil.sh')
                sock.assert_not_called()
        answer = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('1.1.1.1',443))]
        with patch.object(socket, 'getaddrinfo', return_value=answer) as dns, patch.object(socket, 'socket') as sock:
            proxy.public_connection('inference.tinfoil.sh')
            dns.assert_called_once(); sock.return_value.connect.assert_called_once_with(('1.1.1.1',443))

    def test_real_http_refusal_no_upstream_connection(self):
        server = proxy.Server(('127.0.0.1', 0), proxy.Handler); server.allowed = {'inference.tinfoil.sh'}
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            for line in ('GET http://inference.tinfoil.sh/ HTTP/1.1', 'CONNECT example.com:443 HTTP/1.1', 'CONNECT 1.1.1.1:443 HTTP/1.1', 'CONNECT inference.tinfoil.sh:80 HTTP/1.1'):
                with socket.create_connection(server.server_address) as sock:
                    sock.sendall((line+'\r\nHost: ignored\r\n\r\n').encode())
                    self.assertIn(b'403 Forbidden', sock.recv(1024))
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_sni_bound_to_connect_and_plaintext_refused(self):
        def hello(host):
            incoming, outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
            obj = ssl.create_default_context().wrap_bio(incoming, outgoing, server_hostname=host)
            try: obj.do_handshake()
            except ssl.SSLWantReadError: pass
            return outgoing.read()
        for host in ('inference.tinfoil.sh', 'example.com'):
            left,right = socket.socketpair()
            try:
                wire = hello(host); right.sendall(wire)
                if host == 'inference.tinfoil.sh': self.assertEqual(proxy.client_hello(left, host), wire)
                else:
                    with self.assertRaises(ValueError): proxy.client_hello(left, 'inference.tinfoil.sh')
            finally: left.close(); right.close()
        left,right = socket.socketpair()
        try:
            right.sendall(b'GET / HTTP/1.1\r\n\r\n')
            with self.assertRaises(ValueError): proxy.client_hello(left, 'inference.tinfoil.sh')
        finally: left.close(); right.close()

    def fixture(self):
        return {'Config':{'Env':['HTTPS_PROXY=http://wizard-egress-proxy:3128']}, 'Mounts':[],
                'HostConfig':{'CapDrop':['ALL'], 'Dns':['127.0.0.1'], 'ReadonlyRootfs':True,
                              'NetworkMode':'some-net', 'SecurityOpt':['no-new-privileges:true']}}

    def test_container_prerequisites_fail_closed(self):
        manager = ProviderEgress(None, Failure)
        value = self.fixture(); manager.validate(value, ['inference.tinfoil.sh'])
        for key, changed in [('Privileged',True), ('CapAdd',['NET_ADMIN']), ('Dns',[]), ('ExtraHosts',['x:1.1.1.1']), ('NetworkMode','host'), ('ReadonlyRootfs',False)]:
            value = self.fixture(); value['HostConfig'][key] = changed
            with self.subTest(key=key), self.assertRaises(Failure): manager.validate(value, ['inference.tinfoil.sh'])
        value = self.fixture(); value['Config']['Env'] += ['NO_PROXY=*']
        with self.assertRaises(Failure): manager.validate(value, ['inference.tinfoil.sh'])
        with self.assertRaises(Failure): manager.validate(self.fixture(), [])
        value = self.fixture(); value['Config']['Env'] = []; manager.validate(value, [])

    def test_existing_network_requires_owned_ipv4_internal_inhibited_subnet(self):
        value = {'Internal':True, 'EnableIPv6':False, 'Driver':'bridge',
                 'Labels':{'wizard.private-egress':'example'},
                 'Options':{'com.docker.network.bridge.inhibit_ipv4':'true'},
                 'IPAM':{'Config':[{'Subnet':'10.253.12.0/24'}]}}
        manager = ProviderEgress(None, Failure)
        with patch.object(manager, 'inspect', return_value=value):
            self.assertEqual(manager.network({'id':'example'}), 'wizard-egress-example')
        for key,bad in [('Internal',False), ('EnableIPv6',True), ('Labels',{}), ('Options',{}),
                        ('IPAM',{'Config':[{'Subnet':'172.20.0.0/24'}]}), ('IPAM',{'Config':[{'Subnet':'10.253.0.0/16'}]})]:
            changed=copy.deepcopy(value); changed[key]=bad
            with self.subTest(key=key), patch.object(manager, 'inspect', return_value=changed), self.assertRaises(Failure):
                manager.network({'id':'example'})

    def test_failure_stops_before_validation_and_never_starts(self):
        calls=[]
        manager = ProviderEgress(lambda args, **kw: calls.append(args), Failure)
        manager.inspect = lambda *args: self.fixture()
        manager.validate = lambda *args: (_ for _ in ()).throw(Failure('bad'))
        with self.assertRaises(Failure): manager.reconcile({'id':'example', 'private_inference':{'kind':'local','egress':[]}}, 'container', 'relay')
        self.assertEqual(calls[:2], [['update','--restart','no','container'],['stop','container']])
        self.assertNotIn('start', [c[0] for c in calls])

if __name__ == '__main__': unittest.main()
