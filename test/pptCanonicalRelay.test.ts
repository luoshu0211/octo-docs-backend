import { expect, it, vi } from 'vitest'
import type { PptRelayDeps } from '../src/ppt/relay/pptRelay.js'
const state = vi.hoisted(() => ({ deps: undefined as PptRelayDeps | undefined }))
vi.mock('../src/ppt/relay/pptRelay.js', () => ({ PptRelay: class { constructor(deps: PptRelayDeps) { state.deps = deps } } }))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({ docMetaRepo: { getByDocId: async (id: string) => id.toLowerCase() === 'd_case' ? { doc_id: 'd_case', status: 1 } : null } }))
import { createPptRelay } from '../src/ppt/relay/index.js'
it('rejects noncanonical old room identities at the production connect/reauth liveness boundary', async () => {
  createPptRelay()
  expect(await state.deps!.docStatusProvider!('d_case')).toBe('live')
  expect(await state.deps!.docStatusProvider!('D_CASE')).toBe('deleted')
  expect(await state.deps!.docStatusProvider!('missing')).toBe('deleted')
})
