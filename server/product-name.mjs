// The product is spelled WizardOS: one word, always (James, 8 Nov 2026). Titles, subjects, Ready asks and
// voice transcripts that arrive with the two-word spelling are stored and shown as WizardOS.
//
// Only display spellings change: the two words in any case, with any spaces, a hyphen or a dash between them.
// The lowercase identifier wizard-os (repository, paths, slugs, ids) and anything joined to a path, an id or a
// longer word (humanitylabs-org/wizard-os, wizard-os-home, wizard_os, ~/.wizard-os) stays exactly as written.

export const PRODUCT_NAME = 'WizardOS'

const VARIANT = /(?<![\p{L}\p{N}_/.~-])wizard(?:[ \t\u00a0\u2009\u202f]+|[ \t\u00a0]*[-\u2010\u2011\u2013\u2014][ \t\u00a0]*)os(?![\p{L}\p{N}_/-])/giu

/** `text` with every display spelling of the product name written WizardOS. Non-strings pass through. */
export function spellProductName(text) {
  if (typeof text !== 'string' || !/wizard/iu.test(text)) return text
  return text.replace(VARIANT, (match) => match === 'wizard-os' ? match : PRODUCT_NAME)
}

/** True when `text` still holds a two-word (or hyphenated display) spelling of the product name. */
export const misspellsProductName = (text) => typeof text === 'string' && spellProductName(text) !== text
