import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const plugin = fileURLToPath(new URL('../hermes-plugin/wizard-os', import.meta.url))

function python(source) {
  const run = spawnSync('python3', ['-c', source, plugin], { encoding: 'utf8', env: { ...process.env, WIZARD_MCP_TOKEN: 'test-token' } })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
  return JSON.parse(run.stdout)
}

const load = `
import importlib.util, json, os, sys
root=sys.argv[1]
spec=importlib.util.spec_from_file_location('wizard_os_plugin', root + '/__init__.py', submodule_search_locations=[root])
mod=importlib.util.module_from_spec(spec); sys.modules[spec.name]=mod; spec.loader.exec_module(mod)
`

test('Wizard OS plugin registers a session-bound follow-up tool', () => {
  const result = python(load + `
class C:
  def __init__(self): self.tools=[]
  def register_system_prompt_section(self,*a,**k): pass
  def register_tool(self,**kw): self.tools.append(kw)
c=C(); mod.register(c)
t=c.tools[0]
print(json.dumps({'name':t['name'],'actions':t['schema']['parameters']['properties']['action']['enum']}))
`)
  assert.deepEqual(result, { name: 'wizard_follow_up', actions: ['create', 'list', 'stop'] })
})

test('follow-up create gets its thread from Hermes context and posts only to the local service', () => {
  const result = python(load + `
class O:
  def open(self, req, timeout):
    print(json.dumps({'url':req.full_url,'body':json.loads(req.data),'auth':req.headers.get('Authorization'),'timeout':timeout}))
    raise SystemExit(0)
mod.build_opener=lambda *handlers: O()
mod._follow_up_request({'action':'create','name':' Knowledge ready ','instructions':'Check the MVP.','every_minutes':7}, session_id='wizard_thread_1')
`)
  assert.equal(result.url, 'http://127.0.0.1:8796/wizard/internal/follow-ups/create')
  assert.deepEqual(result.body, { session_id: 'wizard_thread_1', name: 'Knowledge ready', instructions: 'Check the MVP.', every_minutes: 7 })
  assert.equal(result.auth, 'Bearer test-token')
  assert.equal(result.timeout, 15)
})

test('follow-up tool fails closed without a real Wizard thread', () => {
  const result = python(load + `
print(json.dumps(mod._follow_up_request({'action':'list'}, session_id='../wrong')))
`)
  assert.equal(result.success, false)
  assert.match(result.error, /no Wizard thread/)
})

test('follow-up credentials stay on loopback and redirects are disabled', () => {
  const result = python(load + `
os.environ['WIZARD_AGENT_SERVICE_URL']='https://attacker.example'
class Never:
  def open(self,*a,**k): raise AssertionError('network must not be reached')
mod.build_opener=lambda *handlers: Never()
refused=mod._follow_up_request({'action':'list'},session_id='wizard_thread_1')
redirect=mod._NoRedirect().redirect_request(None,None,302,'moved',{},'http://attacker.example')
print(json.dumps({'refused':refused,'redirect':redirect}))
`)
  assert.equal(result.refused.success, false)
  assert.match(result.refused.error, /box-local/)
  assert.equal(result.redirect, null)
})

test('follow-up credentials never inherit an HTTP proxy', () => {
  const result = python(load + `
os.environ['HTTP_PROXY']='http://proxy.example:8080'
os.environ['http_proxy']='http://proxy.example:8080'
class O:
  def open(self, req, timeout):
    print(json.dumps({'handlers':[{'type':getattr(h,'__name__',type(h).__name__),'proxies':getattr(h,'proxies',None)} for h in handlers]}))
    raise SystemExit(0)
def opener(*value):
  global handlers
  handlers=value
  return O()
mod.build_opener=opener
mod._follow_up_request({'action':'list'},session_id='wizard_thread_1')
`)
  assert.deepEqual(result.handlers, [
    { type: 'ProxyHandler', proxies: {} },
    { type: '_NoRedirect', proxies: null },
  ])
})
