import { docCommentTaskRepo } from '../../db/repos/docCommentTaskRepo.js'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import { buildIdempotencyKey, type BotMentionDeps } from './botMention.js'
import { publishCommentMutation } from './commentEvents.js'

/** Called only after reportBotMentions has verified the author, Bot relationship and document grant. */
export const trackCommentTask: NonNullable<BotMentionDeps['onTask']> = async (p, botUid, outcome) => {
  const meta = p.docKind === 'html'
    ? await docMetaRepo.getByOctoDocSlug(p.docId, p.spaceId)
    : await docMetaRepo.getByDocId(p.docId)
  if (!meta || meta.status !== 1) throw new Error('comment_task_document_unavailable')
  const key = buildIdempotencyKey(p.docId, p.commentId, botUid, p.docKind)
  if (!outcome) {
    await docCommentTaskRepo.prepare({ key, docId: meta.doc_id, kind: p.docKind ?? 'doc', commentId: String(p.commentId), botUid })
  } else {
    await docCommentTaskRepo.delivery(key, outcome.kind === 'accepted')
  }
  await publishCommentMutation(meta.document_name, meta.doc_id, undefined, 'updated')
}
