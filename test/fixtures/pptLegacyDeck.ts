import type { BentoDoc } from '../../src/ppt/bentoDoc.js'
import savedDecks from './pptLegacyDecks.json' with { type: 'json' }

// Frozen pre-retirement document content, not a creation catalogue. Existing
// documents must remain usable without resolving their old template IDs.
export function legacyPptDeck(id: keyof typeof savedDecks = 'pitch'): BentoDoc {
  return structuredClone(savedDecks[id]) as BentoDoc
}
