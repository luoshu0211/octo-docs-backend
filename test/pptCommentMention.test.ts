import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ guard: vi.fn(), access: vi.fn(), owned: vi.fn(), friends: vi.fn(), comment: vi.fn() }))
vi.mock('../src/config/env.js', () => ({ config: {
  webOrigin: 'http://preview.test', octoIdentity: { serverBaseUrl: 'http://server.test' }, notify: { docsToken: '', service: 'docs' },
  botMention: { token: 'test-token', baseUrl: 'http://server.test', timeoutMs: 500, maxAttempts: 1, budgetMs: 1000, maxBotsPerComment: 8 },
} }))
vi.mock('../src/auth/octoIdentity.js', () => ({ getOctoIdentity: () => ({ ownedBotsInSpace: state.owned, listCallerBots: state.friends }) }))
vi.mock('../src/api/ppt/pptDocGuard.js', () => ({ loadPptDocForRead: state.guard }))
vi.mock('../src/agent/botIdentity.js', () => ({ resolveBotDocAccess: state.access, BOT_DOC_ACCESS_MIN_ROLE: 'writer' }))
vi.mock('../src/ppt/comments.js', () => ({ getPptComment: state.comment }))
vi.mock('../src/api/services/commentTaskTracking.js', () => ({ trackCommentTask: vi.fn(async () => {}) }))
import { reportPptCommentMention } from '../src/api/services/pptCommentMention.js'
import { buildIdempotencyKey } from '../src/api/services/botMention.js'
const principal = { docId: 'deck', uid: 'human', spaceId: 'viewer-space', authorizedEpoch: 7 }
const input = { body: '@[user:bot:Assistant] change this', parentId: 12 }
beforeEach(() => {
  vi.clearAllMocks()
  state.guard.mockResolvedValue({ role: 'writer', meta: { permission_epoch: 7 } })
  state.access.mockResolvedValue({ allowed: true, role: 'writer' })
  state.owned.mockResolvedValue(['bot']); state.friends.mockResolvedValue([])
  state.comment.mockResolvedValue({ comment: { body: input.body }, root: { deleted: false, resolved: false } })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 })))
})
afterEach(() => vi.unstubAllGlobals())
it('dispatches a PPT reply with a separate stable namespace and current viewer Space', async () => {
  await reportPptCommentMention(principal, 13, input, 'caller')
  expect(state.owned).toHaveBeenCalledWith('human', 'viewer-space', 'caller')
  expect(state.access).toHaveBeenCalledWith('deck', 'bot', 'viewer-space')
  const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)
  expect(body).toMatchObject({ doc_kind: 'ppt', comment_id: '13', parent_id: '12', space_id: 'viewer-space', from_uid: 'human', bot_uid: 'bot' })
  expect(body.idempotency_key).toBe(buildIdempotencyKey('deck', 13, 'bot', 'ppt'))
  expect(body.idempotency_key).not.toBe(buildIdempotencyKey('deck', 13, 'bot'))
  expect(body.thread_id).toBeUndefined()
})
it.each(['reader', 'commenter', 'none'])('does not let %s borrow a writer Bot', async role => {
  state.guard.mockResolvedValue({ role, meta: { permission_epoch: 7 } })
  await reportPptCommentMention(principal, 13, input, 'caller')
  expect(fetch).not.toHaveBeenCalled()
})
it('rechecks permission changes and comment deletion before dispatch', async () => {
  state.guard.mockResolvedValueOnce({ role: 'writer', meta: { permission_epoch: 7 } }).mockResolvedValue({ role: 'commenter', meta: { permission_epoch: 8 } })
  await reportPptCommentMention(principal, 13, input, 'caller')
  expect(fetch).not.toHaveBeenCalled()
  state.guard.mockResolvedValue({ role: 'writer', meta: { permission_epoch: 7 } })
  state.comment.mockResolvedValue({ comment: { body: input.body, deleted: true }, root: {} })
  await reportPptCommentMention(principal, 13, input, 'caller')
  expect(fetch).not.toHaveBeenCalled()
})
it('requires the Bot own exact grant and refuses missing relationships or other-Space ownership', async () => {
  state.access.mockResolvedValue({ allowed: false })
  await reportPptCommentMention(principal, 13, input, 'caller')
  expect(fetch).not.toHaveBeenCalled()
  state.access.mockResolvedValue({ allowed: true }); state.owned.mockResolvedValue([])
  await reportPptCommentMention(principal, 13, input, 'caller')
  expect(fetch).not.toHaveBeenCalled()
})
it('supports a friend-shared Bot with its own grant', async () => {
  state.owned.mockResolvedValue([]); state.friends.mockResolvedValue([{ uid: 'bot', creatorUid: 'other' }])
  await reportPptCommentMention(principal, 13, input, 'caller')
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('does not recurse on Bot replies and keeps dispatch failures best effort', async () => {
  await reportPptCommentMention({ ...principal, isBot: true }, 13, input, 'caller')
  expect(fetch).not.toHaveBeenCalled()
  state.guard.mockRejectedValue(new Error('offline'))
  await expect(reportPptCommentMention(principal, 13, input, 'caller')).resolves.toBeUndefined()
  expect(fetch).not.toHaveBeenCalled()
})
