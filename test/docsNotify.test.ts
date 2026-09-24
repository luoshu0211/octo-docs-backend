import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Offline unit tests for the docs-notify outbound client (octo-server internal
// notify API, PR #584 contract). config, docMemberRepo, octoIdentity and
// global.fetch are mocked so we assert:
//   - config gating (missing internal token => no-op, no fetch)
//   - recipient resolution (owner + admins, de-duped, requester excluded)
//   - request shape: /v1/internal/notify, X-Internal-Token header, single-target
//     docs_card{kind:access_requested, ...} — and NEVER a type-17 payload/card
//   - only delivered[] counts; filtered/500/network failures are swallowed
vi.mock('../src/config/env.js', () => ({
  config: {
    octoIdentity: { serverBaseUrl: 'http://octo-server:8080' },
    notify: { docsToken: '', service: 'docs-service' },
  },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  ROLE_ADMIN: 3,
  docMemberRepo: { list: vi.fn(async () => []) },
}))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    getByDocId: vi.fn(async () => ({
      doc_id: 'doc-1',
      owner_id: 'u-owner',
      space_id: 'space-1',
      share_scope: 0, // restricted (default)
      share_role: 1,
    })),
  },
}))
vi.mock('../src/db/repos/docAccessNotifyCardRepo.js', () => ({
  docAccessNotifyCardRepo: { record: vi.fn(async () => {}) },
}))
const mockIdentity = vi.hoisted(() => ({
  getUser: vi.fn(async (uid: string) => ({ uid, name: uid === 'u-req' ? '申请人小明' : uid })),
  getSpaceName: vi.fn(async () => ''),
  spaceBots: vi.fn(async () => []),
}))
vi.mock('../src/auth/octoIdentity.js', () => ({ getOctoIdentity: () => mockIdentity }))

import { notifyDocAccessRequested, notifyDocMentioned, mentionedUserUids } from '../src/api/services/docsNotify.js'
import { config } from '../src/config/env.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docAccessNotifyCardRepo } from '../src/db/repos/docAccessNotifyCardRepo.js'

const cfg = config as unknown as { notify: { docsToken: string; service: string } }

function baseParams() {
  return {
    docId: 'doc-1',
    requestId: 'req-1',
    spaceId: 'space-1',
    principalSpaceId: 'space-1',
    ownerId: 'u-owner',
    ownerSpaceId: 'space-1',
    title: 'Test Doc',
    requesterUid: 'u-req',
    requesterSpaceId: 'space-1',
    reason: 'need edit',
    requestedRole: 'commenter' as const,
    botUids: [],
  }
}

function okResp(delivered: string[]) {
  return new Response(JSON.stringify({ delivered, filtered: {} }), { status: 200 })
}

function cardResp(uid: string, spaceId: string) {
  return new Response(JSON.stringify({
    delivered: [uid], filtered: {},
    delivered_cards: [{
      uid, channel_id: `ch-${spaceId}`, channel_type: 1,
      message_id: `m-${spaceId}`, client_msg_no: `cm-${spaceId}`,
    }],
  }), { status: 200 })
}

