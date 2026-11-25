import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 §4.8 HTML rename journal — operation identity + concurrency ordering.
 *
 * The previous idempotency key was `sha256(docId\nbeforeTitle\ntitle)`, which
 * conflates a retry with a LATER rename that happens to have the same endpoints
 * (A→B→A→B would replay the first version while doc_meta still moved to B), and
 * it cannot serialize two different concurrent targets.
 *
 * These tests drive the real `renameHtmlDoc` service against an in-memory
 * transaction harness that implements the exact SQL it issues (doc_meta row
 * lock/read/rename + doc_rename_operation journal). `fetch` is stubbed; every
 * assertion is on observable state, not SQL text.
 */
const h = vi.hoisted(() => {
  type Doc = {
    doc_id: string
    title: string
    doc_type: string
    owner_id: string
    owner_space_id: string
    space_id: string
    status: number
    permission_epoch: number
  }
  type Op = {
    id: string
    revision: number
    doc_id: string
    from_title: string
    to_title: string
    status: number
    version: number | null
    created_at: Date
    updated_at: Date
  }
  const state = {
    docs: new Map<string, Doc>(),
    ops: [] as Op[],
    members: new Map<string, number>(),
    failDocMetaUpdate: false,
    failOpCompletion: false,
  }

  function execute(sql: string, args: unknown[] = []): unknown[] {
    const q = sql.replace(/\s+/g, ' ').trim()
    if (q.startsWith('SELECT * FROM doc_meta WHERE doc_id = ? FOR UPDATE')) {
      const doc = state.docs.get(String(args[0]))
      return doc ? [{ ...doc }] : []
    }
    if (q.startsWith('SELECT * FROM doc_meta WHERE doc_id = ?')) {
      const doc = state.docs.get(String(args[0]))
      return doc ? [{ ...doc }] : []
    }
    if (q.startsWith('UPDATE doc_meta SET title = ?, updated_by = ? WHERE doc_id = ?')) {
      if (state.failDocMetaUpdate) throw new Error('doc_meta update failed')
      const doc = state.docs.get(String(args[2]))
      if (doc) doc.title = String(args[0])
      return []
    }
    if (q.startsWith('SELECT * FROM doc_rename_operation WHERE doc_id = ? AND status = 2')) {
      const failed = state.ops
        .filter((op) => op.doc_id === String(args[0]) && op.status === 2)
        .sort((a, b) => b.revision - a.revision)
      return failed.length > 0 ? [{ ...failed[0]! }] : []
    }
    if (q.startsWith('SELECT * FROM doc_rename_operation WHERE doc_id = ? AND status = 0')) {
      const pending = state.ops
        .filter((op) => op.doc_id === String(args[0]) && op.status === 0)
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id))
      return pending.length > 0 ? [{ ...pending[0]! }] : []
    }
    if (q.startsWith('SELECT * FROM doc_rename_operation WHERE doc_id = ? AND status = 1 AND revision > ?')) {
      const newer = state.ops
        .filter((op) => op.doc_id === String(args[0]) && op.status === 1 && op.revision > Number(args[1]))
        .sort((a, b) => b.revision - a.revision)
      return newer.length > 0 ? [{ ...newer[0]! }] : []
    }
    if (q.startsWith('SELECT * FROM doc_rename_operation WHERE id = ?')) {
      const op = state.ops.find((candidate) => candidate.id === String(args[0]))
      return op ? [{ ...op }] : []
    }
    if (q.startsWith('INSERT INTO doc_rename_operation')) {
      const now = new Date()
      const revision = state.ops.reduce((max, op) => Math.max(max, op.revision), 0) + 1
      state.ops.push({
        id: String(args[0]),
        revision,
        doc_id: String(args[1]),
        from_title: String(args[2]),
        to_title: String(args[3]),
        status: 0,
        version: null,
        created_at: now,
        updated_at: now,
      })
      return []
    }
    if (q.startsWith('UPDATE doc_rename_operation SET updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 0')) {
      const op = state.ops.find((candidate) => candidate.id === String(args[0]))
      if (op && op.status === 0) op.updated_at = new Date()
      return []
    }
    if (q.startsWith('UPDATE doc_rename_operation SET status = 0, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 2')) {
      const op = state.ops.find((candidate) => candidate.id === String(args[0]))
      if (op && op.status === 2) {
        op.status = 0
        op.updated_at = new Date()
      }
      return []
    }
    if (q.startsWith('UPDATE doc_rename_operation SET status = 2, version = ? WHERE id = ? AND status = 0')) {
      const op = state.ops.find((candidate) => candidate.id === String(args[1]))
      if (op && op.status === 0) {
        op.status = 2
        op.version = args[0] === null ? null : Number(args[0])
        op.updated_at = new Date()
      }
      return []
    }
    if (q.startsWith('UPDATE doc_rename_operation SET status = 2 WHERE id = ? AND status = 0')) {
      const op = state.ops.find((candidate) => candidate.id === String(args[0]))
      if (op && op.status === 0) {
        op.status = 2
        op.updated_at = new Date()
      }
      return []
    }
    if (q.startsWith('UPDATE doc_rename_operation SET status = 1, version = ? WHERE id = ? AND status = 0')) {
      if (state.failOpCompletion) throw new Error('journal completion failed')
      const op = state.ops.find((candidate) => candidate.id === String(args[1]))
      if (op && op.status === 0) {
        op.status = 1
        op.version = args[0] === null ? null : Number(args[0])
        op.updated_at = new Date()
      }
      return []
    }
    if (q.startsWith('SELECT role FROM doc_member WHERE doc_id = ? AND uid = ? AND principal_space_id = ?')) {
      const role = state.members.get(`${args[1]}@${args[2]}`)
      return role === undefined ? [] : [{ role }]
    }
    throw new Error(`unexpected SQL: ${q}`)
  }

  function tx() {
    return { query: async (sql: string, args?: unknown[]) => execute(sql, args) }
  }

  function snapshot() {
    return {
      // DEEP copy of each Doc: a shallow Map copy would keep the same mutable
      // row objects, so a rollback after a partial write (title updated, journal
      // completion failed) would "restore" the already-mutated title.
      docs: new Map([...state.docs].map(([id, doc]) => [id, { ...doc }])),
      ops: state.ops.map((op) => ({ ...op })),
      members: new Map(state.members),
    }
  }

  return { state, tx, snapshot }
})

vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async (sql: string, args?: unknown[]) => h.tx().query(sql, args)),
  transaction: vi.fn(async (fn: (tx: ReturnType<typeof h.tx>) => Promise<unknown>) => {
    const before = h.snapshot()
    try {
      return await fn(h.tx())
    } catch (error) {
      h.state.docs = new Map(before.docs)
      h.state.ops = before.ops
      h.state.members = new Map(before.members)
      throw error
    }
  }),
}))
vi.mock('../src/config/env.js', () => ({
  config: {
    htmlInternal: { url: 'http://octo-docs-html.test:8080', token: 'html-token', timeoutMs: 5000 },
    search: { indexEnabled: false },
  },
}))

import { renameHtmlDoc, RENAME_OPERATION_PENDING_TTL_MS } from '../src/api/services/htmlRenameDoc.js'
import { isStaleRevisionPayload } from '../src/api/services/htmlTitleRepublish.js'
import { docRenameOperationRepo } from '../src/db/repos/docRenameOperationRepo.js'

function upstream(version: number, req: { slug?: unknown; title?: unknown } = {}): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ slug: req.slug ?? 'html_slug_1', version, title: req.title ?? 'ignored' }),
    text: async () => '',
  } as unknown as Response
}

let versionCounter = 0
let fetchMock: ReturnType<typeof vi.fn>
let closeCalls: Array<Record<string, unknown>> = []
let closeResponse: () => Response = () => closeOk()

function staleRevision(): Response {
  const body = { error: 'stale_revision' }
  return {
    ok: false,
    status: 409,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

/** The real html 409 body: nested service-error envelope with details.code. */
function staleEnvelope(): Response {
  const body = {
    error: {
      code: 'stale_revision',
      message: 'revision is not newer than max published revision',
      details: { code: 'stale_revision' },
    },
  }
  return {
    ok: false,
    status: 409,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function closeOk(): Response {
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
}

/**
 * Route the service's receipt-close call to a separate mock so republish mocks
 * (and their call counts/versions) stay unchanged.
 */
function setRepublish(mock: ReturnType<typeof vi.fn>): void {
  fetchMock = mock
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (String(url).endsWith('/internal/html/republish-title/close')) {
      closeCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Promise.resolve(closeResponse())
    }
    return mock(url, init)
  }))
}

function newFetch(): ReturnType<typeof vi.fn> {
  versionCounter = 1
  // Emulate octo-docs-html: same (slug, idempotency_key) replays the version
  // published by the first call; a new key publishes v+1.
  const versions = new Map<string, number>()
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { idempotency_key: string; slug: string; title: string }
    if (!versions.has(body.idempotency_key)) versions.set(body.idempotency_key, ++versionCounter)
    // Echo the request's slug/title: the service now validates them strictly.
    return upstream(versions.get(body.idempotency_key)!, body)
  })
}

function sentBodies(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>)
}

function input(title: string, overrides: Partial<Parameters<typeof renameHtmlDoc>[0]> = {}) {
  return {
    docId: 'd1',
    docSpaceId: 's1',
    uid: 'author',
    principalSpaceId: 's1',
    mode: 'human',
    expectedEpoch: 3,
    slug: 'html_slug_1',
    title,
    ...overrides,
  }
}

function seedDoc(title: string, overrides: Record<string, unknown> = {}) {
  h.state.docs.set('d1', {
    doc_id: 'd1',
    title,
    doc_type: 'html',
    owner_id: 'author',
    owner_space_id: 's1',
    space_id: 's1',
    status: 1,
    permission_epoch: 3,
    ...overrides,
  })
}

