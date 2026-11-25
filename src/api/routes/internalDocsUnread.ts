/**
 * OCTO-456 P0 — 内部批量未读接口（供 drive「与我共享」的 `unread_only`）。
 *
 *   POST /internal/docs/member-added/unread
 *   X-Internal-Token: <DOCS_INTERNAL_TOKEN>
 *   { "uid":"u1", "principal_space_id":"org1", "doc_ids":["d1","d2"] }   // ≤200
 *   → 200 { "items":[{"doc_id":"d1","unread":true,"event_at":"..."}] }
 *
 * 语义：
 *   - 认证由 internal token 完成，`uid` / `principal_space_id` 就是调用方声明的
 *     主体；docs 不再按请求头猜测调用者（与 `/internal/docs/:docId/role` 同一
 *     信任域）。
 *   - 数据源是 `doc_member_notification`（`read_at IS NULL`），即「被加入文档」
 *     提醒；邀请接受不写这张表，所以这里也没有第二类事件需要排除。
 *   - 返回**请求里的每个 doc_id 一项**（按请求顺序、已去重），显式带
 *     `unread` 布尔；未读项带 `event_at`（ISO8601 UTC），未读为 false 时
 *     `event_at:null`。这样调用方无需区分「没查」与「已读」。
 *   - 每项 `doc_id` 与请求值逐字一致（用于 drive 侧按 id 对齐行）。
 *
 * 路由顺序与 sibling internal 路由一致：limiter → X-Internal-Token → 64KiB
 * JSON body → handler。全局 `express.json` 跳过 `/internal/docs`，所以未认证
 * 请求在任何 body 解析之前就被拒绝。
 */
import {
  Router,
  json as jsonBodyParser,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router as ExpressRouter,
} from 'express'
import { docMemberNotificationRepo } from '../../db/repos/docMemberNotificationRepo.js'
import { authorizeInternalDocRequest, requireInternalDocToken } from './internalDocRole.js'

/** 单次请求的 doc_ids 上限（PRD 约定 ≤200）。 */
export const MAX_UNREAD_DOC_IDS = 200

export function createInternalDocsUnreadRouter(limiter: RequestHandler): ExpressRouter {
  const router = Router()
  const body = jsonBodyParser({ limit: 64 * 1024 })
  router.post(
    '/member-added/unread',
    limiter,
    requireInternalDocToken,
    body,
    asyncHandler(internalDocsMemberAddedUnreadHandler),
  )
  return router
}

interface UnreadRequest {
  uid: string
  principalSpaceId: string
  docIds: string[]
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * 校验 body 并把 doc_ids 去重（保留首次出现顺序）。
 * 不合法时已写 400，返回 null。
 */
function parseUnreadRequest(req: Request, res: Response): UnreadRequest | null {
  const body = (req.body ?? {}) as Record<string, unknown>
  const uid = nonEmptyString(body.uid)
  const principalSpaceId = nonEmptyString(body.principal_space_id)
  const rawDocIds = body.doc_ids
  if (
    uid === null
    || principalSpaceId === null
    || !Array.isArray(rawDocIds)
    || rawDocIds.some((id) => typeof id !== 'string')
  ) {
    res.status(400).json({ error: 'invalid_request' })
    return null
  }
  const seen = new Set<string>()
  const docIds: string[] = []
  for (const raw of rawDocIds as string[]) {
    const id = raw.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    docIds.push(id)
  }
  if (docIds.length > MAX_UNREAD_DOC_IDS) {
    res.status(400).json({ error: 'too_many_doc_ids' })
    return null
  }
  return { uid, principalSpaceId, docIds }
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** 200 body of POST /internal/docs/member-added/unread. */
export async function internalDocsMemberAddedUnreadHandler(
  req: Request,
  res: Response,
): Promise<void> {
  // 与 sibling internal handler 一致：路由链上的 requireInternalDocToken 是入口
  // 闸门，handler 内再判一次，保证「直接调用 handler」也不会绕过鉴权。
  if (!authorizeInternalDocRequest(req, res)) return
  const parsed = parseUnreadRequest(req, res)
  if (!parsed) return
  const { uid, principalSpaceId, docIds } = parsed
  if (docIds.length === 0) {
    res.status(200).json({ items: [] })
    return
  }

  const unreadRows = await docMemberNotificationRepo.listUnreadForDocs({
    recipientUid: uid,
    recipientSpaceId: principalSpaceId,
    docIds,
  })
  const eventAtByDoc = new Map<string, Date>()
  for (const row of unreadRows) {
    // 一文档一条提醒（PK 含 doc_id），防御性保留第一条。
    if (!eventAtByDoc.has(row.doc_id)) eventAtByDoc.set(row.doc_id, row.event_at)
  }

  const items = docIds.map((docId) => {
    const eventAt = eventAtByDoc.get(docId)
    return {
      doc_id: docId,
      unread: eventAt !== undefined,
      event_at: isoOrNull(eventAt),
    }
  })
  res.status(200).json({ items })
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next)
  }
}
