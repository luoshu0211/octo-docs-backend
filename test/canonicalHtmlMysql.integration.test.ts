import '../src/config/loadEnv.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePool, query } from '../src/db/pool.js'
import { docMetaRepo, type CanonicalHtmlInput } from '../src/db/repos/docMetaRepo.js'

const mysqlDescribe = process.env.RUN_CANONICAL_HTML_MYSQL_TESTS === '1'
  ? describe.sequential
  : describe.skip

const SPACE_ID = 'canonical_html_mysql_space'
const OWNER_ID = 'canonical_html_mysql_bot'
const HUMAN_OWNER_ID = 'canonical_html_mysql_human'
const SUCCESS_DOC_ID = 'd_canonical_html_mysql_success'
const ROLLBACK_DOC_ID = 'd_canonical_html_mysql_rollback'

function input(docId: string, idempotencyKey: string): CanonicalHtmlInput {
  return {
    docId,
    documentName: `octo:${SPACE_ID}:f_default:html:${docId}`,
    title: 'Canonical HTML MySQL integration',
    ownerId: OWNER_ID,
    spaceId: SPACE_ID,
    folderId: 'f_default',
    docType: 'html',
    octoDocSlug: docId,
    idempotencyKey,
    createdBy: OWNER_ID,
  }
}

async function cleanup(): Promise<void> {
  const docIds = [SUCCESS_DOC_ID, ROLLBACK_DOC_ID]
  await query(`DELETE FROM doc_member WHERE doc_id IN (${docIds.map(() => '?').join(', ')})`, docIds)
  await query(`DELETE FROM doc_meta WHERE doc_id IN (${docIds.map(() => '?').join(', ')})`, docIds)
}

mysqlDescribe('canonical HTML create against real MySQL', () => {
  beforeAll(cleanup)

  afterAll(async () => {
    await cleanup()
    await closePool()
  })

  it('persists the verified Space as both owner_space_id and space_id and replays idempotently', async () => {
    const createInput = input(SUCCESS_DOC_ID, 'canonical-html-mysql-success')

    const first = await docMetaRepo.createCanonicalHtml({ ...createInput, humanOwnerUid: HUMAN_OWNER_ID })
    const replay = await docMetaRepo.createCanonicalHtml({ ...createInput, humanOwnerUid: HUMAN_OWNER_ID })
    const rows = await query<{
      doc_id: string
      owner_space_id: string
      space_id: string
    }>(
      'SELECT doc_id, owner_space_id, space_id FROM doc_meta WHERE doc_id = ?',
      [SUCCESS_DOC_ID],
    )

    expect(first.created).toBe(true)
    expect(replay.created).toBe(false)
    expect(replay.meta.doc_id).toBe(first.meta.doc_id)
    expect(rows).toEqual([{
      doc_id: SUCCESS_DOC_ID,
      owner_space_id: SPACE_ID,
      space_id: SPACE_ID,
    }])
  })

  it('rolls back a partial create and permits the same idempotency key to retry', async () => {
    const createInput = input(ROLLBACK_DOC_ID, 'canonical-html-mysql-rollback')

    await expect(docMetaRepo.createCanonicalHtml({
      ...createInput,
      // doc_member.uid is VARCHAR(64): force the member write after doc_meta to fail.
      humanOwnerUid: 'x'.repeat(65),
    })).rejects.toThrow()

    expect(await query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM doc_meta WHERE doc_id = ?',
      [ROLLBACK_DOC_ID],
    )).toEqual([{ count: 0 }])
    expect(await query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM doc_member WHERE doc_id = ?',
      [ROLLBACK_DOC_ID],
    )).toEqual([{ count: 0 }])

    const retry = await docMetaRepo.createCanonicalHtml({ ...createInput, humanOwnerUid: HUMAN_OWNER_ID })
    expect(retry.created).toBe(true)
    expect(retry.meta.owner_space_id).toBe(SPACE_ID)
    expect(retry.meta.space_id).toBe(SPACE_ID)
  })
})
