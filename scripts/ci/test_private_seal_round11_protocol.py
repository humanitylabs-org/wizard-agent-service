"""Focused regressions; execute only on forum under parent durable admission."""
import ast
from contextlib import contextmanager
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(SCRIPTS))
from private_seal_round11_protocol import nested_docker_argv, manager_health_ready, queues_ready, smart_advertisement_ready
from private_seal_round11_inherit import function_closure, STOCK_FUNCTIONS
spec = importlib.util.spec_from_file_location('git_http_fixture',SCRIPTS/'ci/round11-git-http.py')
assert spec is not None and spec.loader is not None
git_http = importlib.util.module_from_spec(spec); spec.loader.exec_module(git_http)
from http.server import ThreadingHTTPServer


class TransportTests(unittest.TestCase):
    def test_outer_and_inner_exec_preserve_stdin(self):
        argv = nested_docker_argv('engine',['exec','-i','api','python3','-c','print(input())'],'{}')
        self.assertEqual(argv,['docker','exec','-i','engine','docker','exec','-i','api','python3','-c','print(input())'])

    def test_empty_stdin_still_requires_interactive(self):
        self.assertEqual(nested_docker_argv('engine',['exec','-i','api','cat'],'')[2],'-i')

    def test_inner_missing_i_fails_before_execution(self):
        with self.assertRaisesRegex(RuntimeError,'inner_interactive'):
            nested_docker_argv('engine',['exec','api','cat'],'{}')

    def test_nonstdin_exec_does_not_allocate_tty_or_interactive(self):
        self.assertEqual(nested_docker_argv('engine',['info']),['docker','exec','engine','docker','info'])

    def health(self):
        return {'status':'ok','error':{},'info':{'queue':{'status':'up'}},'details':{'queue':{'status':'up'}}}

    def test_full_manager_health_required(self):
        self.assertTrue(manager_health_ready(self.health()))
        for v in ({},None,{'status':'ok'},{**self.health(),'error':{'queue':{'status':'down'}}},
                  {**self.health(),'info':{}},{**self.health(),'status':'error'}):
            self.assertFalse(manager_health_ready(v))

    def test_every_real_consumer_required(self):
        rows=[{'name':n,'consumers':c} for n,c in [('app-events-queue',3),('repo-queue',3),('system-events-queue',1)]]
        self.assertTrue(queues_ready(rows))
        self.assertFalse(queues_ready(rows[:-1]))
        rows[0]['consumers']=0
        self.assertFalse(queues_ready(rows))

    def test_dumb_http_rejected(self):
        self.assertFalse(smart_advertisement_ready('text/plain',b'123456 refs/heads/main\n'))
        self.assertFalse(smart_advertisement_ready('application/x-git-upload-pack-advertisement',b'<html>'))

    def test_stock_function_body_dependency_drift_detected(self):
        a='\n'.join(f'def {n}(): return 1' for n in STOCK_FUNCTIONS)
        self.assertEqual(function_closure(a),function_closure(a))
        self.assertNotEqual(function_closure(a),function_closure(a.replace('return 1','return 2',1)))

    def test_manager_only_does_not_run_stock(self):
        source=(SCRIPTS/'private-seal-round11.py').read_text()
        tree=ast.parse(source)
        main=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='main')
        loop=next(n for n in ast.walk(main) if isinstance(n,ast.For) and isinstance(n.iter,ast.IfExp))
        branch = loop.iter
        assert isinstance(branch,ast.IfExp)
        self.assertEqual(ast.unparse(branch.test),'MANAGER_ONLY')
        self.assertEqual(ast.unparse(branch.body),"[('manager', manager_phase)]")


class SmartHttpTests(unittest.TestCase):
    @contextmanager
    def catalogue(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); repo=root/'catalog'; repo.mkdir()
            def git(*args):
                return subprocess.run(['git','-c','user.name=Synthetic','-c','user.email=qa@example.invalid',*args],
                                      cwd=repo,check=True,capture_output=True,text=True,timeout=20)
            git('init','-q','--initial-branch=main'); (repo/'synthetic.txt').write_text('one\n')
            git('add','.'); git('commit','-qm','one')
            server=ThreadingHTTPServer(('127.0.0.1',0),git_http.handler(root))
            thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
            try: yield root,git,f'http://127.0.0.1:{server.server_port}/catalog/.git'
            finally: server.shutdown();thread.join();server.server_close()

    def test_real_advertisement_clone_and_fetch_update(self):
        with self.catalogue() as (root,git,url):
            with urlopen(url+'/info/refs?service=git-upload-pack',timeout=5) as h:
                self.assertTrue(smart_advertisement_ready(h.headers['Content-Type'],h.read()))
            clone=root/'client'
            subprocess.run(['git','-c','protocol.version=0','clone','--depth','1',url,str(clone)],
                           check=True,capture_output=True,timeout=20)
            self.assertEqual((clone/'synthetic.txt').read_text(),'one\n')
            (root/'catalog/synthetic.txt').write_text('two\n');git('add','.');git('commit','-qm','two')
            subprocess.run(['git','-C',str(clone),'-c','protocol.version=0','fetch','--depth','1','origin','main'],
                           check=True,capture_output=True,timeout=20)
            subprocess.run(['git','-C',str(clone),'reset','--hard','FETCH_HEAD'],check=True,capture_output=True,timeout=20)
            self.assertEqual((clone/'synthetic.txt').read_text(),'two\n')

    def test_dumb_paths_private_files_and_writes_denied(self):
        with self.catalogue() as (_,git,url):
            for path in ('/config','/HEAD','/../.env','/info/refs','/info/refs?service=git-receive-pack','/git-receive-pack'):
                with self.assertRaises(HTTPError) as ctx: urlopen(url+path,timeout=5)
                self.assertEqual(ctx.exception.code,403)
            with self.assertRaises(HTTPError) as ctx:
                urlopen(Request(url+'/git-receive-pack',data=b'',method='POST'),timeout=5)
            self.assertEqual(ctx.exception.code,403)


if __name__ == '__main__': unittest.main()
