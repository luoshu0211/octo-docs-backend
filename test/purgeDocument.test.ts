import { describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 P1 — 彻底删除服务：html 远端 purge 与 DB 物理删除的顺序/失败策略。
 * 注入假 deps，不触达 config/对象存储/DB。
 */
import { purgeDocument, type PurgeDeps } from '../src/trash/purgeDocument.js'

function meta(overrides: Record<string, unknown> = {}) {
  return {
    doc_id: 'd1',
    space_id: 'org1',
    document_name: 'octo:s1:f1:d1',
    title: 'Doc',
    doc_type: 'doc',
    octo_doc_slug: null,
    status: 0,
    deleted_at: new Date('2026-11-10T00:00:00.000Z'),
    ...overrides,
  }
}

function deps(overrides: Partial<PurgeDeps> = {}): PurgeDeps {
  return {
    getMeta: vi.fn(async () => meta() as never),
    purgeHtml: vi.fn(async () => ({ ok: true }) as never),
    purgeRepo: vi.fn(async () => ({
      ok: true,
      doc: { documentName: 'octo:s1:f1:d1', attachObjectKeys: ['att/1'] },
    }) as never),
    deleteObject: vi.fn(async () => {}),
    enqueueIndex: vi.fn(async () => true),
    ...overrides,
  }
}

describe('purgeDocument', () => {
  it('404s a missing doc', async () => {
    const d = deps({ getMeta: vi.fn(async () => null) })
    expect(await purgeDocument('d1', { mode: 'strict', deps: d })).toEqual({
      ok: false, status: 404, error: 'not_found',
    })
    expect(d.purgeRepo).not.toHaveBeenCalled()
  })

  it.each([
    [1, 'not_deleted'],
    [2, 'doc_archived'],
  ] as const)('refuses a status=%i doc with %s', async (status, error) => {
    const d = deps({ getMeta: vi.fn(async () => meta({ status }) as never) })
    const result = await purgeDocument('d1', { mode: 'strict', deps: d })
    expect(result).toEqual({ ok: false, status: 409, error })
    expect(d.purgeRepo).not.toHaveBeenCalled()
  })

  it('strict: html purge failure => 503 and doc_meta is NOT deleted', async () => {
    const d = deps({
      getMeta: vi.fn(async () => meta({ doc_type: 'html', octo_doc_slug: 'slug-1' }) as never),
      purgeHtml: vi.fn(async () => ({ ok: false, reason: 'upstream_error', status: 500 }) as never),
    })
    const result = await purgeDocument('d1', { mode: 'strict', deps: d })
    expect(result).toEqual({ ok: false, status: 503, error: 'html_purge_failed' })
    expect(d.purgeHtml).toHaveBeenCalledWith('slug-1', 'd1', 'org1')
    expect(d.purgeRepo).not.toHaveBeenCalled()
  })

  it('strict: unconfigured html backend fails closed instead of deleting only doc_meta', async () => {
    const d = deps({
      getMeta: vi.fn(async () => meta({ doc_type: 'html', octo_doc_slug: 'slug-1' }) as never),
      purgeHtml: vi.fn(async () => ({ ok: true, skipped: true, reason: 'config_missing' }) as never),
    })
    const result = await purgeDocument('d1', { mode: 'strict', deps: d })
    expect(result).toEqual({ ok: false, status: 503, error: 'html_purge_failed' })
    expect(d.purgeRepo).not.toHaveBeenCalled()
  })

  it('best_effort: html purge failure is logged and the DB purge still runs', async () => {
    const d = deps({
      getMeta: vi.fn(async () => meta({ doc_type: 'html', octo_doc_slug: 'slug-1' }) as never),
      purgeHtml: vi.fn(async () => ({ ok: false, reason: 'network_error' }) as never),
    })
    const result = await purgeDocument('d1', { mode: 'best_effort', deps: d })
    expect(result.ok).toBe(true)
    expect(d.purgeRepo).toHaveBeenCalledWith('d1')
  })

  it('skips the remote call for non-html docs and for html without a slug', async () => {
    for (const subject of [meta(), meta({ doc_type: 'html', octo_doc_slug: null })]) {
      const d = deps({ getMeta: vi.fn(async () => subject as never) })
      await purgeDocument('d1', { mode: 'strict', deps: d })
      expect(d.purgeHtml).not.toHaveBeenCalled()
      expect(d.purgeRepo).toHaveBeenCalled()
    }
  })

  it('treats a concurrently-purged row as not_found', async () => {
    const d = deps({ purgeRepo: vi.fn(async () => ({ ok: false, reason: 'not_found' }) as never) })
    expect(await purgeDocument('d1', { mode: 'strict', deps: d })).toEqual({
      ok: false, status: 404, error: 'not_found',
    })
  })

  it('deletes attachment objects and re-signals the index after the DB commit', async () => {
    const d = deps()
    const result = await purgeDocument('d1', { mode: 'strict', deps: d })
    expect(result.ok).toBe(true)
    expect(d.deleteObject).toHaveBeenCalledWith('att/1')
    expect(d.enqueueIndex).toHaveBeenCalledWith('octo:s1:f1:d1')
  })

  it('never fails a committed purge because an attachment object delete failed', async () => {
    const d = deps({ deleteObject: vi.fn(async () => { throw new Error('storage down') }) })
    const result = await purgeDocument('d1', { mode: 'strict', deps: d })
    expect(result.ok).toBe(true)
  })
})
