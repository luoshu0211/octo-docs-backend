import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import express from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  guard: vi.fn(), fetch: vi.fn(), imageFetch: vi.fn(),
  upload: vi.fn(), remove: vi.fn(), register: vi.fn(), deleteRow: vi.fn(), get: vi.fn(), download: vi.fn(),
}))
vi.mock('../src/api/guard.js', () => ({ requireDocRole: mocks.guard }))
vi.mock('../src/util/fetchExternalImage.js', () => ({
  fetchExternalImage: mocks.imageFetch, fetchExternalMedia: mocks.fetch,
}))
vi.mock('../src/storage/objectStore.js', () => ({
  getObjectStore: () => ({ upload: mocks.upload, delete: mocks.remove, download: mocks.download }),
}))
vi.mock('../src/db/repos/docAttachmentRepo.js', () => ({
  docAttachmentRepo: { register: mocks.register, deleteById: mocks.deleteRow, getById: mocks.get },
}))
import { ingestHandler } from '../src/api/routes/attachments.js'
import { config } from '../src/config/env.js'
import { LinkCardError } from '../src/util/ssrfGuard.js'
import { readPptMedia, embedPptMedia } from '../src/ppt/media.js'
import { instantiateTemplate } from '../src/ppt/bentoDoc.js'
import { getPptTemplate } from '../src/ppt/templates.js'

const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex')
// An Ogg BOS identification page containing an OpusHead packet. Use the actual
// file-type detector, not a mocked MIME, to cover its codec-qualified result.
const OPUS = Buffer.alloc(47)
OPUS.write('OggS'); OPUS[5] = 2; OPUS[26] = 1; OPUS[27] = 19
OPUS.write('OpusHead', 28); OPUS[36] = 1; OPUS[37] = 1
OPUS.writeUInt32LE(48000, 40)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64')
const WAV = Buffer.alloc(44)
WAV.write('RIFF'); WAV.writeUInt32LE(36, 4); WAV.write('WAVEfmt ', 8)
WAV.writeUInt32LE(16, 16); WAV.writeUInt16LE(1, 20); WAV.writeUInt16LE(1, 22)
WAV.writeUInt32LE(8000, 24); WAV.writeUInt32LE(16000, 28)
WAV.writeUInt16LE(2, 32); WAV.writeUInt16LE(16, 34); WAV.write('data', 36)
const guard = { meta: { doc_id: 'd_ppt', doc_type: 'html_ppt', permission_epoch: 3 }, role: 'writer' }
const source = 'https://cdn.example/video.mp4'
function response() {
  return {
    statusCode: 200,
    body: {} as { error?: string; mappings: Array<{ sourceUrl: string; attachId: string; ref: string; mime: string; sizeBytes: number }>; notIngested: Array<{ sourceUrl: string; reason: string }> },
    status(code: number) { this.statusCode = code; return this },
    json(body: unknown) { this.body = body as typeof this.body; return this },
    setHeader: vi.fn(),
  }
}
async function run(urls: unknown = [source]) {
  const res = response()
  const req = { uid: 'bot_1', params: { docId: 'd_ppt' }, body: { urls } } as unknown as Request
  await ingestHandler(req, res as unknown as Response)
  return res
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.guard.mockResolvedValue(guard)
  mocks.fetch.mockResolvedValue({ bytes: MP4, declaredContentType: 'application/octet-stream' })
  mocks.imageFetch.mockResolvedValue({ bytes: MP4, declaredContentType: 'video/mp4' })
})

