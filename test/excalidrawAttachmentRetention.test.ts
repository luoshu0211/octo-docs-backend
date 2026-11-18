import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { Request, Response } from 'express'
import type { DocAttachment, RegisterAttachmentInput } from '../src/db/repos/docAttachmentRepo.js'

// Keep import preparation, attachment cleanup, scene-edit core and restore
// decoding real. Replace the authorization, database, storage and live-server IO.
const state = vi.hoisted(() => ({
  live: new Uint8Array([0, 0]) as Uint8Array,
  safety: new Uint8Array([0, 0]) as Uint8Array,
  rows: new Map<string, DocAttachment>(),
  objects: new Map<string, Uint8Array>(),
}))
vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/collab/liveBoardWrite.js', () => ({ readLiveBoard: vi.fn() }))
vi.mock('../src/api/services/editBoardScene.js', () => ({ editBoardScene: vi.fn() }))
vi.mock('../src/db/repos/docAttachmentRepo.js', () => ({
  docAttachmentRepo: {
    register: vi.fn(async (input: RegisterAttachmentInput) => {
      state.rows.set(input.attachId, { ...input, createdAt: new Date(0) })
    }),
    getById: vi.fn(async (id: string) => state.rows.get(id) ?? null),
    deleteById: vi.fn(async (id: string) => { state.rows.delete(id) }),
  },
}))
vi.mock('../src/storage/objectStore.js', () => ({
  getObjectStore: () => ({
    upload: async (key: string, _mime: string, bytes: Uint8Array) => { state.objects.set(key, bytes) },
    download: async (key: string) => {
      const bytes = state.objects.get(key)
      if (!bytes) throw new Error('object_not_found')
      return bytes
    },
    delete: async (key: string) => { state.objects.delete(key) },
    presignGet: () => 'https://storage.example/fixture',
  }),
}))

import { importExcalidrawHandler } from '../src/api/routes/import.js'
import { readHandler } from '../src/api/routes/attachments.js'
import { requireDocRole } from '../src/api/guard.js'
import { readLiveBoard } from '../src/collab/liveBoardWrite.js'
import { editBoardScene } from '../src/api/services/editBoardScene.js'
import { decodeBoardSnapshot, restoreReconcileBoard } from '../src/collab/versionRestore.js'
import { applyBoardOpsToDoc, validateBoardOps } from '../src/whiteboard/boardEdit.js'
import { docAttachmentRepo } from '../src/db/repos/docAttachmentRepo.js'
import { getObjectStore } from '../src/storage/objectStore.js'
import * as pool from '../src/db/pool.js'

const OLD = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4QAAAABJRU5ErkJggg==', 'base64')
const NEW = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAFAAAAAoCAIAAADmAupWAAAAS0lEQVR4nO3PAQkAIBDAQMuYzPiWMIawP1iA3drnjmp9PwAGBgYGBgYeE3A94HrA9YDrAdcDrgdcD7gecD3gesD1gOsB1wOuB1zvAeVbHo9A+DXnAAAAAElFTkSuQmCC', 'base64')

function response() {
  return { statusCode: 0, body: undefined as unknown, status(code: number) { this.statusCode = code; return this }, json(body: unknown) { this.body = body; return this } }
}
function request(): Request {
  return { uid: 'u1', principalSpaceId: 's1', params: { docId: 'b1' }, originalUrl: '/b1/import/excalidraw?mode=replace', body: Buffer.from(JSON.stringify({
    type: 'excalidraw', version: 2,
    elements: [{ id: 'new', type: 'image', fileId: 'new-file', x: 0, y: 0, width: 80, height: 40, version: 1, versionNonce: 1 }],
    files: { 'new-file': { dataURL: `data:image/png;base64,${NEW.toString('base64')}` } },
  })) } as unknown as Request
}
async function expectReadableImage(id: string, bytes: Buffer) {
  const res = response()
  await readHandler({ params: { docId: 'b1', attachId: id } } as unknown as Request, res as unknown as Response)
  expect(res.statusCode).toBe(200)
  const row = await docAttachmentRepo.getById(id)
  expect(Buffer.from(await getObjectStore().download(row!.objectKey))).toEqual(bytes)
}

