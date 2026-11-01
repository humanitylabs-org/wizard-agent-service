import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { visibleMemoryText, projectMemoryContent } from '../server/memory-context-projection.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

it('daily Hermes plugins pass portable synthetic contracts', () => {
  const result = execFileSync('python3', ['tests/test_daily_hermes_plugins.py'], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  expect(result).toBe('')
})

it('Working context stays hidden in text and multimodal history without changing human words', () => {
  const context = execFileSync('python3', ['-c', `import runpy; print(runpy.run_path('hermes-plugin/wizard-work-progress/__init__.py')['CONTEXT'], end='')`], { cwd: root, encoding: 'utf8' })
  const human = 'Build the browser preview and verify playback.'
  expect(visibleMemoryText(human + '\n\n' + context)).toBe(human)
  const image = { type: 'image_url', image_url: { url: 'fixture://synthetic-image' } }
  const canonical = [{ type: 'text', text: human }, image, { type: 'text', text: context }]
  const original = JSON.stringify(canonical)
  expect(projectMemoryContent(canonical)).toEqual([{ type: 'text', text: human }, image])
  expect(JSON.stringify(canonical)).toBe(original)
})