describe('PPT URL ingestion through the shared attachment endpoint', () => {
  it('accepts uploaded MP4 despite a generic CDN MIME and returns a native PPT ref', async () => {
    const res = await run()
    expect(res.body.notIngested).toEqual([])
    expect(res.body.mappings).toHaveLength(1)
    const mapping = res.body.mappings[0]!
    expect(mapping).toMatchObject({ sourceUrl: source, mime: 'video/mp4', sizeBytes: MP4.length })
    expect(mapping.ref).toBe(`ppt-media:${mapping.attachId}`)
    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({
      docId: 'd_ppt', objectKey: `d_ppt/ppt-media/${mapping.attachId}`, createdBy: 'bot_1',
    }))
    expect(mocks.imageFetch).not.toHaveBeenCalled()
  })
  it('reads and exports the ingested bytes through PPT without changing the persisted ref', async () => {
    const res = await run()
    const mapping = res.body.mappings[0]!
    mocks.get.mockResolvedValue(mocks.register.mock.calls[0]![0])
    mocks.download.mockResolvedValue(mocks.upload.mock.calls[0]![2])
    expect((await readPptMedia('d_ppt', mapping.attachId)).bytes).toEqual(MP4)
    await expect(readPptMedia('another_doc', mapping.attachId)).rejects.toThrow('media not found')
    const deck = instantiateTemplate(getPptTemplate('blank')!, new Date().toISOString())
    deck.slides[0]!.elements = [{ id: 'video', type: 'media', src: mapping.ref }]
    const exported = await embedPptMedia(deck, 'd_ppt')
    expect(exported.slides[0]!.elements[0]!.src).toBe(`data:video/mp4;base64,${MP4.toString('base64')}`)
    expect(deck.slides[0]!.elements[0]!.src).toBe(mapping.ref)
  })
  it.each([[PNG, 'image/png'], [WAV, 'audio/wav'], [OPUS, 'audio/ogg']])('accepts image/audio bytes with a misleading source name', async (bytes, mime) => {
    mocks.fetch.mockResolvedValue({ bytes, declaredContentType: 'text/html' })
    const res = await run(['https://cdn.example/not-a-video.html'])
    expect(res.body.mappings[0]?.mime).toBe(mime)
    expect(res.body.mappings[0]?.ref).toMatch(/^ppt-media:/)
  })
  it('reads and exports codec-qualified Opus as canonical Ogg media', async () => {
    mocks.fetch.mockResolvedValue({ bytes: OPUS, declaredContentType: 'application/octet-stream' })
    const res = await run()
    expect(res.body.notIngested).toEqual([])
    const mapping = res.body.mappings[0]!
    mocks.get.mockResolvedValue(mocks.register.mock.calls[0]![0])
    mocks.download.mockResolvedValue(mocks.upload.mock.calls[0]![2])
    expect(await readPptMedia('d_ppt', mapping.attachId)).toMatchObject({ bytes: OPUS, row: { mime: 'audio/ogg' } })
    const deck = instantiateTemplate(getPptTemplate('blank')!, new Date().toISOString())
    deck.slides[0]!.elements = [{ id: 'audio', type: 'media', src: mapping.ref }]
    expect((await embedPptMedia(deck, 'd_ppt')).slides[0]!.elements[0]!.src).toBe(`data:audio/ogg;base64,${OPUS.toString('base64')}`)
  })
  it('sanitizes SVG before storing it as PPT media', async () => {
    mocks.fetch.mockResolvedValue({ bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>') })
    const res = await run()
    expect(res.body.mappings[0]?.mime).toBe('image/svg+xml')
    expect(Buffer.from(mocks.upload.mock.calls[0]![2]).toString()).not.toContain('<script')
  })
  it('preserves local SVG use references through shared URL ingestion', async () => {
    mocks.fetch.mockResolvedValue({ bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="p" d="M0 0h10v10z"/></defs><use href="#p"/></svg>') })
    const res = await run()
    expect(res.body.notIngested).toEqual([])
    expect(res.body.mappings[0]?.mime).toBe('image/svg+xml')
    expect(mocks.upload.mock.calls[0]![2].toString()).toContain('<use href="#p"')
  })
  it.each(['<use href="#missing"/>', '<use href="https://evil.invalid/a.svg#p"/>', '<use id="p" href="#p"/>'])('rejects unsafe SVG use before URL-ingestion storage: %s', async body => {
    mocks.fetch.mockResolvedValue({ bytes: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`) })
    const res = await run()
    expect(res.body.mappings).toEqual([])
    expect(res.body.notIngested[0]?.reason).toBe('unsupported_media_type')
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(mocks.register).not.toHaveBeenCalled()
  })
  it('accepts a real SVG with an XML declaration through the sanitizer', async () => {
    mocks.fetch.mockResolvedValue({ bytes: Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>') })
    expect((await run()).body.mappings[0]?.mime).toBe('image/svg+xml')
  })
  it('does not treat an arbitrary XML document as SVG', async () => {
    mocks.fetch.mockResolvedValue({ bytes: Buffer.from('<?xml version="1.0"?><config><secret>value</secret></config>') })
    expect((await run()).body.mappings).toEqual([])
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it.each(['<html>not a video</html>', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>', ''])('rejects forged or active content: %s', async (text) => {
    mocks.fetch.mockResolvedValue({ bytes: Buffer.from(text), declaredContentType: 'video/mp4' })
    const res = await run()
    expect(res.body.mappings).toEqual([])
    expect(res.body.notIngested[0]?.reason).toBe('unsupported_media_type')
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it('deduplicates identical URLs within a request', async () => {
    const res = await run([source, source])
    expect(res.body.mappings).toHaveLength(1)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })
  it('limits PPT batches without enlarging the ordinary image batch limit', async () => {
    const res = await run(Array.from({ length: 11 }, (_, i) => `${source}?i=${i}`))
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('urls_too_many')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it.each([[], [''], [null], 'url'])('rejects malformed input %j', async (urls) => {
    expect((await run(urls)).statusCode).toBe(400)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('does not fetch for a caller rejected by the shared writer guard', async () => {
    mocks.guard.mockImplementation(async (_req, res) => { res.status(403).json({ error: 'forbidden' }); return null })
    expect((await run()).statusCode).toBe(403)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('refuses an epoch change during fetch before writing storage', async () => {
    mocks.fetch.mockImplementation(async () => {
      mocks.guard.mockResolvedValue({ ...guard, meta: { ...guard.meta, permission_epoch: 4 } })
      return { bytes: MP4 }
    })
    expect((await run()).statusCode).toBe(403)
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it('cleans uploaded bytes if permissions change during upload', async () => {
    mocks.upload.mockImplementation(async () => {
      mocks.guard.mockResolvedValue({ ...guard, meta: { ...guard.meta, permission_epoch: 4 } })
    })
    expect((await run()).statusCode).toBe(403)
    expect(mocks.remove).toHaveBeenCalledTimes(1)
    expect(mocks.register).not.toHaveBeenCalled()
  })
  it('cleans both storage and any partially registered row on registration failure', async () => {
    mocks.register.mockRejectedValue(new Error('database unavailable'))
    const res = await run()
    expect(res.body.notIngested[0]?.reason).toBe('store_failed')
    expect(mocks.remove).toHaveBeenCalledTimes(1)
    expect(mocks.deleteRow).toHaveBeenCalledTimes(1)
  })
  it('keeps partial failures explicit instead of returning a broken ref', async () => {
    mocks.fetch.mockRejectedValueOnce(new LinkCardError('ssrf_blocked'))
    const res = await run(['http://127.0.0.1/private', source])
    expect(res.body.notIngested).toEqual([{ sourceUrl: 'http://127.0.0.1/private', reason: 'ssrf_blocked' }])
    expect(res.body.mappings).toHaveLength(1)
  })
  it('enforces the configured file cap even if the fetch implementation returns too many bytes', async () => {
    const old = config.attachments.maxFileSizeBytes
    config.attachments.maxFileSizeBytes = MP4.length - 1
    try {
      const res = await run()
      expect(res.body.notIngested[0]?.reason).toBe('size_too_large')
      expect(mocks.upload).not.toHaveBeenCalled()
    } finally { config.attachments.maxFileSizeBytes = old }
  })
  it('accepts exactly the configured media cap', async () => {
    const old = config.attachments.maxFileSizeBytes
    config.attachments.maxFileSizeBytes = MP4.length
    try { expect((await run()).body.mappings).toHaveLength(1) }
    finally { config.attachments.maxFileSizeBytes = old }
  })
  it('does not fetch another source after the successful-download batch budget is exhausted', async () => {
    const padded = Buffer.alloc(50 * 1024 * 1024)
    MP4.copy(padded)
    mocks.fetch.mockResolvedValue({ bytes: padded })
    const res = await run([source, `${source}?2`, `${source}?3`])
    expect(res.body.mappings).toHaveLength(2)
    expect(res.body.notIngested[0]?.reason).toBe('batch_size_too_large')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })
  it('rejects SVG over its separate one MiB sanitizer limit', async () => {
    mocks.fetch.mockResolvedValue({ bytes: Buffer.from(`<svg>${' '.repeat(1024 * 1024)}</svg>`) })
    expect((await run()).body.mappings).toEqual([])
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it('removes earlier receipts when the batch loses permission', async () => {
    mocks.fetch.mockImplementationOnce(async () => ({ bytes: MP4 }))
      .mockImplementationOnce(async () => {
        mocks.guard.mockImplementation(async (_req, res) => { res.status(403).json({ error: 'forbidden' }); return null })
        return { bytes: MP4 }
      })
    expect((await run([source, `${source}?2`])).statusCode).toBe(403)
    expect(mocks.remove).toHaveBeenCalledTimes(1)
    expect(mocks.deleteRow).toHaveBeenCalledTimes(1)
  })
  it('retains ordinary document image-only behavior for uploaded videos', async () => {
    mocks.guard.mockResolvedValue({ ...guard, meta: { ...guard.meta, doc_type: 'doc' } })
    const res = await run()
    expect(res.body.notIngested[0]?.reason).toBe('not_an_image')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})

// Real CLI + HTTP + production ingest/read code; auth, URL bytes and storage are
// test doubles. This is a transport contract test, not a deployed-environment test.
const cliBinary = process.env.PPT_TEST_CLI_BINARY
it.skipIf(!cliBinary)('uses the existing CLI api command to ingest and read native media, twice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-url-cli-'))
  const app = express()
  app.use(express.json())
  app.post('/v1/bot/docs/:docId/attachments/ingest', (req, res, next) => {
    req.uid = 'bot_contract'
    void ingestHandler(req, res).catch(next)
  })
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    const address = server.address() as { port: number }
    for (let round = 0; round < 2; round++) {
      const result = await promisify(execFile)(cliBinary!, [
        'api', 'POST', '/v1/bot/docs/d_ppt/attachments/ingest', '--no-retry', '--data', JSON.stringify({ urls: [source] }),
      ], {
        env: { PATH: process.env.PATH, OCTO_CONFIG_DIR: dir, OCTO_API_BASE_URL: `http://127.0.0.1:${address.port}`, OCTO_BOT_TOKEN: 'app_contract_test' },
        timeout: 20000,
      })
      const receipt = JSON.parse(result.stdout)
      expect(receipt.ok).toBe(true)
      expect(receipt.data.notIngested).toEqual([])
      expect(receipt.data.mappings[0].ref).toMatch(/^ppt-media:att_/)
      const row = mocks.register.mock.calls.at(-1)![0]
      mocks.get.mockResolvedValue(row)
      mocks.download.mockResolvedValue(mocks.upload.mock.calls.at(-1)![2])
      expect((await readPptMedia('d_ppt', row.attachId)).bytes).toEqual(MP4)
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
}, 45000)
