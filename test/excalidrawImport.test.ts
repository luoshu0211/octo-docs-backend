import { describe, expect, it, vi } from 'vitest'
import { generateKeyBetween } from 'fractional-indexing'
import { config } from '../src/config/env.js'
import { sanitizeSvg } from '../src/util/sanitizeSvg.js'
import { preparePortableExcalidrawImport, cleanupReplacedExcalidrawAttachments, prepareExcalidrawImport, ExcalidrawImportError } from '../src/import/excalidraw.js'

const PNG = `data:image/png;base64,${Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]).toString('base64')}`
const rect = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'rectangle', version: 1, versionNonce: 1, x: 0, y: 0, width: 10, height: 10, ...extra })

describe('prepareExcalidrawImport', () => {
  it('remaps colliding element/file ids and every supported reference, with appended legal indexes', async () => {
    const upload = vi.fn(async () => 'att_target')
    const result = await prepareExcalidrawImport({
      docId: 'd1', uid: 'u1', upload,
      existingElements: [rect('box', { index: 'a0' })],
      existingFiles: { image: { attachId: 'att_old' } },
      scene: {
        type: 'excalidraw', version: 2,
        elements: [
          rect('box', { boundElements: [{ id: 'text', type: 'text' }] }),
          { id: 'text', type: 'text', version: 1, versionNonce: 2, containerId: 'box', frameId: 'box' },
          { id: 'arrow', type: 'arrow', version: 1, versionNonce: 3, startBinding: { elementId: 'box' }, endBinding: { elementId: 'text' } },
          { id: 'photo', type: 'image', version: 1, versionNonce: 4, fileId: 'image' },
        ],
        files: { image: { dataURL: PNG, mimeType: 'image/png', created: 10 } },
      },
    })
    const mappedBox = result.elementIdMap.box
    const mappedFile = result.fileIdMap.image
    expect(mappedBox).not.toBe('box')
    expect(mappedFile).not.toBe('image')
    expect(result.elements[0]!.boundElements).toEqual([{ id: 'text', type: 'text' }])
    expect(result.elements[1]!.containerId).toBe(mappedBox)
    expect(result.elements[1]!.frameId).toBe(mappedBox)
    expect((result.elements[2]!.startBinding as { elementId: string }).elementId).toBe(mappedBox)
    expect(result.elements[3]!.fileId).toBe(mappedFile)
    expect(result.files[mappedFile]).toEqual({ attachId: 'att_target', mimeType: 'image/png', status: 'saved', createdAt: 10 })
    for (const el of result.elements) expect(() => generateKeyBetween(el.index as string, null)).not.toThrow()
    expect(JSON.stringify(result)).not.toContain('base64')
  })

  it('sanitizes embedded SVG before upload and stores only an attachment ref', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>'
    const upload = vi.fn(async () => 'att_svg')
    const result = await prepareExcalidrawImport({
      docId: 'd1', uid: 'u1', upload, existingElements: [], existingFiles: {},
      scene: { type: 'excalidraw', version: 2, elements: [{ id: 'i', type: 'image', fileId: 'f' }], files: { f: { dataURL: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` } } },
    })
    const uploaded = upload.mock.calls[0]![0].toString('utf8')
    expect(uploaded).toContain('<svg')
    expect(uploaded).not.toContain('<script')
    expect(result.files.f!.attachId).toBe('att_svg')
    expect(JSON.stringify(result)).not.toContain('data:')
  })

  it('rejects malformed/foreign inline data and duplicate ids', async () => {
    const base = { docId: 'd1', uid: 'u1', upload: vi.fn(), existingElements: [], existingFiles: {} }
    await expect(prepareExcalidrawImport({ ...base, scene: { type: 'excalidraw', version: 2, elements: [rect('x'), rect('x')], files: {} } })).rejects.toMatchObject({ code: 'duplicate_element_id' })
    await expect(prepareExcalidrawImport({ ...base, scene: { type: 'excalidraw', version: 2, elements: [rect('x', { custom: 'data:text/plain;base64,QQ==' })], files: {} } })).rejects.toBeInstanceOf(ExcalidrawImportError)
    await expect(prepareExcalidrawImport({ ...base, scene: { type: 'excalidraw', version: 2, elements: [{ id: 'i', type: 'image', fileId: 'f' }], files: { f: { dataURL: 'data:image/png;base64,!!!!' } } } })).rejects.toMatchObject({ code: 'invalid_embedded_file' })
  })

  it('counts the inline image in the v1 file limit and accepts it under the CLI image limit', async () => {
    const upload = vi.fn().mockResolvedValue('attachment')
    const png = Buffer.alloc(config.boardSceneWrite.maxElementContentBytes)
    Buffer.from(PNG.split(',')[1]!, 'base64').copy(png)
    const input = {
      docId: 'd1', uid: 'u1', upload, existingElements: [], existingFiles: {},
      scene: { type: 'excalidraw', version: 2, elements: [{ id: 'i', type: 'image', fileId: 'f' }],
        files: { f: { dataURL: 'data:image/png;base64,' + png.toString('base64') } } },
    }
    await expect(prepareExcalidrawImport(input)).rejects.toMatchObject({ code: 'board_file_invalid', status: 422 })
    expect(upload).not.toHaveBeenCalled()
    await expect(preparePortableExcalidrawImport(input)).resolves.toMatchObject({ files: { f: { attachId: 'attachment' } } })
    expect(upload).toHaveBeenCalledOnce()
  })

  it('checks file metadata and decoded image size independently before uploading', async () => {
    const upload = vi.fn()
    const base = { docId: 'd1', uid: 'u1', upload, existingElements: [], existingFiles: {} }
    const scene = { type: 'excalidraw', version: 2, elements: [{ id: 'i', type: 'image', fileId: 'f' }] }
    await expect(preparePortableExcalidrawImport({
      ...base,
      scene: { ...scene, files: { f: { dataURL: PNG, extra: 'x'.repeat(config.boardSceneWrite.maxElementContentBytes) } } },
    })).rejects.toMatchObject({ code: 'board_file_invalid' })

    const oversized = Buffer.alloc(config.attachments.maxImageSizeBytes + 1)
    Buffer.from(PNG.split(',')[1]!, 'base64').copy(oversized)
    await expect(preparePortableExcalidrawImport({
      ...base,
      scene: { ...scene, files: { f: { dataURL: 'data:image/png;base64,' + oversized.toString('base64') } } },
    })).rejects.toMatchObject({ code: 'embedded_file_too_large', status: 413 })
    expect(upload).not.toHaveBeenCalled()
  })

  it('enforces the configured image size after expanding SVG markup during sanitation', async () => {
    const upload = vi.fn()
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" style="fill:red"><circle r="1" /></svg>')
    expect(sanitizeSvg(svg).length).toBeGreaterThan(svg.length)
    const originalLimit = config.attachments.maxImageSizeBytes
    config.attachments.maxImageSizeBytes = svg.length
    try {
      await expect(preparePortableExcalidrawImport({
        docId: 'd1', uid: 'u1', upload, existingElements: [], existingFiles: {},
        scene: {
          type: 'excalidraw', version: 2, elements: [{ id: 'i', type: 'image', fileId: 'f' }],
          files: { f: { dataURL: 'data:image/svg+xml;base64,' + svg.toString('base64') } },
        },
      })).rejects.toMatchObject({ code: 'embedded_file_too_large', status: 413 })
    } finally {
      config.attachments.maxImageSizeBytes = originalLimit
    }
    expect(upload).not.toHaveBeenCalled()
  })

  it('strictly requires Excalidraw type and version 2', async () => {
    const base = { docId: 'd1', uid: 'u1', upload: vi.fn(), existingElements: [], existingFiles: {} }
    for (const scene of [
      { version: 2, elements: [], files: {} },
      { type: 'excalidraw', elements: [], files: {} },
      { type: 'excalidraw', version: 1, elements: [], files: {} },
    ]) {
      await expect(prepareExcalidrawImport({ ...base, scene })).rejects.toMatchObject({ code: 'invalid_excalidraw' })
    }
  })

  it('namespaces groupIds consistently and away from existing groups', async () => {
    const result = await prepareExcalidrawImport({
      docId: 'd1', uid: 'u1', upload: vi.fn(),
      existingElements: [rect('old', { groupIds: ['group-a'] })], existingFiles: {},
      scene: {
        type: 'excalidraw', version: 2, files: {},
        elements: [rect('a', { groupIds: ['group-a', 'nested'] }), rect('b', { groupIds: ['group-a'] })],
      },
    })
    const groupsA = result.elements[0]!.groupIds as string[]
    const groupsB = result.elements[1]!.groupIds as string[]
    expect(groupsA[0]).toBe(groupsB[0])
    expect(groupsA[0]).not.toBe('group-a')
    expect(groupsA[1]).not.toBe('nested')
  })

  it('performs all pure element validation before uploading any file', async () => {
    const upload = vi.fn(async () => 'att_never')
    await expect(prepareExcalidrawImport({
      docId: 'd1', uid: 'u1', upload, existingElements: [], existingFiles: {},
      scene: {
        type: 'excalidraw', version: 2,
        elements: [{ id: 'i', type: 'image', fileId: 'f' }, { id: 'bad', type: 'not-supported' }],
        files: { f: { dataURL: PNG } },
      },
    })).rejects.toMatchObject({ code: 'board_element_invalid' })
    expect(upload).not.toHaveBeenCalled()
  })

  it('fails closed for a referenced missing file and skips an unreferenced valid file', async () => {
    const upload = vi.fn(async () => 'att_unused')
    const base = { docId: 'd1', uid: 'u1', upload, existingElements: [], existingFiles: {} }
    await expect(prepareExcalidrawImport({
      ...base,
      scene: { type: 'excalidraw', version: 2, elements: [{ id: 'i', type: 'image', fileId: 'missing' }], files: {} },
    })).rejects.toMatchObject({ code: 'board_element_invalid' })
    expect(upload).not.toHaveBeenCalled()

    const result = await prepareExcalidrawImport({
      ...base,
      scene: { type: 'excalidraw', version: 2, elements: [rect('r')], files: { unused: { dataURL: PNG } } },
    })
    expect(upload).not.toHaveBeenCalled()
    expect(result.files).toEqual({})
  })
})


describe('cleanupReplacedExcalidrawAttachments', () => {
  it('deletes only attachments authoritatively owned by the replaced board and keeps rows on object failure', async () => {
    const { docAttachmentRepo } = await import('../src/db/repos/docAttachmentRepo.js')
    const { getObjectStore } = await import('../src/storage/objectStore.js')
    const getById = vi.spyOn(docAttachmentRepo, 'getById')
      .mockImplementation(async (attachId) => {
        if (attachId === 'att_owned') return { attachId, docId: 'b1', objectKey: 'b1/att_owned/a.png' } as never
        if (attachId === 'att_retry') return { attachId, docId: 'b1', objectKey: 'b1/att_retry/b.png' } as never
        if (attachId === 'att_foreign') return { attachId, docId: 'other', objectKey: 'other/att_foreign/c.png' } as never
        return null
      })
    const deleteById = vi.spyOn(docAttachmentRepo, 'deleteById').mockResolvedValue()
    const deleteObject = vi.spyOn(getObjectStore(), 'delete')
      .mockImplementation(async (key) => { if (key.includes('att_retry')) throw new Error('transient') })

    await cleanupReplacedExcalidrawAttachments('b1', {
      one: { attachId: 'att_owned' },
      duplicate: { attachId: 'att_owned' },
      retry: { attachId: 'att_retry' },
      foreign: { attachId: 'att_foreign' },
      external: { dataURL: 'https://example.test/image.png' },
    })

    expect(getById).toHaveBeenCalledTimes(3)
    expect(deleteObject).toHaveBeenCalledWith('b1/att_owned/a.png')
    expect(deleteById).toHaveBeenCalledWith('att_owned')
    expect(deleteById).not.toHaveBeenCalledWith('att_retry')
    expect(deleteObject).not.toHaveBeenCalledWith('other/att_foreign/c.png')
    expect(deleteById).not.toHaveBeenCalledWith('att_foreign')
  })
})
