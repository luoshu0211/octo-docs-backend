import { afterEach, expect, it, vi } from 'vitest'
import { logPptPersistenceFailure, pptPersistenceFailure } from '../src/ppt/relay/persistenceFailure.js'
afterEach(() => vi.restoreAllMocks())
it('distinguishes capacity while redacting raw storage error details', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  logPptPersistenceFailure(pptPersistenceFailure('d_1', new Error('PPT session actor limit reached')))
  expect(JSON.parse(log.mock.calls[0]![0])).toEqual({ event: 'ppt_relay_persistence_failed', docId: 'd_1', reason: 'actor-capacity' })
  logPptPersistenceFailure(pptPersistenceFailure('d_1', new Error('SQL with private deck and password')))
  expect(log.mock.calls[1]![0]).not.toMatch(/SQL|private|password/)
})
