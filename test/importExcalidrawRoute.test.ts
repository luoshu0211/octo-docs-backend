import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'

vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/collab/liveBoardWrite.js', () => ({ readLiveBoard: vi.fn() }))
vi.mock('../src/collab/versionRestore.js', async (original) => {
  const actual = await original<typeof import('../src/collab/versionRestore.js')>()
  return { ...actual, decodeBoardSnapshot: vi.fn() }
})
vi.mock('../src/api/services/editBoardScene.js', () => ({ editBoardScene: vi.fn() }))
vi.mock('../src/import/excalidraw.js', async original => ({
  ...await original<typeof import('../src/import/excalidraw.js')>(),
  prepareExcalidrawImport: vi.fn(),
  preparePortableExcalidrawImport: vi.fn(),
  cleanupReplacedExcalidrawAttachments: vi.fn(),
  cleanupExcalidrawAttachments: vi.fn(),
}))

import { importExcalidrawHandler } from '../src/api/routes/import.js'
import { requireDocRole } from '../src/api/guard.js'
import { readLiveBoard } from '../src/collab/liveBoardWrite.js'
import { decodeBoardSnapshot } from '../src/collab/versionRestore.js'
import { editBoardScene } from '../src/api/services/editBoardScene.js'
import { prepareExcalidrawImport, preparePortableExcalidrawImport, cleanupReplacedExcalidrawAttachments } from '../src/import/excalidraw.js'
import { cleanupExcalidrawAttachments } from '../src/import/excalidraw.js'

function response() {
  return { statusCode: 0, body: undefined as unknown, status(c: number) { this.statusCode = c; return this }, json(b: unknown) { this.body = b; return this } }
}
function request(mode?: string): Request {
  return { uid: 'u1', spaceId: 's1', params: { docId: 'b1' }, originalUrl: `/b1/import/excalidraw${mode ? `?mode=${mode}` : ''}`, query: mode ? { mode } : {}, body: Buffer.from('{"type":"excalidraw","elements":[],"files":{}}') } as unknown as Request
}
function cliRequest(): Request {
  const req = request('replace')
  req.docSpaceScope = { mode: 'cli', spaceId: 's1' }
  return req
}
const guard = { meta: { doc_id: 'b1', document_name: 'board-b1', doc_type: 'board', permission_epoch: 2 } }

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.mocked(requireDocRole).mockResolvedValue(guard as never)
  vi.mocked(readLiveBoard).mockResolvedValue({ state: new Uint8Array([1]), baseSV: new Uint8Array([9]) })
  vi.mocked(decodeBoardSnapshot).mockReturnValue({ elements: [{ id: 'old', type: 'rectangle' }], files: {} })
  vi.mocked(prepareExcalidrawImport).mockResolvedValue({ elements: [{ id: 'new', type: 'rectangle' }], files: {}, elementIdMap: { new: 'new' }, fileIdMap: {} })
  vi.mocked(editBoardScene).mockResolvedValue({ ok: true, bytes: 12, baseVersion: 'next', newDocVersionSeq: 4 })
})

