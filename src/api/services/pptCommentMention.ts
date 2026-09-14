import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { resolveBotDocAccess } from '../../agent/botIdentity.js'
import { roleAtLeast } from '../../permission/role.js'
import { getPptComment, type PptCommentInput } from '../../ppt/comments.js'
import type { PptPrincipal } from '../../ppt/liveEdit.js'
import { loadPptDocForRead } from '../ppt/pptDocGuard.js'
import { reportBotMentions } from './botMention.js'
import { config } from '../../config/env.js'
import { mentionedUserUids } from './docsNotify.js'

/** PPT has its own comment namespace. Reuse the existing bounded delivery and
 * relationship checks, but revalidate the Human's Space-qualified edit access.
 * Owned bots must also belong to the caller's current Space: the global
 * verifyToken owned_bots list alone is not a Bot principal.
 */
export async function reportPptCommentMention(principal: PptPrincipal, id: number, input: PptCommentInput, callerToken: string): Promise<void> {
  if (principal.isBot || !config.botMention.token || !callerToken || !mentionedUserUids(input.body, principal.uid).length) return
  try {
    const author = await loadPptDocForRead(principal.uid, principal.spaceId, principal.docId, { token: callerToken })
    if (!roleAtLeast(author.role, 'writer') || Number(author.meta.permission_epoch) !== principal.authorizedEpoch) return
    const ownedBots = await getOctoIdentity().ownedBotsInSpace(principal.uid, principal.spaceId, callerToken)
    await reportBotMentions({
      docId: principal.docId, docKind: 'ppt', commentId: id, parentId: input.parentId,
      spaceId: principal.spaceId, authorUid: principal.uid, authorRole: author.role,
      ownedBots, callerToken, body: input.body,
      botAllowed: async botUid => {
        const current = await loadPptDocForRead(principal.uid, principal.spaceId, principal.docId, { token: callerToken })
        if (!roleAtLeast(current.role, 'writer') || Number(current.meta.permission_epoch) !== principal.authorizedEpoch) return false
        const { comment, root } = await getPptComment(principal, id)
        if (comment.deleted || root.deleted || root.resolved || comment.body !== input.body) return false
        return (await resolveBotDocAccess(principal.docId, botUid, principal.spaceId)).allowed
      },
    })
  } catch {
    // Metadata only: neither comment text nor identity/service tokens may leak.
    // eslint-disable-next-line no-console
    console.warn('[octo-docs] PPT bot mention unavailable', { docId: principal.docId, commentId: id })
  }
}