describe('notifyDocAccessRequested', () => {
  beforeEach(() => {
    cfg.notify.docsToken = 'internal-token'
    mockIdentity.getUser.mockImplementation(async (uid: string) => ({ uid, name: uid === 'u-req' ? '申请人小明' : uid }))
    mockIdentity.getSpaceName.mockResolvedValue('')
    mockIdentity.spaceBots.mockResolvedValue([])
    ;(docMemberRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { doc_id: 'doc-1', uid: 'u-admin', principal_space_id: 'space-1', role: 3 },
      { doc_id: 'doc-1', uid: 'u-writer', principal_space_id: 'space-1', role: 2 }, // not admin -> excluded
      { doc_id: 'doc-1', uid: 'u-owner', principal_space_id: 'space-1', role: 3 }, // duplicate of owner -> de-duped
    ])
    // Echo the single target back in delivered[] so each send counts as delivered.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const uid = JSON.parse(init.body as string).targets[0]
        return okResp([uid])
      }),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('is a no-op when the internal token is unset (no fetch)', async () => {
    cfg.notify.docsToken = ''
    const delivered = await notifyDocAccessRequested(baseParams())
    expect(delivered).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends to owner + admins, de-duped, excluding the requester (one request each)', async () => {
    const delivered = await notifyDocAccessRequested(baseParams())
    expect(delivered).toBe(2)
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(2)
    const recipients = calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).targets[0]).sort()
    expect(recipients).toEqual(['u-admin', 'u-owner'])
    const deliverySpaces = Object.fromEntries(calls.map((c) => {
      const body = JSON.parse((c[1] as RequestInit).body as string)
      return [body.targets[0], body.space_id]
    }))
    expect(deliverySpaces).toEqual({ 'u-owner': 'space-1', 'u-admin': 'space-1' })
  })

  it('excludes the exact requester principal in the same Space', async () => {
    ;(docMemberRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const delivered = await notifyDocAccessRequested({
      ...baseParams(),
      ownerId: 'u-req',
      ownerSpaceId: 'space-1',
      requesterUid: 'u-req',
      requesterSpaceId: 'space-1',
    })
    expect(delivered).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps the same uid as an approver when owner and requester are in different Spaces', async () => {
    ;(docMemberRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const delivered = await notifyDocAccessRequested({
      ...baseParams(),
      ownerId: 'admin',
      ownerSpaceId: 'space-test',
      requesterUid: 'admin',
      requesterSpaceId: 'space-123',
    })
    expect(delivered).toBe(1)
    const body = JSON.parse(((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string)
    expect(body.targets).toEqual(['admin'])
    expect(body.space_id).toBe('space-test')
  })

  it('preserves same-UID approver principals in distinct Spaces after exact requester exclusion', async () => {
    ;(docMemberRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { uid: 'admin', principal_space_id: 'space-123', role: 3 }, // exact requester principal: excluded
      { uid: 'admin', principal_space_id: 'space-other', role: 3 }, // qualifying approver principal
      { uid: 'admin-2', principal_space_id: 'space-test', role: 3 },
    ])
    const delivered = await notifyDocAccessRequested({
      ...baseParams(),
      ownerId: 'admin',
      ownerSpaceId: 'space-test',
      requesterUid: 'admin',
      requesterSpaceId: 'space-123',
    })
    expect(delivered).toBe(3)
    const deliveries = (fetch as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => {
        const b = JSON.parse((call[1] as RequestInit).body as string)
        return `${b.targets[0]}@${b.space_id}`
      })
      .sort()
    expect(deliveries).toEqual(['admin-2@space-test', 'admin@space-other', 'admin@space-test'])
    expect(deliveries).not.toContain('admin@space-123')
  })

  it('records two delivered cards for one uid in two Spaces with delivery Space coordinates', async () => {
    ;(docMemberRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { uid: 'same-admin', principal_space_id: 'space-A', role: 3 },
      { uid: 'same-admin', principal_space_id: 'space-B', role: 3 },
    ])
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      return cardResp(body.targets[0], body.space_id)
    }))

    expect(await notifyDocAccessRequested({ ...baseParams(), ownerId: '', ownerSpaceId: '' })).toBe(2)
    expect(docAccessNotifyCardRepo.record).toHaveBeenCalledWith('req-1', [
      expect.objectContaining({ recipientUid: 'same-admin', deliverySpaceId: 'space-A', messageId: 'm-space-A' }),
      expect.objectContaining({ recipientUid: 'same-admin', deliverySpaceId: 'space-B', messageId: 'm-space-B' }),
    ])
  })

  it('stamps each notification with the approver principal Space', async () => {
    ;(docMemberRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { uid: 'u-admin', principal_space_id: 'space-admin', role: 3 },
    ])
    await notifyDocAccessRequested({
      ...baseParams(),
      ownerSpaceId: 'space-owner',
      spaceId: 'space-doc',
    })
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls
    const spaces = Object.fromEntries(calls.map((call) => {
      const body = JSON.parse((call[1] as RequestInit).body as string)
      return [body.targets[0], body.space_id]
    }))
    expect(spaces).toEqual({ 'u-owner': 'space-owner', 'u-admin': 'space-admin' })
  })

  it('hits /v1/internal/notify with X-Internal-Token and a single-target docs_card', async () => {
    await notifyDocAccessRequested(baseParams())
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://octo-server:8080/v1/internal/notify')
    expect((init.headers as Record<string, string>)['X-Internal-Token']).toBe('internal-token')
    const body = JSON.parse(init.body as string)
    expect(body.space_id).toBe('space-1')
    expect(body.service).toBe('docs-service')
    expect(body.targets).toHaveLength(1)
    // Never a hand-built type-17 map — only structured docs_card.
    expect(body.payload).toBeUndefined()
    expect(body.card).toBeUndefined()
    expect(body.docs_card.kind).toBe('access_requested')
    expect(body.docs_card.doc_id).toBe('doc-1')
    expect(body.docs_card.title).toBe('Test Doc')
    expect(body.docs_card.actor_name).toBe('申请人小明')
    expect(body.docs_card.excerpt).toBe('need edit')
    expect(body.docs_card.requester_space_name).toBe('space-1')
    expect(body.docs_card.requested_bot_names).toEqual([])
    expect(body.docs_card.requested_role).toBe('commenter')
    expect(typeof body.docs_card.updated_at).toBe('string')
  })

  it('keeps requested Bots separate from the reason and resolves their display names', async () => {
    mockIdentity.spaceBots.mockResolvedValue([
      { uid: 'bot_a', name: '分析助手' },
      { uid: 'bot_b', name: '写作助手' },
    ])
    mockIdentity.getSpaceName.mockResolvedValue('产品 Space')
    await notifyDocAccessRequested({ ...baseParams(), botUids: ['bot_a', 'bot_b'] })
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.docs_card.excerpt).toBe('need edit')
    expect(body.docs_card.requester_space_name).toBe('产品 Space')
    expect(body.docs_card.requested_bot_names).toEqual(['分析助手', '写作助手'])
  })

  it('caps only the free-text reason at 300 runes', async () => {
    await notifyDocAccessRequested({
      ...baseParams(),
      reason: '理'.repeat(400),
      botUids: [],
    })
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    const excerpt = JSON.parse(init.body as string).docs_card.excerpt as string
    expect([...excerpt]).toHaveLength(300)
    expect(excerpt).toBe('理'.repeat(300))
  })

  it('counts only delivered[]; a filtered recipient is not counted', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okResp(['u-owner'])) // delivered
        .mockResolvedValueOnce(new Response(JSON.stringify({ delivered: [], filtered: { 'u-admin': 'busy' } }), { status: 200 })),
    )
    const delivered = await notifyDocAccessRequested(baseParams())
    expect(delivered).toBe(1)
  })

  it('never throws on a 500 or network error (best-effort)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    expect(await notifyDocAccessRequested(baseParams())).toBe(0)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    expect(await notifyDocAccessRequested(baseParams())).toBe(0)
  })
})

