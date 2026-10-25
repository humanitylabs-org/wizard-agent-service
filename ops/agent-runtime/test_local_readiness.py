import subprocess
import unittest
from unittest.mock import Mock,patch
from private_providers import PrivateProviders


class Failure(Exception):
    def __init__(self,code,status):self.code=code;self.status=status


class ProvisioningReadinessTests(unittest.TestCase):
    def setUp(self):
        self.docker=Mock(return_value=subprocess.CompletedProcess([],0,stdout=''))
        self.p=PrivateProviders(None,None,self.docker,Failure)
        self.app={'private_inference':{'kind':'local','weights_ready':'/models/ready.json'}}

    def test_marker_required_before_link(self):
        self.p.require_weights(self.app,'cid')
        self.docker.assert_called_once_with(['exec','cid','test','-r','/models/ready.json'],check=False,timeout=10)
        self.docker.return_value.returncode=1
        with self.assertRaises(Failure) as result:self.p.require_weights(self.app,'cid')
        self.assertEqual(result.exception.code,'private_provider_unavailable')

    def test_marker_path_cannot_escape_models(self):
        for value in ['/models/../private/token','relative',True,{}]:
            if not value:continue
            self.app['private_inference']['weights_ready']=value
            with self.assertRaises(Failure):self.p.require_weights(self.app,'cid')
        self.docker.assert_not_called()

    def test_attested_provider_retries_restart_disconnect_before_client(self):
        self.app['private_inference']['kind']='attested-relay'
        self.p.request=Mock(side_effect=[Failure('notready',503),{'status':'connected'}])
        self.p.require_weights(self.app,'cid')
        with patch('private_providers.time.sleep') as sleep:self.p.wait_ready(self.app)
        self.docker.assert_not_called();sleep.assert_called_once_with(0.25)
        for call in self.p.request.call_args_list:self.assertEqual(call.args,(self.app,'GET','/api/connection'))

    def test_bounded_bodyless_ready_poll(self):
        self.p.request=Mock(side_effect=[Failure('notready',503),{'weights_ready':True,'status':'not_connected'},
            {'weights_ready':True,'status':'connected'}])
        with patch('private_providers.time.sleep') as sleep:self.p.wait_ready(self.app)
        self.assertEqual(sleep.call_count,2)
        for call in self.p.request.call_args_list:self.assertEqual(call.args,(self.app,'GET','/api/connection'))

    def test_ready_poll_timeout_fails_closed(self):
        self.p.request=Mock(return_value={'weights_ready':False,'status':'not_connected'})
        with patch('private_providers.time.monotonic',side_effect=[0,61]),self.assertRaises(Failure):
            self.p.wait_ready(self.app)
        self.p.request.assert_called_once()


if __name__=='__main__':unittest.main()
