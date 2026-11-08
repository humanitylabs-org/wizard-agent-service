import { describe, expect, it } from 'vitest'
import { contentDisposition } from '../server/content-disposition.mjs'

// Exact legacy AOSP URLUtil parser: android-14.0.0_r1/core/java/android/webkit/URLUtil.java.
const androidFilename = (header: string) => /attachment;\s*filename\s*=\s*("?)([^"]*)\1\s*$/i.exec(header)?.[2] ?? null

describe('Android-compatible download filenames', () => {
  it('reproduces the attachment-ID fallback for RFC5987-only and dual headers', () => {
    expect(androidFilename("attachment; filename*=UTF-8''Roadmap.md")).toBeNull()
    expect(androidFilename('attachment; filename="Roadmap.md"; filename*=UTF-8\'\'Roadmap.md')).toBeNull()
  })
  it.each(['WizardOS-Architecture-and-Roadmap.md', 'Wizard-First-Release-Spec-for-Jan.md', 'Notes for Jan (final).markdown'])('preserves %s in the current Android parser', (name) => {
    expect(androidFilename(contentDisposition('attachment', name))).toBe(name)
  })
  it('retains RFC5987 Unicode names for modern consumers', () => {
    const header = contentDisposition('attachment', 'Résumé — 道.md')
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1])).toBe('Résumé — 道.md')
    expect(header).toMatch(/^[\x20-\x7e]+$/)
  })
  it.each(['../report.md', 'x\r\nInjected: yes.md', 'bad"name.md', '\\path\\report.md', '', '..'])('keeps header and path syntax inert: %j', (name) => {
    const header = contentDisposition('attachment', name)
    expect(header).not.toMatch(/[\r\n]/)
    const quoted = /filename="([^"]*)"/.exec(header)?.[1]
    expect(quoted).toBeTruthy()
    expect(quoted).not.toMatch(/[\\/]/)
  })
})
