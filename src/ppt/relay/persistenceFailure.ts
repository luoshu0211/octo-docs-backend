export interface PptPersistenceFailure {
  docId: string
  reason: 'actor-capacity' | 'actor-sequence' | 'invalid-title' | 'storage'
}

export function pptPersistenceFailure(docId: string, error: unknown): PptPersistenceFailure {
  const message = error instanceof Error ? error.message : ''
  const reason = message === 'PPT session actor limit reached' ? 'actor-capacity'
    : message === 'actor sequence must be contiguous' ? 'actor-sequence'
      : message === 'invalid title' ? 'invalid-title' : 'storage'
  return { docId, reason }
}

/** Never log SQL parameters, document payloads or credentials from raw errors. */
export function logPptPersistenceFailure(failure: PptPersistenceFailure): void {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ event: 'ppt_relay_persistence_failed', ...failure }))
}
