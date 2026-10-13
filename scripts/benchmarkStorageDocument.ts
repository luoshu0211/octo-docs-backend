import * as Y from 'yjs'
import { persistence } from '../src/collab/persistence.js'
import { applyStoredState } from '../src/collab/collabDatabase.js'
import { bindStateGeneration } from '../src/collab/stateGeneration.js'

/** Use the state and identity fetched under the same SQL lock, including on reruns. */
export async function loadBenchmarkSheet(documentName: string): Promise<Y.Doc> {
  const stored = await persistence.fetch(documentName)
  if (!stored?.generation) throw new Error('Benchmark document must be a registered sheet')
  const doc = new Y.Doc()
  try {
    bindStateGeneration(doc, stored.generation)
    applyStoredState(doc, stored)
    return doc
  } catch (error) { doc.destroy(); throw error }
}
