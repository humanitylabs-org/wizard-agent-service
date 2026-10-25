"""Exercise packet selection with synthetic frames; never substitute for rig proof."""
import contextlib,io,json,socket,struct,unittest
from unittest.mock import patch,Mock
from owner_acceptance import CAPTURE

class Event:
    value=False
    def set(self):self.value=True
    def is_set(self):return self.value

def frame(port,payload):
    ethernet=b'\0'*12+b'\x08\x00'
    ip=bytearray(20);ip[0]=0x45;ip[9]=6;ip[12:16]=b'\x0a\x01\x01\x01';ip[16:20]=b'\x0a\x01\x01\x02'
    tcp=bytearray(20);tcp[:2]=(50000+port%100).to_bytes(2,'big');tcp[2:4]=port.to_bytes(2,'big');tcp[4:8]=(1).to_bytes(4,'big');tcp[12]=0x50
    return ethernet+ip+tcp+payload

class Capture(unittest.TestCase):
    def execute(self,frames):
        event=Event();fake=Mock();pending=list(frames)
        def recv(n):
            if pending:return pending.pop(0)
            event.set();raise socket.timeout()
        fake.recv.side_effect=recv;fake.getsockopt.return_value=struct.pack('II',len(frames),0)
        out=io.StringIO()
        with patch('threading.Event',return_value=event),patch('threading.Thread'),patch('socket.socket',return_value=fake),patch('sys.argv',['capture','SYNTHETIC_PRIVATE_WORD']),contextlib.redirect_stdout(out):
            exec(CAPTURE,{})
        return json.loads(out.getvalue().splitlines()[-1])
    def test_local_plaintext_input_is_not_the_relay_leg(self):
        result=self.execute([frame(3301,b'POST /v1/chat/completions SYNTHETIC_PRIVATE_WORD'),frame(8090,b'POST /v1/chat/completions\r\nehbp-encapsulated-key: synthetic\r\n\r\nencrypted')])
        self.assertTrue(result['codeword_absent']);self.assertTrue(result['ehbp_header']);self.assertEqual(result['streams'],1)
    def test_actual_relay_plaintext_remains_a_failure(self):
        with self.assertRaisesRegex(AssertionError,'codeword escaped seal'):
            self.execute([frame(8090,b'ehbp-encapsulated-key: synthetic\r\nSYNTHETIC_PRIVATE_WORD')])
    def test_missing_ehbp_remains_a_failure(self):
        with self.assertRaisesRegex(AssertionError,'missing EHBP'):
            self.execute([frame(8090,b'opaque bytes without mandatory header')])
if __name__=='__main__':unittest.main()
