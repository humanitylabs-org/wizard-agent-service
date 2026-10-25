import unittest
from provider_adapter import user_config, URN

class RuntipiError(RuntimeError):pass
class API:
    def __init__(self,error=None):self.error=error
    def req(self,method,path):
        assert method=='GET' and path=='/user-config/'+URN
        if self.error:raise self.error
        return {'dockerCompose':'services: {}','appEnv':''}
class Tests(unittest.TestCase):
    def test_unstaged_recipe_exact_absence_is_blank(self):
        error=RuntipiError('GET /user-config/'+URN+' -> 404: APP_ERROR_APP_NOT_FOUND')
        self.assertEqual(user_config(API(error)),{'dockerCompose':'','appEnv':''})
    def test_existing_config_is_preserved(self):
        self.assertEqual(user_config(API())['dockerCompose'],'services: {}')
    def test_other_errors_fail_closed(self):
        for error in [RuntipiError('GET /user-config/'+URN+' -> 401: APP_ERROR_APP_NOT_FOUND'), RuntipiError('GET /user-config/'+URN+' -> 404: unknown'),RuntimeError('GET /user-config/'+URN+' -> 404: APP_ERROR_APP_NOT_FOUND')]:
            with self.subTest(error=type(error).__name__):
                with self.assertRaises(type(error)):user_config(API(error))
if __name__=='__main__':unittest.main()
