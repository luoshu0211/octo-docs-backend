import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { config } from '../src/config/env.js'
import { transaction, type Tx } from '../src/db/pool.js'
import { docVersionRepo } from '../src/db/repos/docVersionRepo.js'
import { yjsDocumentRepo } from '../src/db/repos/yjsDocumentRepo.js'
import { restoreVersion } from '../src/api/services/restoreVersion.js'
import { applyRestoreToLiveDoc } from '../src/collab/liveRestore.js'
import * as versionRestore from '../src/collab/versionRestore.js'
import { encodeStorageState } from '../src/collab/storageCodec.js'

vi.mock('../src/db/pool.js', () => ({ query: vi.fn(), transaction: vi.fn() }))
vi.mock('../src/collab/liveRestore.js', () => ({ applyRestoreToLiveDoc: vi.fn(), applyBoardRestoreToLiveDoc: vi.fn() }))
vi.mock('../src/collab/liveDocRead.js', () => ({ readLiveDocState: vi.fn(async () => new Uint8Array([0, 0])) }))

const original = { maxDocBytes: config.maxDocBytes, maxDocStorageBytes: config.maxDocStorageBytes, yjsStorageGzip: config.yjsStorageGzip, yjsWriteV2: config.yjsWriteV2 }
const input = { uid: 'owner', docId: 'restore', documentName: 'restore', principalSpaceId: 'space', versionId: 1, authorizedEpoch: 7 }
let validated: Uint8Array

beforeEach(() => {
  Object.assign(config, { maxDocBytes: 1048576, maxDocStorageBytes: 1048576, yjsStorageGzip: true, yjsWriteV2: true })
  const doc = new Y.Doc()
  for (let index = 0; index < 2000; index++) doc.getMap('sheet').set(`default!${index}:0`, { v: index, t: 2 })
  validated = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  vi.spyOn(versionRestore, 'restoreReconcile').mockReturnValue(validated)
  vi.spyOn(yjsDocumentRepo, 'selectForUpdateTx').mockResolvedValue(null)
  vi.spyOn(docVersionRepo, 'getStateById').mockResolvedValue({
    version: { docId: input.docId, schemaVersion: versionRestore.currentSchemaVersionFor('document') },
    state: validated,
  } as never)
  vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(2)
  vi.mocked(transaction).mockImplementation(async (operation) => operation({
    query: vi.fn(async (sql: string) => sql.includes('FROM doc_meta')
      ? [{ owner_id: input.uid, owner_space_id: input.principalSpaceId, permission_epoch: 7, status: 1 }]
      : []),
  } as unknown as Tx))
})

afterEach(() => {
  Object.assign(config, original)
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('restore storage preflight with mocked reconciliation and live apply', () => {
  it.each([false, true])('uses the selected persisted representation when V2 is %s', async (yjsWriteV2) => {
    const encoding = yjsWriteV2 ? 2 : 1
    const state = yjsWriteV2 ? Y.convertUpdateFormatV1ToV2(validated) : validated
    const stored = encodeStorageState(state, encoding)
    Object.assign(config, { yjsWriteV2, maxDocBytes: state.length, maxDocStorageBytes: stored.state.length })
    if (yjsWriteV2) expect(validated.length).toBeGreaterThan(state.length)
    await expect(restoreVersion(input)).resolves.toEqual({ ok: true, restoredFrom: 1, newDocVersionSeq: 2 })
    expect(docVersionRepo.createTx).toHaveBeenCalledTimes(1)
    expect(applyRestoreToLiveDoc).toHaveBeenCalledWith(input.documentName, input.uid, validated)
  })

  it('rejects physical overflow before creating a safety snapshot or changing live content', async () => {
    Object.assign(config, { maxDocStorageBytes: 10 })
    await expect(restoreVersion(input)).rejects.toMatchObject({ name: 'StorageBudgetError', dimension: 'stored' })
    expect(docVersionRepo.createTx).not.toHaveBeenCalled()
    expect(applyRestoreToLiveDoc).not.toHaveBeenCalled()
  })
})
