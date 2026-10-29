import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adaptAppView } from '../server/app-view-adapters.mjs'
const adapt = (id, path, type, s) => adaptAppView(id, path, type, Buffer.from(s)).toString()
test('Files gets scoped assets and runtime API base; external URLs stay external', () => {
 const html = `<link href="/static/a.css"><script src='/static/a.js'></script><a href="//example.com">x</a><script>window.FileBrowser = {"BaseURL":"","StaticURL":"/static"}</script>`
 const out = adapt('files','/apps/files/','text/html',html)
 assert.match(out,/href="\/apps\/files\/static\/a.css"/)
 assert.match(out,/"BaseURL":"\/apps\/files"/)
 assert.match(out,/"StaticURL":"\/apps\/files\/static"/)
 assert.match(out,/href="\/\/example.com"/)
})
test('AI Accounts CSS/script and all API controls stay in app route', () => {
 assert.equal(adapt('wizard-ai-accounts','/apps/wizard-ai-accounts/','text/html','<link href="/app.css"><script src="/app.js"></script>'), '<link href="/apps/wizard-ai-accounts/app.css"><script src="/apps/wizard-ai-accounts/app.js"></script>')
 assert.equal(adapt('wizard-ai-accounts','/apps/wizard-ai-accounts/app.js','application/javascript','const res = await fetch(path, {'), 'const res = await fetch("/apps/wizard-ai-accounts" + path, {')
})
test('binary and unrelated app replies are byte-identical', () => {
 const b=Buffer.from([0,255,128,1]); assert.equal(adaptAppView('browser','/apps/browser/a','image/png',b),b)
 assert.deepEqual(adaptAppView('files','/apps/files/a','image/png',b),b)
})
