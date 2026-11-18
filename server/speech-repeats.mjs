// A speech-to-text reading sometimes writes a sentence twice in a row: the model decodes the end of a short take
// again, so "Meet me at the station after the late meeting." comes back as that sentence twice (wizard-messenger
// issue 298). Nobody says a long sentence twice word for word, so the repeat is dropped here, in
// the one transcription step every dictation, voice note and orb take goes through.
//
// The rule is the one Archimedes Anywhere tuned on real dictation (DictationCleanup.collapseRepeatedSentenceLoops
// in the Android app): a sentence of three or more words repeated three or more times in a
// row is a decoder loop; a sentence of eight or more words that comes twice in a row is a repeat. Short repeats
// ("No. No.", "Go. Go. Go.") are ordinary speech and stay. A take that is
// a whole passage said twice ("A. B. A. B.", eight or more words) keeps one copy.

const SENTENCE = /[^.!?。！？]+(?:[.!?。！？]+["'”’)\]]*|$)/gu
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu
export const LONG_REPEAT_WORDS = 8

// Words by the runtime's word segmenter, so languages written without spaces (Chinese, Japanese, Thai) count words
// too; the regex is the fallback for a runtime without Intl.Segmenter.
const SEGMENTER = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null
const words = (text) => {
  const lower = String(text).toLowerCase()
  if (!SEGMENTER) return lower.match(WORD) || []
  return [...SEGMENTER.segment(lower)].filter((part) => part.isWordLike).map((part) => part.segment)
}
const same = (a, b) => a.length === b.length && a.every((word, i) => word === b[i])

const sentences = (text) => [...text.matchAll(SENTENCE)].filter((m) => m[0].trim()).map((m) => ({ text: m[0], words: words(m[0]) }))

/** The reading with repeated sentences dropped; any other text is returned unchanged. */
export function collapseSpeechRepeats(text) {
  if (typeof text !== 'string' || !text.trim()) return text
  const list = sentences(text)
  if (list.length < 2) return text
  const keep = []
  let changed = false
  for (let i = 0; i < list.length;) {
    let j = i + 1
    while (j < list.length && list[i].words.length && same(list[i].words, list[j].words)) j++
    const run = j - i, n = list[i].words.length
    keep.push(list[i])
    if ((run >= 3 && n >= 3) || (run === 2 && n >= LONG_REPEAT_WORDS)) changed = true
    else for (let k = i + 1; k < j; k++) keep.push(list[k])
    i = j
  }
  let result = keep
  // A whole passage said twice: the first half of the sentences equals the second half.
  if (!changed && list.length % 2 === 0) {
    const half = list.length / 2
    const first = list.slice(0, half).flatMap((s) => s.words), second = list.slice(half).flatMap((s) => s.words)
    if (first.length >= LONG_REPEAT_WORDS && same(first, second)) { result = list.slice(0, half); changed = true }
  }
  if (!changed) return text
  return result.map((s) => s.text.trim()).join(' ')
}
