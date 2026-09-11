import type { Role } from '../permission/role.js'

export type CommentAction = 'edit' | 'resolve' | 'delete'
export function commentMutationRole(action: CommentAction, hard = false): Role {
  return action === 'delete' ? (hard ? 'admin' : 'commenter') : 'writer'
}

/** A storage adapter may qualify authors by Space; never discard that qualification. */
export function isCommentAuthor(comment: { authorUid: string; authorSpaceId?: string }, principal: { uid: string; spaceId?: string }) {
  return comment.authorUid === principal.uid &&
    (comment.authorSpaceId === undefined || comment.authorSpaceId === principal.spaceId)
}

export function isCommentBody(value: unknown, maxLength = Infinity): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

/** Called while the storage adapter holds the parent lock. */
export function isReplyRoot(row: { parentId: number | null; deleted: boolean } | null | undefined): boolean {
  return !!row && row.parentId === null && !row.deleted
}
