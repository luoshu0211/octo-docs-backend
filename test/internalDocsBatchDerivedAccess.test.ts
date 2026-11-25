import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

/**
 * P2-4 — status/capabilities derive the drive reader from the BATCH full-decision
 * endpoint (`POST /internal/v1/docs/derived-access/batch`, drive !93), at most 50
 * bindings per request, instead of one full decision per document. A 500-doc
 * status call must cost ≤10 Drive requests.
 *
 * The Drive client is stubbed: `batchDerivedAccess` counts bindings, the
 * per-doc `derivedAccess` records the fallback path. Repos are mocked; the
 * permission merge (direct + share + drive) is the real code.
 */
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    driveDerived: {
      inboundToken: 'drive-tok',
      outboundToken: 'drive-out',
      enabled: true,
      internalBaseUrl: 'http://drive.test',
      timeoutMs: 500,
      ttlMs: 1000,
    },
    driveInternalUrl: '',
    driveInternalToken: '',
  },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocIds: vi.fn(), getLegacyVisibleDocIds: vi.fn() },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { getRoles: vi.fn() },
  SOURCE_DIRECT: 1,
  SOURCE_INVITE: 2,
}))

import {
  internalDocCapabilitiesHandler,
  internalDocStatusHandler,
  __resetDriveBatchCircuitForTests,
} from '../src/api/routes/internalDocsLibrary.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import {
  setDriveDerivedAccess,
  type DerivedAccessBinding,
  type DerivedAccessDecision,
  type DerivedRole,
  type DriveDerivedAccess,
} from '../src/drive/derivedAccessClient.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(code: number): MockRes
  json(body: unknown): MockRes
}
function response(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}
function request(body: unknown, token = 'drive-tok') {
  return {
    body,
    header: (name: string) => (name.toLowerCase() === 'x-internal-token' ? token : undefined),
  }
}

function meta(docId: string) {
  return {
    doc_id: docId,
    title: `Doc ${docId}`,
    doc_type: 'doc',
    owner_id: 'owner',
    owner_space_id: 's1',
    space_id: 's1',
    status: 1,
    deleted_at: null,
    share_scope: 0,
    share_role: 1,
    updated_at: new Date('2026-11-20T01:02:03.000Z'),
  }
}

interface DriveStub {
  batches: DerivedAccessBinding[][]
  singles: string[]
}
function stubDrive(options: {
  batch?: (bindings: readonly DerivedAccessBinding[]) => DerivedAccessDecision[] | null | Promise<never>
  single?: (docId: string) => DerivedRole | null
} = {}): DriveStub {
  const stub: DriveStub = { batches: [], singles: [] }
  const impl: DriveDerivedAccess = {
    async derivedAccess(docId) {
      stub.singles.push(docId)
      const role = options.single?.(docId) ?? 'reader'
      if (role === null) return null
      return {
        docId, uid: 'u1', principalSpaceId: 's1', role,
        sourceRevision: `sha256:${'0'.repeat(64)}`, validForMs: 15_000, expiresAt: Number.POSITIVE_INFINITY,
      }
    },
    async versions() { return null },
    async batchDerivedAccess(bindings) {
      const copy = bindings.map((binding) => ({ ...binding }))
      stub.batches.push(copy)
      if (!options.batch) return bindings.map((binding) => ({ ...binding, role: 'reader' }))
      return options.batch(bindings)
    },
  }
  setDriveDerivedAccess(impl)
  return stub
}

let warnSpy: MockInstance