beforeEach(() => {
  vi.clearAllMocks()
  state.rows.clear()
  state.objects.clear()
  const doc = new Y.Doc()
  doc.transact(() => applyBoardOpsToDoc(doc, validateBoardOps({
    elements: [{ id: 'old', type: 'image', fileId: 'old-file', index: 'a0', x: 0, y: 0, width: 1, height: 1, version: 1, versionNonce: 1 }],
    files: { 'old-file': { attachId: 'att_old' } },
  })))
  state.live = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  state.rows.set('att_old', { attachId: 'att_old', docId: 'b1', objectKey: 'b1/att_old/old.png', mime: 'image/png', sizeBytes: OLD.length, fileName: 'old.png', createdBy: 'u1', createdAt: new Date(0) })
  state.objects.set('b1/att_old/old.png', OLD)
  vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_id: 'b1', document_name: 'board-b1', doc_type: 'board', permission_epoch: 2 } } as never)
  vi.mocked(readLiveBoard).mockImplementation(async () => ({ state: state.live, baseSV: new Uint8Array([9]) }))
  vi.mocked(editBoardScene).mockImplementation(async input => {
    state.safety = state.live
    input.onWriteStarted?.()
    const live = new Y.Doc()
    Y.applyUpdate(live, state.live)
    live.transact(() => applyBoardOpsToDoc(live, validateBoardOps(input.ops)))
    state.live = Y.encodeStateAsUpdate(live)
    live.destroy()
    return { ok: true, bytes: state.live.length, baseVersion: 'next', newDocVersionSeq: 4 }
  })
})

afterEach(() => { vi.restoreAllMocks() })

describe('Excalidraw attachment lifetime through import and version restore', () => {
  it.each(['preflight', 'transaction'] as const)('cleans new attachments when the real edit core fails during %s', async phase => {
    const actual = await vi.importActual<typeof import('../src/api/services/editBoardScene.js')>('../src/api/services/editBoardScene.js')
    const original = state.live
    if (phase === 'preflight') {
      vi.mocked(readLiveBoard)
        .mockResolvedValueOnce({ state: state.live, baseSV: new Uint8Array([9]) })
        .mockRejectedValueOnce(new Error('preflight read failed'))
    } else {
      vi.spyOn(pool, 'transaction').mockRejectedValueOnce(new Error('snapshot transaction failed'))
    }
    vi.mocked(editBoardScene).mockImplementationOnce(actual.editBoardScene)

    const res = response()
    await importExcalidrawHandler(request(), res as unknown as Response)

    expect(res.statusCode).toBe(500)
    expect(state.live).toEqual(original)
    expect([...state.rows.keys()]).toEqual(['att_old'])
    expect([...state.objects.keys()]).toEqual(['b1/att_old/old.png'])
    expect(docAttachmentRepo.deleteById).toHaveBeenCalledOnce()
    await expectReadableImage('att_old', OLD)
  })

  it('can read old image bytes after restoring the safety snapshot, then read the replacement after undo', async () => {
    const original = decodeBoardSnapshot(state.live)
    const res = response()
    await importExcalidrawHandler(request(), res as unknown as Response)
    expect(res.statusCode).toBe(200)
    const replaced = state.live
    const newRef = decodeBoardSnapshot(replaced).files['new-file']!

    state.live = restoreReconcileBoard(state.live, state.safety)
    expect(decodeBoardSnapshot(state.live)).toEqual(original)
    await expectReadableImage('att_old', OLD)

    state.live = restoreReconcileBoard(state.live, replaced)
    expect(decodeBoardSnapshot(state.live).files['new-file']).toEqual(newRef)
    await expectReadableImage(newRef.attachId as string, NEW)
    expect(state.rows.size).toBe(2)
    expect(state.objects.size).toBe(2)
  })

  it('keeps an image already referenced by the scene if commit throws after applying the edit', async () => {
    const commit = vi.mocked(editBoardScene).getMockImplementation()!
    vi.mocked(editBoardScene).mockImplementationOnce(async input => {
      await commit(input)
      throw new Error('persistence acknowledgement failed after apply')
    })
    const res = response()
    await importExcalidrawHandler(request(), res as unknown as Response)
    expect(res.statusCode).toBe(500)
    const ref = decodeBoardSnapshot(state.live).files['new-file']!
    const row = await docAttachmentRepo.getById(ref.attachId as string)
    expect(row).not.toBeNull()
    await expectReadableImage(ref.attachId as string, NEW)
    await expectReadableImage('att_old', OLD)
  })
})
