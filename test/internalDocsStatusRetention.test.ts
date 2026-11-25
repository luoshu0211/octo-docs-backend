import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 P1 — 保留期字段投影（POST /internal/docs/status 的 deleted 行）。
 *
 * 只钉新增的两个字段（灰行原有 deleted/deleted_at/expired 由
 * internalDocsLibrary.test.ts 覆盖）：
 *   expire_at = deleted_at + 30d（ISO8601 UTC）
 *   retention_days = 30
 * deleted_at 为 NULL 的历史删除行 => expire_at:null、retention_days:30。
 */
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    driveDerived: {
      inboundToken: 'drive-tok',
      outboundToken: '',
      enabled: false,
      internalBaseUrl: '',
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

import { internalDocStatusHandler } from '../src/api/routes/internalDocsLibrary.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { TRASH_RETENTION_MS } from '../src/permission/docRetention.js'

interface MockRes {
  statusCode: number
  body: { items: Array<Record<string, unknown>> }
  status(code: number): MockRes
  json(body: unknown): MockRes
}
function response(): MockRes {
  return {
    statusCode: 0,
    body: { items: [] },
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body as { items: Array<Record<string, unknown>> }; return this },
  }
}
function request(body: unknown) {
  return {
    body,
    header: (name: string) => (name.toLowerCase() === 'x-internal-token' ? 'drive-tok' : undefined),
  }
}

const deletedAt = new Date('2026-11-01T00:00:00.000Z')
const deletedMeta = {
  doc_id: 'd_deleted',
  title: 'Deleted doc',
  doc_type: 'doc',
  owner_id: 'u1',
  owner_space_id: 's1',
  space_id: 's1',
  status: 0,
  deleted_at: deletedAt,
  share_scope: 0,
  share_role: 1,
  updated_at: new Date('2026-11-02T00:00:00.000Z'),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([deletedMeta] as never)
  vi.mocked(docMetaRepo.getLegacyVisibleDocIds).mockResolvedValue(new Set() as never)
  vi.mocked(docMemberRepo.getRoles).mockResolvedValue(new Map() as never)
})

describe('POST /internal/docs/status — trash retention projection', () => {
  it('adds expire_at = deleted_at + 30d and retention_days = 30 to a deleted grey row', async () => {
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ['d_deleted'] }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0]).toMatchObject({
      doc_id: 'd_deleted',
      deleted: true,
      deleted_at: '2026-11-01T00:00:00.000Z',
      expire_at: new Date(deletedAt.getTime() + TRASH_RETENTION_MS).toISOString(),
      retention_days: 30,
      can_read: false,
    })
  })

  it('reports expire_at:null for a historical delete with unknown deleted_at (never auto-cleaned)', async () => {
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValueOnce([{ ...deletedMeta, deleted_at: null }] as never)
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ['d_deleted'] }) as never,
      res as never,
    )
    expect(res.body.items[0]).toMatchObject({
      deleted: true,
      deleted_at: null,
      expire_at: null,
      retention_days: 30,
      expired: false,
    })
  })
})
