import { beforeEach, expect, it, vi } from 'vitest'
const open = vi.hoisted(() => vi.fn())
vi.mock('../src/ppt/relay/dbStore.js', () => ({ DbPptRelayStore: class { openReplay = open } }))
import { readCurrentPpt } from '../src/ppt/currentSource.js'
import { SyncState } from '../src/ppt/sync/slidesSync.js'
import { RetryableStorageError } from '../src/ppt/relay/store.js'

beforeEach(() => open.mockReset())
it('reduces the durable op tail over a snapshot and closes the bounded replay', async () => {
  const doc = { title: 'before', slides: [] }
  const sync = new SyncState('@base'); sync.adopt(doc)
  const close = vi.fn()
  open.mockResolvedValue({ snapshot: { doc, state: sync.toJSON(), coveredSeq: 0 }, highWater: 1, close,
    nextPage: vi.fn().mockResolvedValueOnce([{ seq: 1, frame: { ops: [{ op: 'set', k: 'title', v: 'after', a: 'admin', s: 1, l: 1 }] } }]).mockResolvedValue([]) })
  expect(await readCurrentPpt('d_1')).toMatchObject({ deck: { title: 'after' }, revision: 1 })
  expect(doc.title).toBe('before'); expect(close).toHaveBeenCalledOnce()
  expect(open).toHaveBeenCalledWith('d_1', 0, { pageRows: 128, pageBytes: 262144 })
})
it('restarts a pruned replay and never returns partially replayed content', async () => {
  const doc = { title: 'latest', slides: [] }; const sync = new SyncState('@base'); sync.adopt(doc)
  const close = vi.fn()
  open.mockResolvedValueOnce({ snapshot: { doc, state: sync.toJSON(), coveredSeq: 0 }, highWater: 1, close,
    nextPage: async () => { throw new RetryableStorageError('pruned') } })
    .mockResolvedValueOnce({ snapshot: { doc, state: sync.toJSON(), coveredSeq: 1 }, highWater: 1, close, nextPage: async () => [] })
  expect(await readCurrentPpt('d_1')).toMatchObject({ deck: { title: 'latest' } })
  expect(close).toHaveBeenCalledTimes(2)
})
