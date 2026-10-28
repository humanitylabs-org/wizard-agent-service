import { describe, expect, it } from 'vitest'
import { ownerApprovalFromTool } from '../server/owner-approval-projection.mjs'
import { projectWizardMessageHistory } from '../server/service.mjs'
const approval = { error: 'needs_owner_approval', app: 'files', risks: ['app: privileged (full control of the server)'], approve_url: '/wizard-os-home/store-install/_approve/files/' + 'a'.repeat(64) }
const project = (row: unknown) => JSON.parse(projectWizardMessageHistory(Buffer.from(JSON.stringify({ data: [row] }))).toString()).data[0]
describe('owner approval display projection', () => {
  it('keeps the exact refusal fields for install update and restore without exposing command or raw tool text', () => {
    for (const operation of ['install', 'update', 'restore']) {
      const row = project({ id: operation, role: 'tool', tool_name: 'terminal', content: JSON.stringify({ stderr: JSON.stringify({ ...approval, command: 'private command', token: 'private token' }), output: 'private output' }) })
      expect(row.owner_approval).toEqual(approval)
      expect(row.content).toBe('')
      expect(JSON.stringify(row)).not.toContain('private')
    }
  })
  it('extracts CLI stderr and content text wrappers without inventing approval fields', () => {
    expect(ownerApprovalFromTool({ content: [{ type: 'text', text: JSON.stringify({ output: JSON.stringify(approval) }) }] })).toEqual(approval)
    expect(ownerApprovalFromTool('refused\n' + JSON.stringify(approval) + '\n')).toEqual(approval)
    expect(ownerApprovalFromTool({ error: 'other' })).toBeNull()
  })
  it('refuses arbitrary links, changed app identifiers and oversized or invalid risks', () => {
    for (const approve_url of ['https://elsewhere.invalid' + approval.approve_url, 'javascript:alert(1)', approval.approve_url + '?x=1', '//elsewhere.invalid']) expect(ownerApprovalFromTool({ ...approval, approve_url })).toBeNull()
    expect(ownerApprovalFromTool({ ...approval, app: '../files' })).toBeNull()
    expect(ownerApprovalFromTool({ ...approval, risks: [{}] })).toBeNull()
    expect(ownerApprovalFromTool({ ...approval, risks: ['x'.repeat(4097)] })).toBeNull()
  })
  it('does not trust a preexisting owner_approval field or promote user and assistant text into a tool action', () => {
    const fake = project({ role: 'tool', content: 'ordinary tool output', owner_approval: approval })
    expect(fake.owner_approval).toBeUndefined()
    for (const role of ['user', 'assistant']) expect(project({ role, content: JSON.stringify(approval) }).owner_approval).toBeUndefined()
  })
  it('extracts from the original tool message even when another projection has removed content', () => {
    const source = Buffer.from(JSON.stringify({data:[{role:'tool',content:JSON.stringify(approval)}]}))
    const scrubbed = Buffer.from(JSON.stringify({data:[{role:'tool',content:''}]}))
    expect(JSON.parse(projectWizardMessageHistory(scrubbed,source).toString()).data[0].owner_approval).toEqual(approval)
  })
})