beforeEach(() => {
  h.state.docs = new Map()
  h.state.ops = []
  h.state.members = new Map()
  h.state.failDocMetaUpdate = false
  h.state.failOpCompletion = false
  closeCalls = []
  closeResponse = () => closeOk()
  fetchMock = newFetch()
  setRepublish(fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('HTML rename journal — operation identity', () => {
  it('retries a failed local doc_meta write with the SAME op id and then completes', async () => {
    seedDoc('A')
    h.state.failDocMetaUpdate = true

    const first = await renameHtmlDoc(input('B'))
    expect(first).toMatchObject({ ok: false, status: 503, error: 'rename_failed' })
    expect(h.state.docs.get('d1')!.title).toBe('A')
    expect(h.state.ops).toHaveLength(1)
    const opId = h.state.ops[0]!.id
    expect(h.state.ops[0]!.status).toBe(0)

    h.state.failDocMetaUpdate = false
    const second = await renameHtmlDoc(input('B'))

    expect(second).toMatchObject({ ok: true, alreadyApplied: false, beforeTitle: 'A', version: 2 })
    expect(h.state.docs.get('d1')!.title).toBe('B')
    expect(h.state.ops).toHaveLength(1)
    expect(h.state.ops[0]!).toMatchObject({ status: 1, version: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const bodies = sentBodies()
    expect(bodies[0]!.idempotency_key).toBe(opId)
    expect(bodies[1]!.idempotency_key).toBe(opId)
  })

  it('a lost html response is retried with the same key and converges', async () => {
    seedDoc('A')
    fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(upstream(2, { title: 'B' }))
    setRepublish(fetchMock)

    const first = await renameHtmlDoc(input('B'))
    expect(first).toMatchObject({ ok: false, status: 503, error: 'rename_failed' })
    expect(h.state.docs.get('d1')!.title).toBe('A')

    const second = await renameHtmlDoc(input('B'))
    expect(second).toMatchObject({ ok: true, version: 2 })
    expect(h.state.docs.get('d1')!.title).toBe('B')
    const bodies = sentBodies()
    expect(bodies).toHaveLength(2)
    expect(bodies[0]!.idempotency_key).toBe(bodies[1]!.idempotency_key)
    expect(bodies[0]!.idempotency_key).toBe(h.state.ops[0]!.id)
  })

  it('requesting the current title returns 200 without publishing or creating an operation', async () => {
    seedDoc('B')
    const result = await renameHtmlDoc(input('B'))
    expect(result).toMatchObject({ ok: true, alreadyApplied: true, beforeTitle: 'B' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.state.ops).toEqual([])
  })

  it('reuses the same pending op after the TTL for the SAME rename (no duplicate version)', async () => {
    seedDoc('A')
    const stale = new Date(Date.now() - RENAME_OPERATION_PENDING_TTL_MS - 60_000)
    // Simulates: html already published v2 under op-old, then the local write
    // failed and the row stayed pending for >10 minutes.
    h.state.ops.push({
      id: 'op-old',
      revision: 1,
      doc_id: 'd1',
      from_title: 'A',
      to_title: 'B',
      status: 0,
      version: null,
      created_at: stale,
      updated_at: stale,
    })
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((JSON.parse(String(init?.body)) as { idempotency_key: string }).idempotency_key).toBe('op-old')
      return upstream(2, { title: 'B' })
    })
    setRepublish(fetchMock)

    const result = await renameHtmlDoc(input('B'))

    expect(result).toMatchObject({ ok: true, beforeTitle: 'A', version: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(h.state.ops).toHaveLength(1)
    expect(h.state.ops[0]!).toMatchObject({ id: 'op-old', status: 1, version: 2 })
    expect(h.state.docs.get('d1')!.title).toBe('B')
  })

  it('A→B→A→B produces four distinct keys and four real versions', async () => {
    seedDoc('A')
    let call = 0
    const versions = [2, 3, 4, 5]
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      upstream(versions[call++]!, JSON.parse(String(init?.body))))
    setRepublish(fetchMock)

    const targets = ['B', 'A', 'B', 'A']
    const titles: string[] = []
    for (const target of targets) {
      const result = await renameHtmlDoc(input(target))
      expect(result.ok).toBe(true)
      titles.push(h.state.docs.get('d1')!.title)
    }

    expect(titles).toEqual(['B', 'A', 'B', 'A'])
    const bodies = sentBodies()
    expect(bodies).toHaveLength(4)
    const keys = bodies.map((body) => body.idempotency_key)
    expect(new Set(keys).size).toBe(4)
    expect(keys).toEqual(h.state.ops.map((op) => op.id))
    expect(h.state.ops.map((op) => op.version)).toEqual([2, 3, 4, 5])
    expect(h.state.ops.every((op) => op.status === 1)).toBe(true)
  })
  it('a pending operation blocks the "already at target" shortcut (P1-1)', async () => {
    seedDoc('A')
    // A→B already published remotely but failed locally: doc_meta is still A.
    h.state.ops.push({
      id: 'op-ab',
      revision: 1,
      doc_id: 'd1',
      from_title: 'A',
      to_title: 'B',
      status: 0,
      version: null,
      created_at: new Date(),
      updated_at: new Date(),
    })

    const blocked = await renameHtmlDoc(input('A'))
    expect(blocked).toMatchObject({ ok: false, status: 409, error: 'rename_in_progress' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.state.ops[0]!.status).toBe(0)

    // Retrying the unfinished A→B still resumes the SAME op and version.
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      upstream(2, JSON.parse(String(init?.body))))
    setRepublish(fetchMock)
    const resumed = await renameHtmlDoc(input('B'))
    expect(resumed).toMatchObject({ ok: true, beforeTitle: 'A', version: 2 })
    expect((JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as { idempotency_key: string }).idempotency_key)
      .toBe('op-ab')
    expect(h.state.docs.get('d1')!.title).toBe('B')
  })

  it('rejects when the epoch changes during the html publish (human mode, P1-2)', async () => {
    seedDoc('A')
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      h.state.docs.get('d1')!.permission_epoch = 4
      return upstream(2, JSON.parse(String(init?.body)))
    })
    setRepublish(fetchMock)

    const result = await renameHtmlDoc(input('B'))
    expect(result).toMatchObject({ ok: false, status: 409, error: 'title_changed' })
    expect(h.state.docs.get('d1')!.title).toBe('A')
    expect(h.state.ops[0]!.status).toBe(2)
  })

  it('rejects when the rename grant is revoked during the html publish (human mode, P1-2)', async () => {
    seedDoc('A') // owner is 'author'
    h.state.members.set('u1@s1', 3) // admin at prepare time
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      h.state.members.set('u1@s1', 1) // downgraded to reader during publish
      return upstream(2, JSON.parse(String(init?.body)))
    })
    setRepublish(fetchMock)

    const result = await renameHtmlDoc(input('B', { uid: 'u1', principalSpaceId: 's1' }))
    expect(result).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(h.state.docs.get('d1')!.title).toBe('A')
    expect(h.state.ops[0]!.status).toBe(2)
    expect(h.state.ops[0]!.version).toBe(2)
  })

  it('prepare fences BEFORE publishing when the grant is already gone (P1-3)', async () => {
    seedDoc('A')
    h.state.members.set('u1@s1', 1) // reader, not the html author
    const result = await renameHtmlDoc(input('B', { uid: 'u1', principalSpaceId: 's1' }))
    expect(result).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.state.ops).toEqual([])
  })

  it('recovers a half-success after the epoch changes: same op id/version, then completes (P1-3)', async () => {
    seedDoc('A')
    let first = true
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (first) {
        first = false
        h.state.docs.get('d1')!.permission_epoch = 4
      }
      return upstream(2, JSON.parse(String(init?.body)))
    })
    setRepublish(fetchMock)

    const blocked = await renameHtmlDoc(input('B'))
    expect(blocked).toMatchObject({ ok: false, status: 409, error: 'title_changed' })
    expect(h.state.docs.get('d1')!.title).toBe('A')
    expect(h.state.ops).toHaveLength(1)
    const opId = h.state.ops[0]!.id
    expect(h.state.ops[0]!).toMatchObject({ status: 2, version: 2 })

    h.state.docs.get('d1')!.permission_epoch = 3
    const retry = await renameHtmlDoc(input('B'))
    expect(retry).toMatchObject({ ok: true, beforeTitle: 'A', version: 2 })
    expect(h.state.docs.get('d1')!.title).toBe('B')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      expect((JSON.parse(String((call[1] as RequestInit).body)) as { idempotency_key: string }).idempotency_key)
        .toBe(opId)
    }
    expect(h.state.ops).toHaveLength(1)
    expect(h.state.ops[0]!).toMatchObject({ status: 1, version: 2 })
  })

  it('recovers a half-success after a grant downgrade, and stays 409 until access returns (P1-3)', async () => {
    seedDoc('A')
    h.state.members.set('u1@s1', 3)
    let first = true
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (first) {
        first = false
        h.state.members.set('u1@s1', 1)
      }
      return upstream(2, JSON.parse(String(init?.body)))
    })
    setRepublish(fetchMock)

    const blocked = await renameHtmlDoc(input('B', { uid: 'u1', principalSpaceId: 's1' }))
    expect(blocked).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(h.state.ops[0]!).toMatchObject({ status: 2, version: 2 })

    // Permission still missing: prepare refuses before publishing again.
    const stillBlocked = await renameHtmlDoc(input('B', { uid: 'u1', principalSpaceId: 's1' }))
    expect(stillBlocked).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    h.state.members.set('u1@s1', 3)
    const retry = await renameHtmlDoc(input('B', { uid: 'u1', principalSpaceId: 's1' }))
    expect(retry).toMatchObject({ ok: true, beforeTitle: 'A', version: 2 })
    expect(h.state.docs.get('d1')!.title).toBe('B')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(h.state.ops[0]!).toMatchObject({ status: 1, version: 2 })
  })

  it('does not resume a failed op superseded by a newer completed rename (P1-3)', async () => {
    seedDoc('A')
    h.state.ops.push({
      id: 'op-failed', revision: 1, doc_id: 'd1', from_title: 'A', to_title: 'B',
      status: 2, version: 2, created_at: new Date(Date.now() - 2000), updated_at: new Date(Date.now() - 2000),
    })
    h.state.ops.push({
      id: 'op-newer', revision: 2, doc_id: 'd1', from_title: 'X', to_title: 'Y',
      status: 1, version: 5, created_at: new Date(Date.now() - 1000), updated_at: new Date(Date.now() - 1000),
    })
    // Current local title is still A (contrived ABA), but op-failed is stale.
    const result = await renameHtmlDoc(input('B'))
    expect(result).toMatchObject({ ok: true, version: 2 })
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as { idempotency_key: string }
    expect(body.idempotency_key).not.toBe('op-failed')
    expect(h.state.ops.filter((op) => op.to_title === 'B')).toHaveLength(2)
  })

  it.each([
    ['201 status', 201, { slug: 'html_slug_1', title: 'B', version: 2 }],
    ['slug mismatch', 200, { slug: 'other_slug', title: 'B', version: 2 }],
    ['title mismatch', 200, { slug: 'html_slug_1', title: 'C', version: 2 }],
    ['zero version', 200, { slug: 'html_slug_1', title: 'B', version: 0 }],
    ['string version', 200, { slug: 'html_slug_1', title: 'B', version: '2' }],
    ['array body', 200, [{ slug: 'html_slug_1', title: 'B', version: 2 }]],
  ])('rejects a malformed html response (%s) with 503 and keeps the op pending (P2-2)', async (
    _name, status, payload,
  ) => {
    seedDoc('A')
    fetchMock = vi.fn(async () => ({
      ok: status === 200,
      status,
      json: async () => payload,
      text: async () => '',
    }) as unknown as Response)
    setRepublish(fetchMock)

    const result = await renameHtmlDoc(input('B'))
    expect(result).toMatchObject({ ok: false, status: 503, error: 'rename_failed' })
    expect(h.state.docs.get('d1')!.title).toBe('A')
    expect(h.state.ops).toHaveLength(1)
    expect(h.state.ops[0]!.status).toBe(0)
  })

  it('rolls the doc title back when journal completion fails after the write (P2-5 harness)', async () => {
    seedDoc('A')
    h.state.failOpCompletion = true

    const result = await renameHtmlDoc(input('B'))
    expect(result).toMatchObject({ ok: false, status: 503, error: 'rename_failed' })
    // Shallow-copy snapshots would leave this at 'B'.
    expect(h.state.docs.get('d1')!.title).toBe('A')
    expect(h.state.ops[0]!.status).toBe(0)
  })
  it('refuses A→A while a failed publish left the remote on B, then recovers B (P1)', async () => {
    seedDoc('A')
    h.state.ops.push({
      id: 'op-failed-ab',
      revision: 1,
      doc_id: 'd1',
      from_title: 'A',
      to_title: 'B',
      status: 2,
      version: 2,
      created_at: new Date(),
      updated_at: new Date(),
    })

    const blocked = await renameHtmlDoc(input('A'))
    expect(blocked).toMatchObject({
      ok: false,
      status: 409,
      error: 'rename_recovery_required',
      pendingTitle: 'B',
      version: 2,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(closeCalls).toEqual([]) // failed-but-resumable keeps its receipt
    expect(h.state.docs.get('d1')!.title).toBe('A')

    const resumed = await renameHtmlDoc(input('B'))
    expect(resumed).toMatchObject({ ok: true, beforeTitle: 'A', version: 2 })
    expect((JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as { idempotency_key: string }).idempotency_key)
      .toBe('op-failed-ab')
    expect(h.state.docs.get('d1')!.title).toBe('B')
    // Terminal completion closes the replay receipt exactly once.
    expect(closeCalls).toEqual([{
      slug: 'html_slug_1', doc_id: 'd1', space_id: 's1', idempotency_key: 'op-failed-ab',
    }])
  })

  it('a failed op superseded by a newer completed rename does not block A→A (P1)', async () => {
    seedDoc('A')
    h.state.ops.push({
      id: 'op-failed', revision: 1, doc_id: 'd1', from_title: 'A', to_title: 'B',
      status: 2, version: 2, created_at: new Date(Date.now() - 2000), updated_at: new Date(),
    })
    h.state.ops.push({
      id: 'op-newer', revision: 2, doc_id: 'd1', from_title: 'A', to_title: 'C',
      status: 1, version: 5, created_at: new Date(Date.now() - 1000), updated_at: new Date(),
    })

    const result = await renameHtmlDoc(input('A'))
    expect(result).toMatchObject({ ok: true, alreadyApplied: true, title: 'A' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(closeCalls).toEqual([])
  })

  it('allows the html author in the SAME Space (compound author identity)', async () => {
    seedDoc('A') // owner_id 'author', owner_space_id 's1'
    const result = await renameHtmlDoc(input('B', { uid: 'author', principalSpaceId: 's1' }))

    expect(result).toMatchObject({ ok: true, beforeTitle: 'A', version: 2 })
    expect(h.state.docs.get('d1')!.title).toBe('B')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(closeCalls).toHaveLength(1)
  })

  it('refuses the author UID from ANOTHER principal Space without a member row', async () => {
    seedDoc('A') // owner Space s1, caller principal Space s2
    const result = await renameHtmlDoc(input('B', { uid: 'author', principalSpaceId: 's2' }))

    expect(result).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(h.state.docs.get('d1')!.title).toBe('A')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.state.ops).toEqual([])
  })

  it('CLI mode also refuses the cross-Space author UID', async () => {
    seedDoc('A')
    const result = await renameHtmlDoc(input('B', {
      uid: 'author', principalSpaceId: 's2', mode: 'cli',
    }))

    expect(result).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(h.state.docs.get('d1')!.title).toBe('A')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a NON-author reader still cannot rename (human mode)', async () => {
    seedDoc('A')
    h.state.members.set('reader@s1', 1)
    const result = await renameHtmlDoc(input('B', { uid: 'reader', principalSpaceId: 's1' }))
    expect(result).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.state.ops).toEqual([])
  })

  it('deleted docs still fail closed with 409 doc_archived before publishing', async () => {
    seedDoc('A', { status: 0 })
    const result = await renameHtmlDoc(input('B'))
    expect(result).toMatchObject({ ok: false, status: 409, error: 'doc_archived' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.state.ops).toEqual([])
  })

  it('sends the journal revision and a newer op gets a higher fence value', async () => {
    seedDoc('A')
    expect(await renameHtmlDoc(input('B'))).toMatchObject({ ok: true, version: 2 })
    expect(await renameHtmlDoc(input('A'))).toMatchObject({ ok: true, version: 3 })

    const bodies = sentBodies()
    expect(bodies.map((body) => body.revision)).toEqual([1, 2])
    expect(h.state.ops.map((op) => op.revision)).toEqual([1, 2])
  })

  it('a late publish whose op already completed replays success (200), even after a later rename moved the doc', async () => {
    seedDoc('A')
    const waiters: Array<{ resolve: (res: Response) => void; body: Record<string, unknown> }> = []
    fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve) => {
      waiters.push({ resolve, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    }))
    setRepublish(fetchMock)

    // R1: A→B (op1, revision 1) parked before html answers.
    const delayed = renameHtmlDoc(input('B'))
    await vi.waitFor(() => expect(waiters).toHaveLength(1))
    // Duplicate commits op1 → v2 and closes its receipt.
    const duplicate = renameHtmlDoc(input('B'))
    await vi.waitFor(() => expect(waiters).toHaveLength(2))
    waiters[1]!.resolve(upstream(2, waiters[1]!.body))
    expect(await duplicate).toMatchObject({ ok: true, version: 2 })
    // B→A (op2, revision 2) completes → v3.
    const back = renameHtmlDoc(input('A'))
    await vi.waitFor(() => expect(waiters).toHaveLength(3))
    waiters[2]!.resolve(upstream(3, waiters[2]!.body))
    expect(await back).toMatchObject({ ok: true, version: 3 })
    expect(h.state.docs.get('d1')!.title).toBe('A')

    // Release the stale op1 publish: html's monotonic fence rejects it because
    // the duplicate already closed op1's receipt. The journal row is COMPLETED,
    // so this is a successful duplicate — replay 200, never markFailed/409.
    waiters[0]!.resolve(staleRevision())
    const result = await delayed

    expect(result).toMatchObject({
      ok: true, alreadyApplied: true, title: 'A', beforeTitle: 'A', version: 2,
    })
    expect(h.state.docs.get('d1')!.title).toBe('A')
    expect(sentBodies().map((body) => body.revision)).toEqual([1, 1, 2])
    // No third version was published and the replay does not touch receipts.
    expect(h.state.ops.every((op) => op.status === 1)).toBe(true)
    expect(closeCalls.map((call) => call.idempotency_key).sort())
      .toEqual([h.state.ops[0]!.id, h.state.ops[1]!.id].sort())
  })

  it('a stale_revision on a pending op with NO later local commit is retryable, not rename_superseded', async () => {
    seedDoc('A')
    fetchMock = vi.fn(async () => staleRevision())
    setRepublish(fetchMock)

    const result = await renameHtmlDoc(input('B'))
    // The fence proves html is ahead, but nothing locally superseded this op.
    // Fail it (so the retry mints a fresh, higher revision) and answer 503 —
    // only a PROVEN later completed rename answers 409 rename_superseded.
    expect(result).toMatchObject({ ok: false, status: 503, error: 'rename_failed' })
    expect(h.state.docs.get('d1')!.title).toBe('A')
    expect(h.state.ops[0]!.status).toBe(2)
    expect(closeCalls).toEqual([])
  })

  it('a late stale_revision replays a COMPLETED journal op as success (200), not 409', async () => {
    seedDoc('A')
    const waiters: Array<{ resolve: (res: Response) => void }> = []
    fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve) => {
      waiters.push({ resolve })
      expect(JSON.parse(String(init?.body))).toMatchObject({ doc_id: 'd1', space_id: 's1' })
    }))
    setRepublish(fetchMock)

    // Two in-flight requests share the same logical rename/revision: the second
    // prepare reuses the pending operation id.
    const delayed = renameHtmlDoc(input('B'))
    await vi.waitFor(() => expect(waiters).toHaveLength(1))
    const duplicate = renameHtmlDoc(input('B'))
    await vi.waitFor(() => expect(waiters).toHaveLength(2))
    const opId = h.state.ops[0]!.id
    expect(h.state.ops).toHaveLength(1)

    // The duplicate wins first: v2 commits and the receipt is closed.
    waiters[1]!.resolve(upstream(2, { title: 'B' }))
    expect(await duplicate).toMatchObject({ ok: true, alreadyApplied: false, version: 2 })
    expect(h.state.ops[0]).toMatchObject({ id: opId, status: 1, version: 2 })
    expect(closeCalls).toHaveLength(1)

    // The delayed request now reaches html after the receipt close and gets the
    // monotonic fence. The journal row is COMPLETED, so this is a successful
    // duplicate: replay 200 with the committed version, never markFailed/409.
    waiters[0]!.resolve(staleRevision())
    const replayed = await delayed

    expect(replayed).toMatchObject({
      ok: true, alreadyApplied: true, title: 'B', beforeTitle: 'A', version: 2,
    })
    expect(h.state.ops[0]).toMatchObject({ id: opId, status: 1, version: 2 })
    expect(h.state.docs.get('d1')!.title).toBe('B')
    // Replay does not drop the already-closed receipt again.
    expect(closeCalls).toHaveLength(1)
    expect(sentBodies().map((body) => body.revision)).toEqual([1, 1])
  })

  it('maps html 409 identity_mismatch / identity_unverified to a 409, not a 503', async () => {
    for (const code of ['identity_mismatch', 'identity_unverified'] as const) {
      h.state.ops = []
      seedDoc('A')
      const payload = { error: { code, message: 'binding refused', details: { code } } }
      fetchMock = vi.fn(async () => ({
        ok: false, status: 409, json: async () => payload, text: async () => JSON.stringify(payload),
      }) as unknown as Response)
      setRepublish(fetchMock)

      const result = await renameHtmlDoc(input('B'))
      expect(result).toMatchObject({ ok: false, status: 409, error: code })
      expect(h.state.docs.get('d1')!.title).toBe('A')
      // Definitive binding refusal: the op is terminal and no receipt is closed.
      expect(h.state.ops[0]!.status).toBe(2)
      expect(closeCalls).toEqual([])
    }
  })

  it('expected_title mismatch under the prepare lock answers 409 title_changed + currentTitle without publishing', async () => {
    seedDoc('A')
    const result = await renameHtmlDoc(input('B', { expectedTitle: 'Stale' }))
    expect(result).toMatchObject({
      ok: false, status: 409, error: 'title_changed', currentTitle: 'A',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.state.docs.get('d1')!.title).toBe('A')
    expect(h.state.ops).toEqual([])
  })

  it('two requests that both expect A: exactly one wins, the other gets 409 title_changed', async () => {
    seedDoc('A')
    const first = await renameHtmlDoc(input('B', { expectedTitle: 'A' }))
    expect(first).toMatchObject({ ok: true, title: 'B' })
    const second = await renameHtmlDoc(input('C', { expectedTitle: 'A' }))
    expect(second).toMatchObject({
      ok: false, status: 409, error: 'title_changed', currentTitle: 'B',
    })
    expect(h.state.docs.get('d1')!.title).toBe('B')
    expect(h.state.ops).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('parses the REAL nested stale_revision envelope and does not block later renames', async () => {
    seedDoc('A')
    fetchMock = vi.fn()
      .mockResolvedValueOnce(staleEnvelope())
      .mockImplementationOnce(async (_url: string, init?: RequestInit) =>
        upstream(2, JSON.parse(String(init?.body))))
    setRepublish(fetchMock)

    const failed = await renameHtmlDoc(input('B'))
    expect(failed).toMatchObject({ ok: false, status: 503, error: 'rename_failed' })
    expect(h.state.docs.get('d1')!.title).toBe('A')
    expect(h.state.ops[0]!.status).toBe(2)
    expect(closeCalls).toEqual([])

    // The stale op must not leave a pending row behind: the next rename works
    // under a FRESH operation (higher revision) and closes only its own receipt.
    const next = await renameHtmlDoc(input('C'))
    expect(next).toMatchObject({ ok: true, beforeTitle: 'A', version: 2 })
    expect(h.state.docs.get('d1')!.title).toBe('C')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(closeCalls).toHaveLength(1)
  })

  it.each([
    ['nested details envelope', { error: { code: 'stale_revision', details: { code: 'stale_revision' } } }],
    ['nested error.code', { error: { code: 'stale_revision' } }],
    ['top-level error string', { error: 'stale_revision' }],
    ['top-level code string', { code: 'stale_revision' }],
  ])('recognizes %s as stale_revision', (_label, payload) => {
    expect(isStaleRevisionPayload(payload)).toBe(true)
  })

  it('does not treat an unrelated 409 envelope as stale_revision', () => {
    expect(isStaleRevisionPayload({ error: { code: 'forbidden', details: { code: 'forbidden' } } })).toBe(false)
    expect(isStaleRevisionPayload({ error: 'conflict' })).toBe(false)
    expect(isStaleRevisionPayload(null)).toBe(false)
  })

  it.each([400, 404, 500, 503])('an html %i response is retryable and leaves the op pending', async (status) => {
    seedDoc('A')
    fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status,
        json: async () => ({ error: { code: 'unavailable' } }),
        text: async () => JSON.stringify({ error: { code: 'unavailable' } }),
      } as unknown as Response)
      .mockImplementationOnce(async (_url: string, init?: RequestInit) =>
        upstream(2, JSON.parse(String(init?.body))))
    setRepublish(fetchMock)

    const first = await renameHtmlDoc(input('B'))
    expect(first).toMatchObject({ ok: false, status: 503, error: 'rename_failed' })
    expect(h.state.docs.get('d1')!.title).toBe('A')
    expect(h.state.ops[0]!.status).toBe(0)
    expect(closeCalls).toEqual([])

    const retry = await renameHtmlDoc(input('B'))
    expect(retry).toMatchObject({ ok: true, version: 2 })
    expect(h.state.docs.get('d1')!.title).toBe('B')
    expect((JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)) as { idempotency_key: string }).idempotency_key)
      .toBe(h.state.ops[0]!.id)
  })

  it('a timeout/abort during republish is retryable and keeps the op pending', async () => {
    seedDoc('A')
    fetchMock = vi.fn(async () => {
      const error = new Error('This operation was aborted')
      error.name = 'AbortError'
      throw error
    })
    setRepublish(fetchMock)

    const result = await renameHtmlDoc(input('B'))
    expect(result).toMatchObject({ ok: false, status: 503, error: 'rename_failed' })
    expect(h.state.docs.get('d1')!.title).toBe('A')
    expect(h.state.ops[0]!.status).toBe(0)
    expect(closeCalls).toEqual([])
  })

  it('closes the receipt once after a completed rename, with the op id as key', async () => {
    seedDoc('A')
    const result = await renameHtmlDoc(input('B'))
    expect(result).toMatchObject({ ok: true, version: 2 })
    const opId = h.state.ops[0]!.id
    expect(closeCalls).toEqual([{
      slug: 'html_slug_1', doc_id: 'd1', space_id: 's1', idempotency_key: opId,
    }])
  })

  it('a failing receipt close only warns and never changes the rename result', async () => {
    seedDoc('A')
    closeResponse = () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' }) as unknown as Response

    const result = await renameHtmlDoc(input('B'))
    expect(result).toMatchObject({ ok: true, version: 2 })
    expect(h.state.docs.get('d1')!.title).toBe('B')
    expect(closeCalls).toHaveLength(1)
  })

  it('does not close the receipt while the operation is still pending', async () => {
    seedDoc('A')
    fetchMock = vi.fn(async () => { throw new Error('socket hang up') })
    setRepublish(fetchMock)

    const result = await renameHtmlDoc(input('B'))
    expect(result).toMatchObject({ ok: false, status: 503, error: 'rename_failed' })
    expect(closeCalls).toEqual([])
    expect(h.state.ops[0]!.status).toBe(0)
  })
})