describe('POST /:docId/import/excalidraw', () => {
  it('defaults to merge and writes against the live base version without deleting current elements', async () => {
    const res = response()
    await importExcalidrawHandler(request(), res as unknown as Response)
    expect(res.statusCode).toBe(200)
    const input = vi.mocked(editBoardScene).mock.calls[0]![0]
    expect(input.clientBaseVersion).toEqual(new Uint8Array([9]))
    expect(input.ops.deletedElementIds).toBeUndefined()
    expect((res.body as { mode: string }).mode).toBe('merge')
  })

  it('replace explicitly tombstones current entries and cleans their persisted attachments after commit', async () => {
    const staleFiles = { stale: { attachId: 'a1' } }
    vi.mocked(decodeBoardSnapshot).mockReturnValue({ elements: [{ id: 'old' }, { id: 'gone', isDeleted: true }], files: staleFiles })
    const res = response()
    await importExcalidrawHandler(request('replace'), res as unknown as Response)
    expect(vi.mocked(editBoardScene).mock.calls[0]![0].ops.deletedElementIds).toEqual(['old', 'gone'])
    expect(vi.mocked(editBoardScene).mock.calls[0]![0].ops.deletedFileIds).toEqual(['stale'])
    expect(cleanupReplacedExcalidrawAttachments).toHaveBeenCalledWith('b1', staleFiles)
  })

  it('requires writer, board doc type, raw valid JSON, and one scalar known mode', async () => {
    const badMode = response(); await importExcalidrawHandler(request('append'), badMode as unknown as Response); expect(badMode.statusCode).toBe(400)
    const duplicateMode = request(); duplicateMode.originalUrl += '?mode=merge&mode=replace'; const badDuplicate = response(); await importExcalidrawHandler(duplicateMode, badDuplicate as unknown as Response); expect(badDuplicate.statusCode).toBe(400)
    const objectMode = request(); objectMode.originalUrl += '?mode[value]=replace'; const badObject = response(); await importExcalidrawHandler(objectMode, badObject as unknown as Response); expect(badObject.statusCode).toBe(400)
    const badJson = request(); badJson.body = Buffer.from('{'); const bad = response(); await importExcalidrawHandler(badJson, bad as unknown as Response); expect(bad.statusCode).toBe(400)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('writer')
  })

  it('cleans up staged attachments when the optimistic scene edit is rejected', async () => {
    vi.mocked(prepareExcalidrawImport).mockResolvedValue({
      elements: [], files: {}, elementIdMap: {}, fileIdMap: {},
      uploadedAttachments: [{ attachId: 'a1', objectKey: 'b1/a1/image.png' }],
    })
    vi.mocked(editBoardScene).mockResolvedValue({ ok: false, status: 412, error: 'base_version_stale' })
    const res = response()
    await importExcalidrawHandler(request('replace'), res as unknown as Response)
    expect(res.statusCode).toBe(412)
    expect(cleanupExcalidrawAttachments).toHaveBeenCalledWith([{ attachId: 'a1', objectKey: 'b1/a1/image.png' }])
  })

  it('cleans staged v1 attachments when a scene write throws', async () => {
    const uploads = [{ attachId: 'staged', objectKey: 'b1/staged/image.png' }]
    vi.mocked(prepareExcalidrawImport).mockResolvedValue({
      elements: [], files: {}, elementIdMap: {}, fileIdMap: {}, uploadedAttachments: uploads,
    })
    vi.mocked(editBoardScene).mockRejectedValueOnce(new Error('scene write failed'))
    const res = response()
    await importExcalidrawHandler(request('replace'), res as unknown as Response)
    expect(res.statusCode).toBe(500)
    expect(cleanupExcalidrawAttachments).toHaveBeenCalledWith(uploads)
    expect(cleanupReplacedExcalidrawAttachments).not.toHaveBeenCalled()
  })

  it('retains committed import attachments if delivering the response throws', async () => {
    vi.mocked(preparePortableExcalidrawImport).mockResolvedValue({
      elements: [], files: {}, elementIdMap: {}, fileIdMap: {},
      uploadedAttachments: [{ attachId: 'new', objectKey: 'b1/new/image.png' }],
    })
    const res = response()
    vi.spyOn(res, 'json').mockImplementationOnce(() => { throw new Error('response delivery failed') })
    await importExcalidrawHandler(cliRequest(), res as unknown as Response)
    expect(editBoardScene).toHaveBeenCalledOnce()
    expect(cleanupExcalidrawAttachments).not.toHaveBeenCalled()
  })

  it('retains prepared attachments when scene commit throws with an uncertain outcome', async () => {
    const uploads = [{ attachId: 'staged', objectKey: 'b1/staged/image.png' }]
    vi.mocked(preparePortableExcalidrawImport).mockResolvedValue({
      elements: [], files: {}, elementIdMap: {}, fileIdMap: {}, uploadedAttachments: uploads,
    })
    vi.mocked(editBoardScene).mockImplementationOnce(async input => {
      input.onWriteStarted?.()
      throw new Error('edit failed after scene mutation started')
    })
    const res = response()
    await importExcalidrawHandler(cliRequest(), res as unknown as Response)
    expect(res.statusCode).toBe(500)
    expect(cleanupExcalidrawAttachments).not.toHaveBeenCalled()
  })
})
