import { describe, expect, it } from 'vitest'
import { projectWizardMessageHistory } from '../server/service.mjs'

const project = (rows: unknown[]) => JSON.parse(projectWizardMessageHistory(Buffer.from(JSON.stringify({ data: rows }))).toString()).data
const ids = (rows: Array<{ id: number }>) => rows.map(row => row.id)

const reply = { id: 10, session_id: 's', role: 'assistant', timestamp: 100.5, content: 'Removed the allowance alert.', finish_reason: 'stop' }
const alert = { id: 11, session_id: 's', role: 'assistant', timestamp: 200.25, content: '**Model fallback used in 1 thread**' }
const question = { id: 12, session_id: 's', role: 'user', timestamp: 300.75, content: 'Why did it fail?' }

describe('compaction replays in Wizard history', () => {
  it('drops an older reply re-emitted after the newest question with later alerts merged onto it', () => {
    const merged = { ...reply, id: 40, content: `${reply.content}\n${alert.content}` }
    const answer = { id: 41, session_id: 's', role: 'assistant', timestamp: 301, content: 'Safety filter.', finish_reason: 'stop' }
    expect(ids(project([reply, alert, question, merged, answer]))).toEqual([10, 11, 12, 41])
  })

  it('drops an exact same-timestamp copy of a message', () => {
    expect(ids(project([question, { ...question, id: 50 }]))).toEqual([12])
  })

  it('keeps a same-timestamp copy whose extra text appears nowhere else on the page', () => {
    const merged = { ...reply, id: 40, content: `${reply.content}\nOnly survives here.` }
    expect(ids(project([reply, question, merged]))).toEqual([10, 12, 40])
  })

  it('keeps distinct messages with different timestamps or roles', () => {
    const again = { ...reply, id: 60, timestamp: 400 }
    const userTwin = { ...reply, id: 61, role: 'user' }
    expect(ids(project([reply, question, again, userTwin]))).toEqual([10, 12, 60, 61])
  })
})