describe('HTML rename journal — concurrency ordering', () => {
  it('rejects a different target while another rename is pending, then succeeds after it finishes', async () => {
    seedDoc('A')
    // Another request already created A→C and is in flight.
    h.state.ops.push({
      id: 'op-a-to-c',
      revision: 1,
      doc_id: 'd1',
      from_title: 'A',
      to_title: 'C',
      status: 0,
      version: null,
      created_at: new Date(),
      updated_at: new Date(),
    })

    const blocked = await renameHtmlDoc(input('B'))
    expect(blocked).toMatchObject({ ok: false, status: 409, error: 'rename_in_progress' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.state.docs.get('d1')!.title).toBe('A')

    // The in-flight rename completes (doc becomes C, op completed), then B works.
    h.state.ops[0] = { ...h.state.ops[0]!, status: 1, version: 2 }
    h.state.docs.get('d1')!.title = 'C'
    const ok = await renameHtmlDoc(input('B'))
    expect(ok).toMatchObject({ ok: true, beforeTitle: 'C', version: 2 })
    expect(h.state.docs.get('d1')!.title).toBe('B')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a delayed duplicate of an already-completed op never rewrites the title after A→B→A', async () => {
    seedDoc('A')
    const waiters: Array<{ resolve: (res: Response) => void; body: Record<string, unknown> }> = []
    fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve) => {
      waiters.push({ resolve, body: JSON.parse(String(init?.body)) })
    }))
    setRepublish(fetchMock)

    // Request #1: A→B, blocked inside the html call (op1 pending).
    const first = renameHtmlDoc(input('B'))
    await vi.waitFor(() => expect(waiters).toHaveLength(1))

    // Duplicate A→B reuses op1 and commits B first.
    const duplicate = renameHtmlDoc(input('B'))
    await vi.waitFor(() => expect(waiters).toHaveLength(2))
    waiters[1]!.resolve(upstream(2, waiters[1]!.body))
    expect(await duplicate).toMatchObject({ ok: true, beforeTitle: 'A', version: 2 })
    expect(h.state.docs.get('d1')!.title).toBe('B')

    // B→A completes while request #1 is still parked before its second phase.
    const back = renameHtmlDoc(input('A'))
    await vi.waitFor(() => expect(waiters).toHaveLength(3))
    waiters[2]!.resolve(upstream(3, waiters[2]!.body))
    expect(await back).toMatchObject({ ok: true, version: 3 })
    expect(h.state.docs.get('d1')!.title).toBe('A')

    // Release request #1. Its op1 is already completed and the document has since
    // moved to A: it must report success against the CURRENT title, not write B.
    waiters[0]!.resolve(upstream(2, waiters[0]!.body))
    const delayed = await first
    expect(delayed).toMatchObject({
      ok: true,
      alreadyApplied: true,
      title: 'A',
      beforeTitle: 'A',
      version: 2,
    })
    expect(h.state.docs.get('d1')!.title).toBe('A')
    expect(h.state.ops).toHaveLength(2)
    expect(h.state.ops.every((op) => op.status === 1)).toBe(true)
  })

  it('409 rename_superseded when the op was fenced while html was publishing', async () => {
    seedDoc('A')
    fetchMock = vi.fn(async () => {
      // Another actor reclaimed the stale pending op in the meantime.
      h.state.ops[0]!.status = 2
      return upstream(2, { title: 'B' })
    })
    setRepublish(fetchMock)

    const result = await renameHtmlDoc(input('B'))
    expect(result).toMatchObject({ ok: false, status: 409, error: 'rename_superseded' })
    expect(h.state.docs.get('d1')!.title).toBe('A')
  })

  it('409 rename_superseded when a later logical rename completed first (same created_at ms)', async () => {
    seedDoc('A')
    fetchMock = vi.fn(async () => {
      const op1 = h.state.ops[0]!
      // Same millisecond on purpose: created_at alone cannot order these two,
      // so the fence must use the monotonic revision.
      h.state.ops.push({
        id: 'op-later',
        revision: op1.revision + 1,
        doc_id: 'd1',
        from_title: 'A',
        to_title: 'C',
        status: 1,
        version: 5,
        created_at: new Date(op1.created_at.getTime()),
        updated_at: new Date(),
      })
      h.state.docs.get('d1')!.title = 'C'
      return upstream(2, { title: 'B' })
    })
    setRepublish(fetchMock)

    const result = await renameHtmlDoc(input('B'))
    expect(result).toMatchObject({ ok: false, status: 409, error: 'rename_superseded' })
    expect(h.state.docs.get('d1')!.title).toBe('C')
    const supersededOp = h.state.ops.find((op) => op.id !== 'op-later')!
    expect(supersededOp.status).toBe(2)
    // Superseded is non-resumable: its replay receipt is dropped.
    expect(closeCalls).toEqual([{
      slug: 'html_slug_1', doc_id: 'd1', space_id: 's1', idempotency_key: supersededOp.id,
    }])
  })

  it('409 title_changed when the local title moved while html was publishing; never overwrites', async () => {
    seedDoc('A')
    // Simulate another writer changing the title during the html round-trip.
    fetchMock = vi.fn(async () => {
      h.state.docs.get('d1')!.title = 'X'
      return upstream(2, { title: 'B' })
    })
    setRepublish(fetchMock)

    const result = await renameHtmlDoc(input('B'))
    expect(result).toMatchObject({ ok: false, status: 409, error: 'title_changed' })
    expect(h.state.docs.get('d1')!.title).toBe('X')
    expect(h.state.ops).toHaveLength(1)
    expect(h.state.ops[0]!.status).toBe(2)
  })

  it('expires a pending operation older than the TTL instead of blocking forever', async () => {
    seedDoc('A')
    h.state.ops.push({
      id: 'op-stale',
      revision: 1,
      doc_id: 'd1',
      from_title: 'A',
      to_title: 'C',
      status: 0,
      version: null,
      created_at: new Date(Date.now() - RENAME_OPERATION_PENDING_TTL_MS - 1000),
      updated_at: new Date(Date.now() - RENAME_OPERATION_PENDING_TTL_MS - 1000),
    })

    const result = await renameHtmlDoc(input('B'))
    expect(result).toMatchObject({ ok: true, beforeTitle: 'A' })
    expect(h.state.docs.get('d1')!.title).toBe('B')
    expect(h.state.ops.find((op) => op.id === 'op-stale')!.status).toBe(2)
    expect(h.state.ops.filter((op) => op.status === 1)).toHaveLength(1)
  })
})

