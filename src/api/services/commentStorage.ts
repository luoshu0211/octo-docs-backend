import type { Request } from 'express'
import type { DocGuard } from '../guard.js'
import { docCommentRepo, type DocComment, type CreateCommentInput, type ListRootsOptions } from '../../db/repos/docCommentRepo.js'
import { createPptComment, getPptComment, listPptComments, listPptRepliesForRoots, mutatePptComment } from '../../ppt/comments.js'
import { PptApiError } from '../ppt/errors.js'
import type { PptPrincipal } from '../../ppt/liveEdit.js'

export function pptPrincipalFromGuard(req: Request, guard: DocGuard): PptPrincipal {
  const spaceId = req.principalSpaceId
  if (!spaceId) throw new PptApiError('FORBIDDEN', 'verified principal Space required')
  return { docId: guard.meta.doc_id, uid: req.uid!, spaceId,
    authorizedEpoch: Number(guard.meta.permission_epoch), isBot: req.docSpaceScope?.mode === 'bot' }
}

export function commentStorage(req: Request, guard: DocGuard) {
  if (guard.meta.doc_type !== 'html_ppt') return { ...docCommentRepo, didCreate: () => true }
  const principal = pptPrincipalFromGuard(req, guard)
  const convert = (row: Awaited<ReturnType<typeof getPptComment>>['comment']): DocComment => ({
    ...row, documentName: guard.meta.document_name, anchorStart: null, anchorEnd: null,
    anchorText: '', resolvedBy: null, resolvedAt: row.resolved ? row.updatedAt : null,
  })
  let didCreate = false
  const create = async (input: Pick<CreateCommentInput, 'body' | 'parentId' | 'anchor'>) => {
    const result = await createPptComment(principal,
      { body: input.body, ...(input.parentId === null ? { anchor: input.anchor } : { parentId: input.parentId }) },
      req.header('Idempotency-Key') ?? '', () => { didCreate = true })
    return result.id
  }
  const mutate = (id: number, change: { action: 'edit'; body: string } | { action: 'resolve'; resolved: boolean } | { action: 'delete'; hard?: boolean }) =>
    mutatePptComment(principal, id, { ...change, revision: Number(req.body?.revision ?? req.query.revision) }).then(() => undefined)
  return {
    ...docCommentRepo,
    didCreate: () => didCreate,
    create,
    createReplyIfRoot: create,
    getById: async (id: number) => {
      try { return convert((await getPptComment(principal, id)).comment) }
      catch (error) { if (error instanceof PptApiError && error.code === 'NOT_FOUND') return null; throw error }
    },
    listRoots: async (_docId: string, opts: ListRootsOptions) =>
      (await listPptComments(principal, opts.cursor ?? 0, undefined, opts.limit, opts.includeResolved)).items.map(convert),
    listReplies: async (id: number) => (await listPptComments(principal, 0, id)).items.map(convert),
    listRepliesForRoots: async (ids: number[]) => (await listPptRepliesForRoots(principal, ids)).map(convert),
    updateBody: (id: number, body: string) => mutate(id, { action: 'edit', body }),
    setResolved: (id: number, resolved: boolean) => mutate(id, { action: 'resolve', resolved }),
    softDelete: (id: number) => mutate(id, { action: 'delete' }),
    hardDelete: (id: number) => mutate(id, { action: 'delete', hard: true }),
  }
}