beforeEach(() => {
  vi.clearAllMocks()
  __resetDriveBatchCircuitForTests()
  mockConfig.driveDerived.inboundToken = 'drive-tok'
  vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([] as never)
  vi.mocked(docMetaRepo.getLegacyVisibleDocIds).mockResolvedValue(new Set() as never)
  vi.mocked(docMemberRepo.getRoles).mockResolvedValue(new Map() as never)
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

const DOC_IDS = (n: number) => Array.from({ length: n }, (_, i) => `d${i + 1}`)

describe('internal status/capabilities — batched drive derived access', () => {
  it('500 bindings cost exactly 10 batch requests of ≤50, no per-doc calls', async () => {
    const ids = DOC_IDS(500)
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue(ids.map(meta) as never)
    const drive = stubDrive()

    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ids }) as never,
      res as never,
    )

    expect(res.statusCode).toBe(200)
    expect((res.body as { items: unknown[] }).items).toHaveLength(500)
    expect(drive.batches).toHaveLength(10)
    for (const batch of drive.batches) expect(batch.length).toBeLessThanOrEqual(50)
    expect(drive.batches.every((batch) => batch.length === 50)).toBe(true)
    expect(drive.singles).toEqual([])
  })

  it.each([
    [49, [49]],
    [50, [50]],
    [51, [50, 1]],
  ])('%i docs are sliced into batches of ≤50 (%j)', async (count, expectedSizes) => {
    const ids = DOC_IDS(count)
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue(ids.map(meta) as never)
    const drive = stubDrive()

    const res = response()
    await internalDocCapabilitiesHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ids }) as never,
      res as never,
    )

    expect(res.statusCode).toBe(200)
    expect(drive.batches.map((batch) => batch.length)).toEqual(expectedSizes)
    expect((res.body as { items: unknown[] }).items).toHaveLength(count)
  })

  it('maps role=reader / role=none correctly (none is omitted, like the single path)', async () => {
    const ids = ['d1', 'd2']
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue(ids.map(meta) as never)
    stubDrive({
      batch: (bindings) => bindings.map((binding) => ({
        ...binding,
        role: binding.docId === 'd1' ? 'reader' : 'none',
      })),
    })

    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ids }) as never,
      res as never,
    )

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ items: [expect.objectContaining({ doc_id: 'd1', role: 'reader', can_read: true })] })
  })

  it('500 docs + batch failure: 10 batch requests, ZERO per-doc fallback, 30s circuit', async () => {
    const ids = DOC_IDS(500)
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue(ids.map(meta) as never)
    const drive = stubDrive({ batch: () => null })

    const first = response()
    await internalDocStatusHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ids }) as never,
      first as never,
    )
    expect(first.statusCode).toBe(200)
    expect((first.body as { items: unknown[] }).items).toEqual([]) // fail closed
    expect(drive.batches).toHaveLength(10)
    expect(drive.singles).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failing closed without per-doc fallback'),
      expect.objectContaining({ docs: 500 }),
    )

    // Circuit is open: the next page makes no Drive request at all.
    const second = response()
    await internalDocStatusHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ids }) as never,
      second as never,
    )
    expect((second.body as { items: unknown[] }).items).toEqual([])
    expect(drive.batches).toHaveLength(10)
    expect(drive.singles).toEqual([])
  })

  it('51 docs + batch failure also fails closed without per-doc fallback', async () => {
    const ids = DOC_IDS(51)
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue(ids.map(meta) as never)
    const drive = stubDrive({ batch: () => null })

    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ids }) as never,
      res as never,
    )
    expect((res.body as { items: unknown[] }).items).toEqual([])
    expect(drive.batches).toHaveLength(2) // 50 + 1 chunks; both attempted, then fail closed
    expect(drive.singles).toEqual([])
  })

  it('50 docs + batch failure still uses the bounded per-doc fallback', async () => {
    const ids = DOC_IDS(50)
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue(ids.map(meta) as never)
    const drive = stubDrive({ batch: () => null })

    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ids }) as never,
      res as never,
    )
    expect((res.body as { items: unknown[] }).items).toHaveLength(50)
    expect(drive.batches).toHaveLength(1)
    expect(drive.singles).toHaveLength(50)
  })

  it('batch unavailable falls back to the per-doc full decision (never widens access)', async () => {
    const ids = ['d1', 'd2', 'd3']
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue(ids.map(meta) as never)
    const drive = stubDrive({
      batch: () => null,
      single: (docId) => (docId === 'd2' ? 'none' : 'reader'),
    })

    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ids }) as never,
      res as never,
    )

    expect(res.statusCode).toBe(200)
    expect(drive.batches).toHaveLength(1) // one attempted batch, then fallback
    expect(drive.singles.sort()).toEqual(['d1', 'd2', 'd3'])
    expect((res.body as { items: Array<{ doc_id: string }> }).items.map((item) => item.doc_id).sort())
      .toEqual(['d1', 'd3'])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('batch unavailable'),
      expect.objectContaining({ docs: 3 }),
    )
  })

  it('a batch that throws also falls back instead of failing the request', async () => {
    const ids = ['d1']
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue(ids.map(meta) as never)
    const drive = stubDrive({
      batch: () => { throw new Error('protocol exploded') },
    })

    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ids }) as never,
      res as never,
    )

    expect(res.statusCode).toBe(200)
    expect(drive.singles).toEqual(['d1'])
    expect((res.body as { items: Array<{ doc_id: string; role: string }> }).items)
      .toEqual([expect.objectContaining({ doc_id: 'd1', role: 'reader' })])
  })

  it('does not call the batch endpoint for docs whose direct/share role already reads', async () => {
    const ids = ['d1']
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([
      { ...meta('d1'), owner_id: 'u1', owner_space_id: 's1' },
    ] as never)
    const drive = stubDrive()

    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ids }) as never,
      res as never,
    )

    expect(res.statusCode).toBe(200)
    expect(drive.batches).toEqual([])
    expect(drive.singles).toEqual([])
  })
})