describe('HTML rename journal — revision ordering', () => {
  it('orders two operations created in the SAME millisecond by revision, not created_at', async () => {
    const at = new Date('2026-11-24T14:00:00.123Z')
    h.state.ops.push(
      {
        id: 'op-low', revision: 1, doc_id: 'd1', from_title: 'A', to_title: 'B',
        status: 1, version: 2, created_at: at, updated_at: at,
      },
      {
        id: 'op-high', revision: 2, doc_id: 'd1', from_title: 'B', to_title: 'C',
        status: 1, version: 3, created_at: at, updated_at: at,
      },
    )

    const newer = await docRenameOperationRepo.getLatestCompletedAfterTx(h.tx(), 'd1', 1)

    expect(newer?.id).toBe('op-high')
    expect(newer?.revision).toBe(2)
  })
})

describe('HTML rename journal — CLI lock recheck', () => {
  it('refuses the author UID in another principal Space even with a reader grant', async () => {
    seedDoc('A')
    h.state.members.set('author@s_other', 1)
    const result = await renameHtmlDoc(input('B', {
      uid: 'author',
      principalSpaceId: 's_other',
      mode: 'cli',
      expectedEpoch: 3,
    }))
    expect(result).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.state.ops).toEqual([])
  })

  it('rejects a non-author reader in cli mode', async () => {
    seedDoc('A')
    h.state.members.set('reader@s_other', 1)
    const result = await renameHtmlDoc(input('B', {
      uid: 'reader',
      principalSpaceId: 's_other',
      mode: 'cli',
      expectedEpoch: 3,
    }))
    expect(result).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.state.ops).toEqual([])
  })

  it('rejects an epoch change between the guard read and the locked rename', async () => {
    seedDoc('A', { permission_epoch: 4 })
    const result = await renameHtmlDoc(input('B', {
      uid: 'author',
      principalSpaceId: 's1', // same Space as owner: auth passes, epoch must still fence
      mode: 'cli',
      expectedEpoch: 3,
    }))
    expect(result).toMatchObject({ ok: false, status: 409, error: 'conflict' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