describe('mentionedUserUids', () => {
  it('extracts unique user uids, ignores doc mentions, excludes the author', () => {
    const body = 'hi @[user:u_1:Alice] and @[doc:d_9:Plan] cc @[user:u_2:Bob] and @[user:u_1:Alice] again'
    expect(mentionedUserUids(body, 'u_author')).toEqual(['u_1', 'u_2'])
  })
  it('excludes the author (no self-notify)', () => {
    expect(mentionedUserUids('@[user:u_1:Me] @[user:u_2:You]', 'u_1')).toEqual(['u_2'])
  })
  it('returns [] when there are no mentions', () => {
    expect(mentionedUserUids('just plain text', 'u_1')).toEqual([])
  })
})

describe('notifyDocMentioned', () => {
  function mentionParams() {
    return {
      docId: 'doc-1',
      spaceId: 'space-1',
      principalSpaceId: 'space-1',
      title: 'Test Doc',
      authorUid: 'u-req', // commenter; excluded + actor
      body: 'see this @[user:u_1:Alice] and @[user:u_2:Bob]',
    }
  }
  function sentMentionCards() {
    return vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(init!.body as string))
  }
  function expectRedactedCards() {
    for (const request of sentMentionCards()) {
      expect(request.docs_card).toEqual({
        doc_id: 'doc-1', request_id: '', kind: 'commented',
        title: '你在一篇文档中被提及', actor_uid: 'u-req', actor_name: expect.any(String),
        excerpt: '你暂时没有访问权限，打开文档后可申请访问。', updated_at: expect.any(String),
      })
      expect(JSON.stringify(request)).not.toContain(mentionParams().title)
      expect(JSON.stringify(request)).not.toContain('Alice')
      expect(JSON.stringify(request)).not.toContain('Bob')
    }
  }
  beforeEach(() => {
    cfg.notify.docsToken = 'internal-token'
    // Restricted doc (default mock) whose readers are owner + these doc_members;
    // u_1/u_2 are members so they're authorized recipients.
    ;(docMetaRepo.getByDocId as ReturnType<typeof vi.fn>).mockResolvedValue({
      doc_id: 'doc-1',
      owner_id: 'u-owner',
      space_id: 'space-1',
      share_scope: 0,
      share_role: 1,
      owner_space_id: 'space-1',
    })
    ;(docMemberRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { doc_id: 'doc-1', uid: 'u_1', principal_space_id: 'space-1', role: 1 },
      { doc_id: 'doc-1', uid: 'u_2', principal_space_id: 'space-1', role: 2 },
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => okResp([JSON.parse(init.body as string).targets[0]])),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('is a no-op when the internal token is unset (no fetch)', async () => {
    cfg.notify.docsToken = ''
    expect(await notifyDocMentioned(mentionParams())).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('is a no-op when nobody is mentioned', async () => {
    expect(await notifyDocMentioned({ ...mentionParams(), body: 'no mentions here' })).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends a commented docs_card to each mentioned user (one request each)', async () => {
    const delivered = await notifyDocMentioned(mentionParams())
    expect(delivered).toBe(2)
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls
    const recipients = calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).targets[0]).sort()
    expect(recipients).toEqual(['u_1', 'u_2'])
    const body = JSON.parse((calls[0]![1] as RequestInit).body as string)
    expect(body.docs_card.kind).toBe('commented')
    expect(body.docs_card.doc_id).toBe('doc-1')
    expect(body.payload).toBeUndefined()
    expect(body.card).toBeUndefined()
    // Excerpt collapses tokens to @label (no raw @[...] leaks into the card).
    expect(body.docs_card.excerpt).toBe('see this @Alice and @Bob')
  })

  it.each(['', '   '])('supplies a nonempty card title for an untitled document (%j)', async (title) => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      return body.docs_card.title.trim() ? okResp(body.targets) : new Response('', { status: 400 })
    }))
    expect(await notifyDocMentioned({ ...mentionParams(), title })).toBe(2)
    const [, init] = vi.mocked(fetch).mock.calls[0]!
    expect(JSON.parse(init!.body as string).docs_card.title).toBe('无标题文档')
  })

  it('delivers to the verified mention Space instead of the document Home Space', async () => {
    vi.mocked(docMemberRepo.list).mockResolvedValue([
      { uid: 'u_1', principal_space_id: 'space-visitor', role: 1 },
    ] as never)
    expect(await notifyDocMentioned({ ...mentionParams(), principalSpaceId: 'space-visitor' })).toBe(2)
    expect(sentMentionCards().map((request) => request.space_id)).toEqual(['space-visitor', 'space-visitor'])
    expect(sentMentionCards()[0].docs_card.title).toBe('Test Doc')
    expect(sentMentionCards()[1].docs_card.title).toBe('你在一篇文档中被提及')
  })

  it('does not borrow a same-uid membership from another Space', async () => {
    vi.mocked(docMemberRepo.list).mockResolvedValue([
      { uid: 'u_1', principal_space_id: 'space-foreign', role: 1 },
    ] as never)
    expect(await notifyDocMentioned(mentionParams())).toBe(2)
    expectRedactedCards()
  })

  it('requires the owner principal Space to match as well as the uid', async () => {
    vi.mocked(docMemberRepo.list).mockResolvedValue([])
    expect(await notifyDocMentioned({ ...mentionParams(), principalSpaceId: 'space-foreign', body: '@[user:u-owner:Owner]' })).toBe(1)
    expectRedactedCards()
  })

  it('does not extend Home-Space sharing to another Space without a direct grant', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({
      doc_id: 'doc-1', space_id: 'space-1', owner_id: 'owner', owner_space_id: 'space-1', share_scope: 1,
    } as never)
    expect(await notifyDocMentioned({ ...mentionParams(), principalSpaceId: 'space-foreign' })).toBe(2)
    expectRedactedCards()
  })

  it('honors authenticated sharing while retaining downstream Space-membership verification', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({
      doc_id: 'doc-1', space_id: 'space-1', owner_id: 'owner', owner_space_id: 'space-1', share_scope: 2,
    } as never)
    expect(await notifyDocMentioned({ ...mentionParams(), principalSpaceId: 'space-foreign' })).toBe(2)
    for (const request of sentMentionCards()) {
      expect(request.space_id).toBe('space-foreign')
      expect(request.docs_card.title).toBe('Test Doc')
      expect(request.docs_card.excerpt).toBe('see this @Alice and @Bob')
    }
  })

  it('fails closed without a verified principal Space', async () => {
    expect(await notifyDocMentioned({ ...mentionParams(), principalSpaceId: '' })).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('redacts cards for invalid member roles', async () => {
    vi.mocked(docMemberRepo.list).mockResolvedValue([{ uid: 'u_1', principal_space_id: 'space-1', role: 0 }] as never)
    expect(await notifyDocMentioned(mentionParams())).toBe(2)
    expectRedactedCards()
  })

  it('does not notify for deleted documents, even with open sharing', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ doc_id: 'doc-1', status: 0, share_scope: 1 } as never)
    expect(await notifyDocMentioned(mentionParams())).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not count filtered recipients as delivered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      delivered: [], filtered: { u_1: 'not_space_member', u_2: 'busy' },
    }), { status: 200 })))
    expect(await notifyDocMentioned(mentionParams())).toBe(0)
  })

  it('never throws on a 500 or network error (best-effort)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    expect(await notifyDocMentioned(mentionParams())).toBe(0)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    expect(await notifyDocMentioned(mentionParams())).toBe(0)
  })

  it('notifies both readers and non-readers without disclosing restricted content to non-readers', async () => {
    ;(docMemberRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { doc_id: 'doc-1', uid: 'u_1', principal_space_id: 'space-1', role: 1 },
    ])
    const delivered = await notifyDocMentioned(mentionParams())
    expect(delivered).toBe(2)
    expect(sentMentionCards().map((request) => request.targets)).toEqual([['u_1'], ['u_2']])
    expect(sentMentionCards()[0].docs_card).toMatchObject({
      title: 'Test Doc', excerpt: 'see this @Alice and @Bob',
    })
    expect(sentMentionCards()[1].docs_card).toEqual({
      doc_id: 'doc-1', request_id: '', kind: 'commented', title: '你在一篇文档中被提及',
      actor_uid: 'u-req', actor_name: expect.any(String),
      excerpt: '你暂时没有访问权限，打开文档后可申请访问。', updated_at: expect.any(String),
    })
  })

  it('notifies once per non-reader and never notifies the author', async () => {
    vi.mocked(docMemberRepo.list).mockResolvedValue([])
    expect(await notifyDocMentioned({
      ...mentionParams(), body: '@[user:u_1:Alice] @[user:u_1:Alice] @[user:u-req:Me] @[doc:d2:Private title]',
    })).toBe(1)
    expect(sentMentionCards().map((request) => request.targets)).toEqual([['u_1']])
    expectRedactedCards()
  })

  it.each(['metadata', 'members'])('does not send when %s lookup fails', async (lookup) => {
    if (lookup === 'metadata') vi.mocked(docMetaRepo.getByDocId).mockRejectedValue(new Error('DB unavailable'))
    else vi.mocked(docMemberRepo.list).mockRejectedValue(new Error('DB unavailable'))
    expect(await notifyDocMentioned(mentionParams())).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('notifies the doc owner when mentioned even without a doc_member row', async () => {
    ;(docMemberRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const delivered = await notifyDocMentioned({
      ...mentionParams(),
      body: 'ping @[user:u-owner:Owner]',
    })
    expect(delivered).toBe(1)
    const recipients = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => JSON.parse((c[1] as RequestInit).body as string).targets[0],
    )
    expect(recipients).toEqual(['u-owner'])
    expect(sentMentionCards()[0].docs_card).toMatchObject({ title: 'Test Doc', excerpt: 'ping @Owner' })
  })

  it('on an anyone_in_space doc, notifies all mentioned (server does space-level filtering)', async () => {
    ;(docMetaRepo.getByDocId as ReturnType<typeof vi.fn>).mockResolvedValue({
      doc_id: 'doc-1',
      owner_id: 'u-owner',
      space_id: 'space-1',
      share_scope: 1, // anyone_in_space
      share_role: 1,
    })
    ;(docMemberRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([]) // no member rows needed
    const delivered = await notifyDocMentioned(mentionParams())
    expect(delivered).toBe(2)
    const recipients = (fetch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => JSON.parse((c[1] as RequestInit).body as string).targets[0])
      .sort()
    expect(recipients).toEqual(['u_1', 'u_2'])
    for (const request of sentMentionCards()) {
      expect(request.docs_card).toMatchObject({ title: 'Test Doc', excerpt: 'see this @Alice and @Bob' })
    }
  })

  it('fails closed (notifies no one) when the doc row is missing', async () => {
    ;(docMetaRepo.getByDocId as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    expect(await notifyDocMentioned(mentionParams())).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  // ── P1 regression: fan-out is capped ───────────────────────────────────────
  it.each([0, 1])('caps recipient fan-out at 50 for share scope %i, including redacted cards', async (shareScope) => {
    ;(docMetaRepo.getByDocId as ReturnType<typeof vi.fn>).mockResolvedValue({
      doc_id: 'doc-1',
      owner_id: 'u-owner',
      space_id: 'space-1',
      share_scope: shareScope,
      share_role: 1,
    })
    vi.mocked(docMemberRepo.list).mockResolvedValue([])
    const body = Array.from({ length: 200 }, (_, index) => `@[user:u_${index}:Name${index}]`).join(' ')
    const delivered = await notifyDocMentioned({ ...mentionParams(), body })
    expect(delivered).toBe(50)
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(50)
    if (shareScope === 0) expectRedactedCards()
  })
})
