// Prepare only throwaway synthetic files under an explicit staging directory.
import fs from 'node:fs'
import path from 'node:path'
const state = path.resolve(process.argv[2] || '')
if (!process.argv[2] || state === process.env.HOME || !state.includes('wizard-stage')) throw Error('Pass an isolated wizard-stage state directory')
for (const dir of ['home', 'claude', 'codex', 'troubleshooter', 'bin']) fs.mkdirSync(path.join(state, dir), { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(state, 'claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'STAGING-NOT-A-TOKEN', refreshToken: 'STAGING-NOT-A-TOKEN' } }))
fs.writeFileSync(path.join(state, 'codex/auth.json'), JSON.stringify({ tokens: { access_token: 'STAGING-NOT-A-TOKEN' } }))
fs.writeFileSync(path.join(state, 'empty-auth.json'), '{}')
fs.writeFileSync(path.join(state, 'apps.json'), JSON.stringify({ apps: [{ id: 'wizard-claude', view: { url: '/wizard-claude/' } }, { id: 'wizard-chatgpt', view: { url: '/wizard-chatgpt/' } }] }))
const common = `const fs=require('node:fs'),path=require('node:path');const state=path.resolve(__dirname,'..');const emit=j=>console.log(JSON.stringify(j));\n`
fs.writeFileSync(path.join(state, 'bin/claude'), `#!${process.execPath}\n` + common + `emit({type:'system',subtype:'init',model:'claude-opus-5-5',tools:[]});const valid=fs.existsSync(path.join(state,'signed-in'));const text=valid?'OK':'Failed to authenticate: OAuth session expired and could not be refreshed';emit({type:'assistant',message:{model:'claude-opus-5-5',content:[{type:'text',text}]}});emit({type:'result',is_error:!valid,result:text});\n`, { mode: 0o755 })
fs.writeFileSync(path.join(state, 'bin/codex'), `#!${process.execPath}\n` + common + `const prompt=process.argv.at(-1)||'';const probe=prompt.startsWith('Reply with just OK.');const text=probe?'OK':'STAGING · ChatGPT (simulated): Claude’s sign-in has expired. Tap Sign in to Claude again above.';emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({text,calls:[]})}});\n`, { mode: 0o755 })
console.log('Synthetic Claude and Codex stand-ins prepared; no real credentials read.')
