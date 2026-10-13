import type * as Y from 'yjs'

const generations = new WeakMap<Y.Doc, string | null>()
export function bindStateGeneration(doc: Y.Doc, generation: string | null): void {
  generations.set(doc, generation)
}
export function stateGenerationOf(doc: Y.Doc): string | null | undefined {
  return generations.get(doc)
}
export class StateGenerationMismatch extends Error {
  constructor() { super('document state generation changed; preserve local work and reload'); this.name = 'StateGenerationMismatch' }
}
export function assertStateGeneration(doc: Y.Doc, generation: string | null): void {
  const loaded = stateGenerationOf(doc)
  if ((generation !== null || loaded != null) && loaded !== generation) throw new StateGenerationMismatch()
}

/** The JWT remains the ONLY authority. The envelope pins the cache identity across token refresh. */
export function parseGenerationToken(raw: string): { token: string; generation: string | null } {
  if (!raw.startsWith('{')) return { token: raw, generation: null }
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid collaboration envelope')
  const p = parsed as Record<string, unknown>
  if (p.protocol !== 'octo-sheet-generation-v1' || typeof p.token !== 'string' ||
      typeof p.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(p.generation)) throw new Error('invalid collaboration envelope')
  return { token: p.token, generation: p.generation }
}
