import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash, createHmac } from 'node:crypto'

// Handler-dependency mocks (hoisted). The vector suite below calls
// verifyOctoSignature with an explicit secret arg, so these do not affect it;
// they only back the handler suite, which reads config.notify.cardActionSecret
// and the domain repos through decideIdempotently.
const { HANDLER_SECRET } = vi.hoisted(() => ({
  HANDLER_SECRET: '0123456789abcdef0123456789abcdef0123', // gitleaks:allow -- 36-byte test-only HMAC key
}))
vi.mock('../src/config/env.js', () => ({
  config: { notify: { cardActionSecret: HANDLER_SECRET } },
}))
vi.mock('../src/db/repos/docCardActionReceiptRepo.js', () => ({
  docCardActionReceiptRepo: {
    claim: vi.fn(async () => true),
    getResponse: vi.fn(async () => null),
    finalize: vi.fn(async () => true),
  },
}))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    getByDocId: vi.fn(async () => ({
      doc_id: 'doc-1',
      space_id: 'space-1',
      document_name: 'dn-1',
      title: 'T',
      status: 1,
      doc_type: 'doc',
    })),
  },
}))
vi.mock('../src/db/repos/docAccessRequestRepo.js', () => ({
  REQUEST_STATUS_PENDING: 1,
  REQUEST_STATUS_APPROVED: 2,
  REQUEST_STATUS_DENIED: 3,
  REQUEST_STATUS_CANCELLED: 4,
  docAccessRequestRepo: {
    getByRequestId: vi.fn(async () => ({ uid: 'req-u', requested_role: 1, status: 1 })),
    decide: vi.fn(async () => true),
  },
}))
vi.mock('../src/permission/resolveRole.js', () => ({ resolveRole: vi.fn(async () => 'admin') }))
vi.mock('../src/api/services/grantForward.js', () => ({
  grantForwardAccess: vi.fn(async () => ({ finalRole: 'reader', changed: true })),
}))
const { mockApproveAccessRequest } = vi.hoisted(() => ({ mockApproveAccessRequest: vi.fn() }))
vi.mock('../src/api/services/approveAccessRequest.js', () => ({
  approveAccessRequest: mockApproveAccessRequest,
}))
vi.mock('../src/api/services/botGrantAudit.js', () => ({
  logBotGrantFailure: vi.fn(),
  logBotGrantSummary: vi.fn(),
}))
const { mockSyncDecisionCards } = vi.hoisted(() => ({ mockSyncDecisionCards: vi.fn(async () => {}) }))
vi.mock('../src/api/services/docsDecisionCardSync.js', () => ({
  syncDecisionCards: mockSyncDecisionCards,
}))

import {
  verifyOctoSignature,
  assertDecisionResultContract,
  cardActionDecideHandler,
  CARD_ACTION_DECIDE_PATH,
} from '../src/api/routes/cardActionDecide.js'
import { logBotGrantFailure, logBotGrantSummary } from '../src/api/services/botGrantAudit.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docAccessRequestRepo } from '../src/db/repos/docAccessRequestRepo.js'
import { docCardActionReceiptRepo } from '../src/db/repos/docCardActionReceiptRepo.js'
import { grantForwardAccess } from '../src/api/services/grantForward.js'

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocId).mockReset().mockResolvedValue({
    doc_id: 'doc-1', space_id: 'space-1', document_name: 'dn-1', title: 'T', status: 1, doc_type: 'doc',
  } as unknown as Awaited<ReturnType<typeof docMetaRepo.getByDocId>>)
  vi.mocked(docAccessRequestRepo.getByRequestId).mockReset().mockResolvedValue({
    uid: 'req-u', principal_space_id: 'space-requester', requested_role: 1, status: 1, bot_uids: [],
  } as unknown as Awaited<ReturnType<typeof docAccessRequestRepo.getByRequestId>>)
  vi.mocked(docAccessRequestRepo.decide).mockReset().mockResolvedValue(true)
  vi.mocked(docCardActionReceiptRepo.claim).mockReset().mockResolvedValue(true)
  vi.mocked(docCardActionReceiptRepo.getResponse).mockReset().mockResolvedValue(null)
  vi.mocked(docCardActionReceiptRepo.finalize).mockReset().mockResolvedValue(true)
  vi.mocked(grantForwardAccess).mockReset().mockResolvedValue({ finalRole: 'reader', changed: true })
  mockApproveAccessRequest.mockReset().mockImplementation(async (params) => {
    const transitioned = await docAccessRequestRepo.decide({
      docId: params.docId,
      requestId: params.requestId,
      status: 2,
      decidedBy: params.decidedBy,
    })
    if (!transitioned) return { transitioned: false }
    const grant = await grantForwardAccess({
      docId: params.docId,
      documentName: params.documentName,
      uid: params.uid,
      principalSpaceId: params.principalSpaceId,
      roleNum: params.roleNum,
      grantedBy: params.decidedBy,
    })
    return { transitioned: true, requesterRole: grant.finalRole }
  })
  mockSyncDecisionCards.mockReset().mockResolvedValue(undefined)
})

describe('callback response contract guard', () => {
  it('rejects unknown top-level keys and display values over 500 runes', () => {
    expect(() => assertDecisionResultContract({ disposition: 'applied', state: 'approved', extra: true }))
      .toThrow('invalid decision result shape')
    expect(() => assertDecisionResultContract({
      disposition: 'applied', state: 'approved', display: { title: '😀'.repeat(501) },
    })).toThrow('invalid decision display value')
    expect(() => assertDecisionResultContract({
      disposition: 'applied', state: 'approved', display: { title: '😀'.repeat(500) },
    })).not.toThrow()
  })

  it('accepts the authoritative decider fields', () => {
    expect(() => assertDecisionResultContract({
      disposition: 'applied', state: 'approved', requester_uid: 'req-u',
      decider_uid: 'admin-A', decider_space_id: 'space-A', decided_at: 1_784_073_600,
      display: { title: 'T' },
    })).not.toThrow()
  })

  it('rejects a malformed decider_space_id / decided_at', () => {
    expect(() => assertDecisionResultContract({
      disposition: 'applied', state: 'approved', decider_space_id: 'space-without-decider',
    })).toThrow('decider_space_id requires decider_uid')
    expect(() => assertDecisionResultContract({
      disposition: 'applied', state: 'approved', decider_space_id: 'x'.repeat(65),
    })).toThrow('invalid decider_space_id')
    expect(() => assertDecisionResultContract({
      disposition: 'applied', state: 'approved', decided_at: -1,
    })).toThrow('invalid decided_at')
    expect(() => assertDecisionResultContract({
      disposition: 'applied', state: 'approved', decided_at: 1.5,
    })).toThrow('invalid decided_at')
  })
})

// Compatible rollout: old signed queued events omitted operator_space_id. Only
// that missing-field shape may use the signed card delivery space_id, and the
// exact derived principal is still revalidated before any transition.
describe('cardActionDecideHandler (legacy missing operator_space_id)', () => {
  it('revalidates (operator_uid, card space_id) and applies when that exact principal is still admin', async () => {
    const { docAccessRequestRepo } = await import('../src/db/repos/docAccessRequestRepo.js')
    const { resolveRole } = await import('../src/permission/resolveRole.js')
    vi.mocked(docAccessRequestRepo.decide).mockClear()
    const eventId = '4200'
    const ts = String(Math.floor(Date.now() / 1000))
    const body = JSON.stringify({
      event_id: eventId, action_id: 'approval-approve', decision: 'approve', operator_uid: 'op-1',
      // operator_space_id deliberately omitted
      inputs: {}, doc_id: 'doc-1', request_id: 'req-1', message_id: 'm-1', channel_id: 'notification',
      channel_type: 1, space_id: 'space-1', acted_at: Number(ts),
    })
    const { req, res } = makeReqRes({
      'X-Octo-Timestamp': ts, 'X-Octo-Event-ID': eventId,
      'X-Octo-Signature': sign(CARD_ACTION_DECIDE_PATH, body, ts, eventId, HANDLER_SECRET),
    }, body)
    await cardActionDecideHandler(req, res as unknown as Parameters<typeof cardActionDecideHandler>[1])
    expect(res.statusCode).toBe(200)
    expect((res.payload as { disposition: string }).disposition).toBe('applied')
    expect(resolveRole).toHaveBeenCalledWith('op-1', 'doc-1', 'space-1')
    expect(mockApproveAccessRequest).toHaveBeenCalledWith(expect.objectContaining({
      decidedBy: 'op-1', decidedBySpaceId: 'space-1',
    }))
  })

  it('forbids an old queued event when the exact legacy principal lost admin', async () => {
    const { docAccessRequestRepo } = await import('../src/db/repos/docAccessRequestRepo.js')
    const { resolveRole } = await import('../src/permission/resolveRole.js')
    vi.mocked(resolveRole).mockResolvedValueOnce('reader')
    vi.mocked(docAccessRequestRepo.decide).mockClear()
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValueOnce({
      uid: 'req-u', principal_space_id: 'space-requester', requested_role: 1, status: 2, bot_uids: [],
      decided_by: 'winner', decided_by_space_id: 'winner-space', decided_at_unix: 789,
    } as unknown as Awaited<ReturnType<typeof docAccessRequestRepo.getByRequestId>>)
    const eventId = '4201'
    const ts = String(Math.floor(Date.now() / 1000))
    const body = JSON.stringify({
      event_id: eventId, action_id: 'approval-approve', decision: 'approve', operator_uid: 'op-1',
      inputs: {}, doc_id: 'doc-1', request_id: 'req-1', message_id: 'm-1', channel_id: 'notification',
      channel_type: 1, space_id: 'space-legacy', acted_at: Number(ts),
    })
    const { req, res } = makeReqRes({
      'X-Octo-Timestamp': ts, 'X-Octo-Event-ID': eventId,
      'X-Octo-Signature': sign(CARD_ACTION_DECIDE_PATH, body, ts, eventId, HANDLER_SECRET),
    }, body)
    await cardActionDecideHandler(req, res as unknown as Parameters<typeof cardActionDecideHandler>[1])
    expect((res.payload as { disposition: string }).disposition).toBe('forbidden')
    expect(res.payload).toEqual(expect.objectContaining({
      state: 'approved', decider_uid: 'winner', decider_space_id: 'winner-space', decided_at: 789,
    }))
    expect(resolveRole).toHaveBeenCalledWith('op-1', 'doc-1', 'space-legacy')
    expect(docAccessRequestRepo.decide).not.toHaveBeenCalled()
  })

  it('does not reinterpret a present-but-invalid operator_space_id as legacy missing', async () => {
    const { docAccessRequestRepo } = await import('../src/db/repos/docAccessRequestRepo.js')
    vi.mocked(docAccessRequestRepo.decide).mockClear()
    const eventId = '4202'
    const ts = String(Math.floor(Date.now() / 1000))
    const body = JSON.stringify({
      event_id: eventId, action_id: 'approval-approve', decision: 'approve', operator_uid: 'op-1',
      operator_space_id: '', inputs: {}, doc_id: 'doc-1', request_id: 'req-1', message_id: 'm-1',
      channel_id: 'notification', channel_type: 1, space_id: 'space-legacy', acted_at: Number(ts),
    })
    const { req, res } = makeReqRes({
      'X-Octo-Timestamp': ts, 'X-Octo-Event-ID': eventId,
      'X-Octo-Signature': sign(CARD_ACTION_DECIDE_PATH, body, ts, eventId, HANDLER_SECRET),
    }, body)
    await cardActionDecideHandler(req, res as unknown as Parameters<typeof cardActionDecideHandler>[1])
    expect((res.payload as { disposition: string }).disposition).toBe('forbidden')
    expect(res.payload).not.toHaveProperty('decider_uid')
    expect(res.payload).not.toHaveProperty('decider_space_id')
    expect(docAccessRequestRepo.decide).not.toHaveBeenCalled()
  })
})

// The language-neutral test vector from octo-server
// docs/card-action-callback-consumer.md. Validates our HMAC canonical
// construction byte-for-byte against the authoritative producer.
const VECTOR = {
  secret: '0123456789abcdef0123456789abcdef', // 32 bytes // gitleaks:allow -- non-secret HMAC test vector from octo-server docs
  path: '/v1/card-actions/decide',
  timestamp: '1784073600',
  eventId: '9007199254740993',
  body: '{"event_id":"9007199254740993","action_id":"approval-execute","decision":"execute","operator_uid":"user-b","inputs":{},"data":{"owner":"tasks","action_type":"task.execute.decision","decision":"execute","task_id":"task-1"},"message_id":"190001234567890","channel_id":"notification","channel_type":1,"space_id":"space-1","acted_at":1784073600}',
  signature: 'v1=77d6abe3e80bd90d70545ce90d8c87daafd65a22b62919cee71b450613d6e50f',
}
// Pin "now" to the vector timestamp so the freshness gate passes (skew 0).
const AT = Number(VECTOR.timestamp)

function verify(overrides: Partial<{ body: Buffer; path: string; timestamp: string; eventId: string; signature: string; secret: string; now: number }> = {}) {
  return verifyOctoSignature(
    overrides.body ?? Buffer.from(VECTOR.body, 'utf8'),
    overrides.path ?? VECTOR.path,
    overrides.timestamp ?? VECTOR.timestamp,
    overrides.eventId ?? VECTOR.eventId,
    overrides.signature ?? VECTOR.signature,
    overrides.secret ?? VECTOR.secret,
    overrides.now ?? AT,
  )
}

describe('verifyOctoSignature (official test vector)', () => {
  it('accepts the exact vector', () => {
    expect(verify()).toBe(true)
  })
  it('rejects a one-byte body mutation', () => {
    expect(verify({ body: Buffer.from(VECTOR.body.replace('user-b', 'user-c'), 'utf8') })).toBe(false)
  })
  it('rejects a stale timestamp (outside 5-min window)', () => {
    expect(verify({ now: AT + 301 })).toBe(false)
    expect(verify({ now: AT - 301 })).toBe(false)
  })
  it('accepts within the freshness window', () => {
    expect(verify({ now: AT + 299 })).toBe(true)
  })
  it('rejects a tampered path / timestamp / event_id (canonical binding)', () => {
    expect(verify({ path: '/v1/card-actions/decide2' })).toBe(false)
    expect(verify({ timestamp: '1784073601' })).toBe(false)
    expect(verify({ eventId: '9007199254740994' })).toBe(false)
  })
  it('rejects malformed signature / short secret / bad event_id shape', () => {
    expect(verify({ signature: 'v1=deadbeef' })).toBe(false)
    expect(verify({ signature: '77d6abe3e80bd90d70545ce90d8c87daafd65a22b62919cee71b450613d6e50f' })).toBe(false)
    expect(verify({ secret: 'tooshort' })).toBe(false)
    expect(verify({ eventId: '0abc' })).toBe(false)
  })
})

// Handler suite (blocker 1): the vector suite above proves canonical-format
// parity but signs+verifies the SAME literal path, never exercising the handler
// with its production constant. These tests sign over CARD_ACTION_DECIDE_PATH
// and drive the real handler, proving octo-server↔handler agree ONLY when the
// signed path equals the production constant — a mismatch (e.g. a stray `/api`)
// would surface here as a 401 instead of hiding behind a self-referential test.
function sign(path: string, body: string, timestamp: string, eventId: string, secret: string): string {
  const bodyHash = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex')
  const canonical = ['v1', 'POST', path, timestamp, eventId, bodyHash].join('\n')
  return 'v1=' + createHmac('sha256', secret).update(canonical).digest('hex')
}

function makeReqRes(headers: Record<string, string>, body: string) {
  const req = {
    body: Buffer.from(body, 'utf8'),
    header: (k: string) => headers[k],
  } as unknown as Parameters<typeof cardActionDecideHandler>[0]
  const res = {
    statusCode: 0,
    payload: undefined as unknown,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.payload = b
      return this
    },
  }
  return { req, res }
}

describe('cardActionDecideHandler (production path consistency)', () => {
  const eventId = '4001'
  const ts = String(Math.floor(Date.now() / 1000))
  const body = JSON.stringify({
    event_id: eventId,
    action_id: 'approval-approve',
    decision: 'approve',
    operator_uid: 'op-1', operator_space_id: 'space-op',
    inputs: {},
    data: { owner: 'docs', action_type: 'access_request.decision', doc_id: 'doc-1', request_id: 'req-1' },
    doc_id: 'doc-1',
    request_id: 'req-1',
    message_id: 'm-1',
    channel_id: 'notification',
    channel_type: 1,
    space_id: 'space-1',
    acted_at: Number(ts),
  })

  it('accepts a signature computed over CARD_ACTION_DECIDE_PATH and applies the decision', async () => {
    const sig = sign(CARD_ACTION_DECIDE_PATH, body, ts, eventId, HANDLER_SECRET)
    const { req, res } = makeReqRes(
      { 'X-Octo-Timestamp': ts, 'X-Octo-Event-ID': eventId, 'X-Octo-Signature': sig },
      body,
    )
    await cardActionDecideHandler(req, res as unknown as Parameters<typeof cardActionDecideHandler>[1])
    expect(res.statusCode).toBe(200)
    expect((res.payload as { disposition: string }).disposition).toBe('applied')
  })

  it('401s when the signature is computed over a different path than the handler verifies', async () => {
    const sig = sign('/v1/card-actions/decide', body, ts, eventId, HANDLER_SECRET) // wrong (no /api)
    const { req, res } = makeReqRes(
      { 'X-Octo-Timestamp': ts, 'X-Octo-Event-ID': eventId, 'X-Octo-Signature': sig },
      body,
    )
    await cardActionDecideHandler(req, res as unknown as Parameters<typeof cardActionDecideHandler>[1])
    expect(res.statusCode).toBe(401)
  })
})

// Review blocker (archived-doc bypass): the normal HTTP approve route rejects an
// archived doc (status===2) with 409 via requireDocRole BEFORE granting. The
// signed callback must not be a weaker path that still grants. These drive the
// real handler with a valid signature against an archived doc and assert the
// decision is a `conflict` with NO grant — closing the "callback bypasses the
// archived gate" hole.
describe('cardActionDecideHandler (archived-doc guard)', () => {
  const eventId = '4002'
  const ts = String(Math.floor(Date.now() / 1000))
  const body = JSON.stringify({
    event_id: eventId,
    action_id: 'approval-approve',
    decision: 'approve',
    operator_uid: 'op-1', operator_space_id: 'space-op',
    inputs: {},
    data: { owner: 'docs', action_type: 'access_request.decision', doc_id: 'doc-1', request_id: 'req-1' },
    doc_id: 'doc-1',
    request_id: 'req-1',
    message_id: 'm-1',
    channel_id: 'notification',
    channel_type: 1,
    space_id: 'space-1',
    acted_at: Number(ts),
  })

  it('reports conflict and grants nothing when the doc is archived (status===2)', async () => {
    const { docMetaRepo } = await import('../src/db/repos/docMetaRepo.js')
    const { docAccessRequestRepo } = await import('../src/db/repos/docAccessRequestRepo.js')
    const { grantForwardAccess } = await import('../src/api/services/grantForward.js')
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValueOnce({
      doc_id: 'doc-1',
      space_id: 'space-1',
      document_name: 'dn-1',
      title: 'T',
      status: 2, // archived
    } as unknown as Awaited<ReturnType<typeof docMetaRepo.getByDocId>>)
    vi.mocked(grantForwardAccess).mockClear()
    vi.mocked(docAccessRequestRepo.decide).mockClear()
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValueOnce({
      uid: 'req-u', requested_role: 1, status: 2,
      decided_by: 'winner', decided_by_space_id: 'winner-space', decided_at_unix: 123,
    } as unknown as Awaited<ReturnType<typeof docAccessRequestRepo.getByRequestId>>)

    const sig = sign(CARD_ACTION_DECIDE_PATH, body, ts, eventId, HANDLER_SECRET)
    const { req, res } = makeReqRes(
      { 'X-Octo-Timestamp': ts, 'X-Octo-Event-ID': eventId, 'X-Octo-Signature': sig },
      body,
    )
    await cardActionDecideHandler(req, res as unknown as Parameters<typeof cardActionDecideHandler>[1])
    expect(res.statusCode).toBe(200)
    expect((res.payload as { disposition: string }).disposition).toBe('conflict')
    expect(res.payload).toEqual(expect.objectContaining({
      state: 'approved', decider_uid: 'winner', decider_space_id: 'winner-space', decided_at: 123,
    }))
    // The archived gate must short-circuit BEFORE any status transition or grant.
    expect(grantForwardAccess).not.toHaveBeenCalled()
    expect(docAccessRequestRepo.decide).not.toHaveBeenCalled()
  })
})

describe('cardActionDecideHandler (commenter on every document type)', () => {
  it('decides and grants a commenter request for a non-HTML document', async () => {
    const { docMetaRepo } = await import('../src/db/repos/docMetaRepo.js')
    const { docAccessRequestRepo } = await import('../src/db/repos/docAccessRequestRepo.js')
    const { grantForwardAccess } = await import('../src/api/services/grantForward.js')
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValueOnce({
      doc_id: 'doc-1', space_id: 'space-1', document_name: 'dn-1', title: 'T', status: 1, doc_type: 'doc',
    } as unknown as Awaited<ReturnType<typeof docMetaRepo.getByDocId>>)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValueOnce({
      uid: 'req-u', requested_role: 4, status: 1,
    } as unknown as Awaited<ReturnType<typeof docAccessRequestRepo.getByRequestId>>)
    vi.mocked(docAccessRequestRepo.decide).mockClear()
    vi.mocked(grantForwardAccess).mockClear()
    const eventId = '4020'
    const ts = String(Math.floor(Date.now() / 1000))
    const body = JSON.stringify({
      event_id: eventId, action_id: 'approval-approve', decision: 'approve', operator_uid: 'op-1', operator_space_id: 'space-op',
      inputs: {}, doc_id: 'doc-1', request_id: 'req-1', message_id: 'm-1', channel_id: 'notification',
      channel_type: 1, space_id: 'space-1', acted_at: Number(ts),
    })
    const { req, res } = makeReqRes({
      'X-Octo-Timestamp': ts, 'X-Octo-Event-ID': eventId,
      'X-Octo-Signature': sign(CARD_ACTION_DECIDE_PATH, body, ts, eventId, HANDLER_SECRET),
    }, body)
    await cardActionDecideHandler(req, res as unknown as Parameters<typeof cardActionDecideHandler>[1])
    expect((res.payload as { disposition: string }).disposition).toBe('applied')
    expect(docAccessRequestRepo.decide).toHaveBeenCalled()
    expect(grantForwardAccess).toHaveBeenCalledWith(expect.objectContaining({ roleNum: 4 }))
  })
})

describe('cardActionDecideHandler (historical admin access request)', () => {
  it('rejects a stored admin request without granting', async () => {
    const { docMetaRepo } = await import('../src/db/repos/docMetaRepo.js')
    const { docAccessRequestRepo } = await import('../src/db/repos/docAccessRequestRepo.js')
    const { grantForwardAccess } = await import('../src/api/services/grantForward.js')
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValueOnce({
      doc_id: 'doc-1', space_id: 'space-1', document_name: 'dn-1', title: 'T', status: 1,
    } as unknown as Awaited<ReturnType<typeof docMetaRepo.getByDocId>>)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValueOnce({
      uid: 'req-u', principal_space_id: 'space-requester', requested_role: 3, status: 3, bot_uids: [],
      decided_by: 'winner', decided_by_space_id: 'winner-space', decided_at_unix: 456,
    } as unknown as Awaited<ReturnType<typeof docAccessRequestRepo.getByRequestId>>)
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValueOnce(true)
    vi.mocked(grantForwardAccess).mockClear()
    vi.mocked(grantForwardAccess).mockResolvedValue({ finalRole: 'admin', changed: true })
    const eventId = '4021'
    const ts = String(Math.floor(Date.now() / 1000))
    const body = JSON.stringify({
      event_id: eventId, action_id: 'approval-approve', decision: 'approve', operator_uid: 'op-1', operator_space_id: 'space-op',
      inputs: {}, doc_id: 'doc-1', request_id: 'req-1', message_id: 'm-1', channel_id: 'notification',
      channel_type: 1, space_id: 'space-1', acted_at: Number(ts),
    })
    const { req, res } = makeReqRes({
      'X-Octo-Timestamp': ts, 'X-Octo-Event-ID': eventId,
      'X-Octo-Signature': sign(CARD_ACTION_DECIDE_PATH, body, ts, eventId, HANDLER_SECRET),
    }, body)

    await cardActionDecideHandler(req, res as unknown as Parameters<typeof cardActionDecideHandler>[1])

    expect((res.payload as { disposition: string }).disposition).toBe('conflict')
    expect(res.payload).toEqual(expect.objectContaining({
      state: 'denied', decider_uid: 'winner', decider_space_id: 'winner-space', decided_at: 456,
    }))
    expect(grantForwardAccess).not.toHaveBeenCalled()
  })
})

// Review blocker (Jerry-Xin / yujiawei / lml2468 P1): the grant side-effect must
// be gated on the decide() CAS win (transitioned===true), NOT on claim ownership.
// The pending→terminal CAS admits exactly one grantor per request across every
// delivery/event, so a foreign event OR a concurrent in-flight sibling of the same
// event that loses the CAS must grant nothing — otherwise a stale higher
// requested_role (left by an HTTP route approving at a LOWER role) escalates the
// member past the admin's explicit downgrade. These cases pin that invariant.
describe('cardActionDecideHandler (grant gated on decide() CAS, not claim)', () => {
  const eventId = '4003'
  const ts = String(Math.floor(Date.now() / 1000))
  const body = JSON.stringify({
    event_id: eventId,
    action_id: 'approval-approve',
    decision: 'approve',
    operator_uid: 'op-1', operator_space_id: 'space-op',
    inputs: {},
    data: { owner: 'docs', action_type: 'access_request.decision', doc_id: 'doc-1', request_id: 'req-1' },
    doc_id: 'doc-1',
    request_id: 'req-1',
    message_id: 'm-1',
    channel_id: 'notification',
    channel_type: 1,
    space_id: 'space-1',
    acted_at: Number(ts),
  })

  const resetRequestMock = async () => {
    const { docAccessRequestRepo } = await import('../src/db/repos/docAccessRequestRepo.js')
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue({
      uid: 'req-u',
      requested_role: 1,
      status: 1,
    } as unknown as Awaited<ReturnType<typeof docAccessRequestRepo.getByRequestId>>)
  }

  it('grants nothing for a FRESH event on an already-approved request (stale requested_role, no escalation)', async () => {
    const { docAccessRequestRepo, REQUEST_STATUS_APPROVED } = await import('../src/db/repos/docAccessRequestRepo.js')
    const { docCardActionReceiptRepo } = await import('../src/db/repos/docCardActionReceiptRepo.js')
    const { grantForwardAccess } = await import('../src/api/services/grantForward.js')
    // Fresh event: claim() wins. Row already APPROVED (via HTTP route, at a lower
    // role) but still carries a stale writer requested_role.
    vi.mocked(docCardActionReceiptRepo.claim).mockResolvedValueOnce(true)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue({
      uid: 'req-u',
      requested_role: 3, // stale admin
      status: REQUEST_STATUS_APPROVED,
    } as unknown as Awaited<ReturnType<typeof docAccessRequestRepo.getByRequestId>>)
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValueOnce(false) // CAS loses
    vi.mocked(grantForwardAccess).mockClear()

    const sig = sign(CARD_ACTION_DECIDE_PATH, body, ts, eventId, HANDLER_SECRET)
    const { req, res } = makeReqRes(
      { 'X-Octo-Timestamp': ts, 'X-Octo-Event-ID': eventId, 'X-Octo-Signature': sig },
      body,
    )
    await cardActionDecideHandler(req, res as unknown as Parameters<typeof cardActionDecideHandler>[1])
    expect(res.statusCode).toBe(200)
    // Historical admin requests are no longer grantable; the callback reports a conflict and
    // never re-grants the stale role.
    expect((res.payload as { disposition: string }).disposition).toBe('conflict')
    expect(grantForwardAccess).not.toHaveBeenCalled()
    await resetRequestMock()
  })

  it('persists the reviewer deny reason (inputs.deny_reason) via decide().note', async () => {
    const { docAccessRequestRepo, REQUEST_STATUS_DENIED } = await import('../src/db/repos/docAccessRequestRepo.js')
    const denyBody = JSON.stringify({
      event_id: '4010',
      action_id: 'approval-deny',
      decision: 'deny',
      operator_uid: 'op-1', operator_space_id: 'space-op',
      inputs: { deny_reason: '  范围不符，请对齐后再申请  ' }, // whitespace trimmed on store
      data: { owner: 'docs', action_type: 'access_request.decision', doc_id: 'doc-1', request_id: 'req-1' },
      doc_id: 'doc-1',
      request_id: 'req-1',
      message_id: 'm-1',
      channel_id: 'notification',
      channel_type: 1,
      space_id: 'space-1',
      acted_at: Number(ts),
    })
    await resetRequestMock()
    vi.mocked(docAccessRequestRepo.decide).mockClear()
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValueOnce(true)

    const sig = sign(CARD_ACTION_DECIDE_PATH, denyBody, ts, '4010', HANDLER_SECRET)
    const { req, res } = makeReqRes(
      { 'X-Octo-Timestamp': ts, 'X-Octo-Event-ID': '4010', 'X-Octo-Signature': sig },
      denyBody,
    )
    await cardActionDecideHandler(req, res as unknown as Parameters<typeof cardActionDecideHandler>[1])

    expect(res.statusCode).toBe(200)
    expect(docAccessRequestRepo.decide).toHaveBeenCalledWith(
      expect.objectContaining({ status: REQUEST_STATUS_DENIED, note: '范围不符，请对齐后再申请' }),
    )
    await resetRequestMock()
  })


  it('CONCURRENT claim-loser (isOwnEventRecovery-style) on an already-approved request grants NOTHING', async () => {
    // The exact interleaving lml2468 reported: same event_id, sibling delivery B
    // loses claim() (A holds it, not yet finalized) → getResponse()=null → B
    // re-executes computeDecision. The row was flipped to APPROVED by the HTTP
    // route at a LOWER role, so requested_role is a stale writer. Under the OLD
    // `isOwnEventRecovery = !claimed` gate this fell through and granted writer.
    // Now the grant is gated on decide()'s CAS, which B loses → no grant.
    const { docAccessRequestRepo, REQUEST_STATUS_APPROVED } = await import('../src/db/repos/docAccessRequestRepo.js')
    const { docCardActionReceiptRepo } = await import('../src/db/repos/docCardActionReceiptRepo.js')
    const { grantForwardAccess } = await import('../src/api/services/grantForward.js')
    vi.mocked(docCardActionReceiptRepo.claim).mockResolvedValueOnce(false) // lost claim
    vi.mocked(docCardActionReceiptRepo.getResponse).mockResolvedValueOnce(null) // sibling not finalized
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue({
      uid: 'req-u',
      requested_role: 3, // stale admin left by the HTTP lower-role approve
      status: REQUEST_STATUS_APPROVED,
    } as unknown as Awaited<ReturnType<typeof docAccessRequestRepo.getByRequestId>>)
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValueOnce(false) // CAS loses (already approved)
    vi.mocked(grantForwardAccess).mockClear()

    const sig = sign(CARD_ACTION_DECIDE_PATH, body, ts, eventId, HANDLER_SECRET)
    const { req, res } = makeReqRes(
      { 'X-Octo-Timestamp': ts, 'X-Octo-Event-ID': eventId, 'X-Octo-Signature': sig },
      body,
    )
    await cardActionDecideHandler(req, res as unknown as Parameters<typeof cardActionDecideHandler>[1])
    expect(res.statusCode).toBe(200)
    // No escalation: the claim-loser must not grant the stale writer role.
    expect(grantForwardAccess).not.toHaveBeenCalled()
    await resetRequestMock()
  })

  it('grants exactly once for the sole decider whose decide() CAS wins (transitioned)', async () => {
    const { docAccessRequestRepo } = await import('../src/db/repos/docAccessRequestRepo.js')
    const { docCardActionReceiptRepo } = await import('../src/db/repos/docCardActionReceiptRepo.js')
    const { grantForwardAccess } = await import('../src/api/services/grantForward.js')
    vi.mocked(docCardActionReceiptRepo.claim).mockResolvedValueOnce(true)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue({
      uid: 'req-u',
      requested_role: 1,
      status: 1, // pending
    } as unknown as Awaited<ReturnType<typeof docAccessRequestRepo.getByRequestId>>)
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValueOnce(true) // CAS WINS
    vi.mocked(grantForwardAccess).mockClear()

    const sig = sign(CARD_ACTION_DECIDE_PATH, body, ts, eventId, HANDLER_SECRET)
    const { req, res } = makeReqRes(
      { 'X-Octo-Timestamp': ts, 'X-Octo-Event-ID': eventId, 'X-Octo-Signature': sig },
      body,
    )
    await cardActionDecideHandler(req, res as unknown as Parameters<typeof cardActionDecideHandler>[1])
    expect(res.statusCode).toBe(200)
    expect((res.payload as { disposition: string }).disposition).toBe('applied')
    expect(grantForwardAccess).toHaveBeenCalledTimes(1) // the decider grants, once
    await resetRequestMock()
  })
})

// Invariant: a duplicate/concurrent click on an already-decided request must
// report the ACTUAL persisted decider on the result, never the late caller. Admin
// A truly decided (won the CAS); admin B then taps the same not-yet-synced card,
// loses the pending CAS, and lands in the report-only branch. B's response must
// carry A's persisted decider uid / Space / time, not B's — otherwise a repeat
// submit rewrites the card to show the wrong approver. docs resolves NO names.
describe('cardActionDecideHandler (duplicate same-terminal callback → real decider)', () => {
  const eventId = '4020'
  const ts = String(Math.floor(Date.now() / 1000))
  const body = JSON.stringify({
    event_id: eventId,
    action_id: 'approval-approve',
    decision: 'approve',
    operator_uid: 'admin-B', // the LATE duplicate clicker
    operator_space_id: 'space-B', // the late clicker's own Space — must NOT appear in the response
    inputs: {},
    data: { owner: 'docs', action_type: 'access_request.decision', doc_id: 'doc-1', request_id: 'req-1' },
    doc_id: 'doc-1',
    request_id: 'req-1',
    message_id: 'm-1',
    channel_id: 'notification',
    channel_type: 1,
    space_id: 'space-1',
    acted_at: Number(ts),
  })

  // Restoration belongs here, NOT at the end of an `it` body: these blocks set
  // `getByRequestId` with mockResolvedValue (not …Once), so if an assertion above
  // ever fails, in-body cleanup never runs and every later block inherits an
  // always-approved row — failing for unrelated reasons, or silently exercising
  // the duplicate branch.
  afterEach(async () => {
    const { docAccessRequestRepo } = await import('../src/db/repos/docAccessRequestRepo.js')
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue({
      uid: 'req-u',
      requested_role: 1,
      status: 1,
    } as unknown as Awaited<ReturnType<typeof docAccessRequestRepo.getByRequestId>>)
  })

  it('reports the PERSISTED decider (admin-A / its Space / its time), never the late clicker (admin-B)', async () => {
    const { docAccessRequestRepo, REQUEST_STATUS_APPROVED } = await import('../src/db/repos/docAccessRequestRepo.js')
    const { docCardActionReceiptRepo } = await import('../src/db/repos/docCardActionReceiptRepo.js')
    const { docMetaRepo } = await import('../src/db/repos/docMetaRepo.js')
    vi.mocked(docCardActionReceiptRepo.claim).mockResolvedValueOnce(true)
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValueOnce({
      doc_id: 'doc-1',
      space_id: 'space-1',
      document_name: 'dn-1',
      title: 'T',
      status: 1,
    } as unknown as Awaited<ReturnType<typeof docMetaRepo.getByDocId>>)
    // Row already APPROVED by admin-A from admin-A's Space at a fixed time; B's CAS loses.
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue({
      uid: 'req-u',
      requested_role: 1,
      status: REQUEST_STATUS_APPROVED,
      decided_by: 'admin-A',
      decided_by_space_id: 'space-A',
      decided_at_unix: 1_784_073_600,
    } as unknown as Awaited<ReturnType<typeof docAccessRequestRepo.getByRequestId>>)
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValueOnce(false) // B loses the pending CAS

    const sig = sign(CARD_ACTION_DECIDE_PATH, body, ts, eventId, HANDLER_SECRET)
    const { req, res } = makeReqRes(
      { 'X-Octo-Timestamp': ts, 'X-Octo-Event-ID': eventId, 'X-Octo-Signature': sig },
      body,
    )
    await cardActionDecideHandler(req, res as unknown as Parameters<typeof cardActionDecideHandler>[1])

    expect(res.statusCode).toBe(200)
    const payload = res.payload as {
      decider_uid?: string; decider_space_id?: string; decided_at?: number; display?: Record<string, string>
    }
    expect(payload.decider_uid).toBe('admin-A') // the real decider
    expect(payload.decider_uid).not.toBe('admin-B') // never the late clicker
    expect(payload.decider_space_id).toBe('space-A') // A's persisted Space, not B's 'space-B'
    expect(payload.decided_at).toBe(1_784_073_600) // A's persisted decision time
    // display stays title-only — docs never resolves a name here.
    expect(payload.display).toEqual({ title: 'T' })
  })

  it('degrades a legacy persisted decider that lacks a Space/time (omits, never guesses)', async () => {
    const { docAccessRequestRepo, REQUEST_STATUS_APPROVED } = await import('../src/db/repos/docAccessRequestRepo.js')
    const { docCardActionReceiptRepo } = await import('../src/db/repos/docCardActionReceiptRepo.js')
    const { docMetaRepo } = await import('../src/db/repos/docMetaRepo.js')
    vi.mocked(docCardActionReceiptRepo.claim).mockResolvedValueOnce(true)
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValueOnce({
      doc_id: 'doc-1', space_id: 'space-1', document_name: 'dn-1', title: 'T', status: 1,
    } as unknown as Awaited<ReturnType<typeof docMetaRepo.getByDocId>>)
    // Legacy row: decided_by present, but decided_by_space_id '' and decided_at_unix null.
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue({
      uid: 'req-u',
      requested_role: 1,
      status: REQUEST_STATUS_APPROVED,
      decided_by: 'admin-A',
      decided_by_space_id: '',
      decided_at_unix: null,
    } as unknown as Awaited<ReturnType<typeof docAccessRequestRepo.getByRequestId>>)
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValueOnce(false)

    const sig = sign(CARD_ACTION_DECIDE_PATH, body, ts, eventId, HANDLER_SECRET)
    const { req, res } = makeReqRes(
      { 'X-Octo-Timestamp': ts, 'X-Octo-Event-ID': eventId, 'X-Octo-Signature': sig },
      body,
    )
    await cardActionDecideHandler(req, res as unknown as Parameters<typeof cardActionDecideHandler>[1])

    expect(res.statusCode).toBe(200)
    const payload = res.payload as Record<string, unknown>
    expect(payload.decider_uid).toBe('admin-A') // still the persisted decider uid
    // No Space / time to attribute — omitted, never guessed from doc/card/default.
    expect(payload).not.toHaveProperty('decider_space_id')
    expect(payload).not.toHaveProperty('decided_at')
  })

  it('reports the CAS-winning decider IDs on the primary path (winner is admin-B)', async () => {
    const { docAccessRequestRepo, REQUEST_STATUS_PENDING } = await import('../src/db/repos/docAccessRequestRepo.js')
    const { docCardActionReceiptRepo } = await import('../src/db/repos/docCardActionReceiptRepo.js')
    const { docMetaRepo } = await import('../src/db/repos/docMetaRepo.js')
    vi.mocked(docCardActionReceiptRepo.claim).mockResolvedValueOnce(true)
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValueOnce({
      doc_id: 'doc-1',
      space_id: 'space-1',
      document_name: 'dn-1',
      title: 'T',
      status: 1,
    } as unknown as Awaited<ReturnType<typeof docMetaRepo.getByDocId>>)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValueOnce({
      uid: 'req-u',
      requested_role: 1,
      status: REQUEST_STATUS_PENDING,
    } as unknown as Awaited<ReturnType<typeof docAccessRequestRepo.getByRequestId>>)
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValueOnce(true) // this caller IS the decider

    const sig = sign(CARD_ACTION_DECIDE_PATH, body, ts, eventId, HANDLER_SECRET)
    const { req, res } = makeReqRes(
      { 'X-Octo-Timestamp': ts, 'X-Octo-Event-ID': eventId, 'X-Octo-Signature': sig },
      body,
    )
    await cardActionDecideHandler(req, res as unknown as Parameters<typeof cardActionDecideHandler>[1])

    expect(res.statusCode).toBe(200)
    const payload = res.payload as { decider_uid?: string; decider_space_id?: string; decided_at?: number }
    // The winner's own operator_uid / operator_space_id / acted_at are authoritative here.
    expect(payload.decider_uid).toBe('admin-B')
    expect(payload.decider_space_id).toBe('space-B')
    expect(payload.decided_at).toBe(Number(ts))
    expect(mockSyncDecisionCards).toHaveBeenCalledWith(expect.objectContaining({
      deciderUid: 'admin-B',
      deciderSpaceId: 'space-B',
      clickedCardSpaceId: 'space-1', // card delivery/origin, distinct from operator Space
      deciderCardHandledExternally: true,
    }))
  })
})

describe('cardActionDecideHandler (finalized receipt compatibility)', () => {
  it('replays an already-finalized legacy forbidden result without reauthorization or grant', async () => {
    const { resolveRole } = await import('../src/permission/resolveRole.js')
    vi.mocked(resolveRole).mockClear()
    vi.mocked(docCardActionReceiptRepo.claim).mockResolvedValueOnce(false)
    vi.mocked(docCardActionReceiptRepo.getResponse).mockResolvedValueOnce(JSON.stringify({
      disposition: 'forbidden', state: 'pending', requester_uid: 'req-u',
    }))
    const eventId = '4299'
    const ts = String(Math.floor(Date.now() / 1000))
    const body = JSON.stringify({
      event_id: eventId, action_id: 'approval-approve', decision: 'approve', operator_uid: 'op-1',
      inputs: {}, doc_id: 'doc-1', request_id: 'req-1', message_id: 'm-1', channel_id: 'notification',
      channel_type: 1, space_id: 'space-legacy', acted_at: Number(ts),
    })
    const { req, res } = makeReqRes({
      'X-Octo-Timestamp': ts, 'X-Octo-Event-ID': eventId,
      'X-Octo-Signature': sign(CARD_ACTION_DECIDE_PATH, body, ts, eventId, HANDLER_SECRET),
    }, body)
    await cardActionDecideHandler(req, res as unknown as Parameters<typeof cardActionDecideHandler>[1])
    expect(res.payload).toEqual({ disposition: 'forbidden', state: 'pending', requester_uid: 'req-u' })
    expect(resolveRole).not.toHaveBeenCalled()
    expect(mockApproveAccessRequest).not.toHaveBeenCalled()
  })
})

// User-bot grants: an approve callback grants the requester AND each bot in the
// request's stored snapshot the same role, via the shared grant core. Per-bot
// failures are isolated (the approval still stands); a replay/duplicate that
// loses the decide() CAS grants nothing. Zero-bot requests keep the legacy path.
describe('cardActionDecideHandler (carried Space-bot snapshot grants)', () => {
  const ts = String(Math.floor(Date.now() / 1000))
  const bodyFor = (eventId: string) =>
    JSON.stringify({
      event_id: eventId,
      action_id: 'approval-approve',
      decision: 'approve',
      operator_uid: 'op-1', operator_space_id: 'space-op',
      inputs: {},
      data: { owner: 'docs', action_type: 'access_request.decision', doc_id: 'doc-1', request_id: 'req-1' },
      doc_id: 'doc-1',
      request_id: 'req-1',
      message_id: 'm-1',
      channel_id: 'notification',
      channel_type: 1,
      space_id: 'space-1',
      acted_at: Number(ts),
    })

  async function drive(eventId: string) {
    const body = bodyFor(eventId)
    const sig = sign(CARD_ACTION_DECIDE_PATH, body, ts, eventId, HANDLER_SECRET)
    const { req, res } = makeReqRes(
      { 'X-Octo-Timestamp': ts, 'X-Octo-Event-ID': eventId, 'X-Octo-Signature': sig },
      body,
    )
    await cardActionDecideHandler(req, res as unknown as Parameters<typeof cardActionDecideHandler>[1])
    return res
  }

  it('grants the requester and every snapshotted bot the requested role', async () => {
    const { docAccessRequestRepo } = await import('../src/db/repos/docAccessRequestRepo.js')
    const { grantForwardAccess } = await import('../src/api/services/grantForward.js')
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValueOnce({
      uid: 'req-u', principal_space_id: 'space-requester', requested_role: 2, status: 1,
      bot_uids: ['bot_a', 'bot_b'],
    } as unknown as Awaited<ReturnType<typeof docAccessRequestRepo.getByRequestId>>)
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValueOnce(true)
    vi.mocked(grantForwardAccess).mockClear()
    vi.mocked(grantForwardAccess).mockResolvedValue({ finalRole: 'writer', changed: true })

    const res = await drive('4100')
    expect(res.statusCode).toBe(200)
    const payload = res.payload as Record<string, unknown>
    expect(payload.disposition).toBe('applied')
    expect(Object.keys(payload).sort()).toEqual(['decided_at', 'decider_space_id', 'decider_uid', 'display', 'disposition', 'requester_uid', 'state'])
    // Card approval uses the same split principal contract as REST approval.
    expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledTimes(3)
    expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledWith(expect.objectContaining({
      uid: 'req-u', principalSpaceId: 'space-requester', roleNum: 2,
    }))
    for (const uid of ['bot_a', 'bot_b']) {
      expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledWith(expect.objectContaining({
        uid, principalSpaceId: 'space-requester', roleNum: 2,
      }))
    }
  })

  it('partial failure: a failing bot grant does not fail the callback (still applied)', async () => {
    const { docAccessRequestRepo } = await import('../src/db/repos/docAccessRequestRepo.js')
    const { grantForwardAccess } = await import('../src/api/services/grantForward.js')
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValueOnce({
      uid: 'req-u', requested_role: 2, status: 1, bot_uids: ['bot_ok', 'bot_bad'],
    } as unknown as Awaited<ReturnType<typeof docAccessRequestRepo.getByRequestId>>)
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValueOnce(true)
    vi.mocked(grantForwardAccess).mockReset()
    vi.mocked(grantForwardAccess).mockImplementation(async (p: { uid: string }) => {
      if (p.uid === 'bot_bad') throw new Error('transient')
      return { finalRole: 'writer', changed: true }
    })

    const res = await drive('4101')
    expect(res.statusCode).toBe(200)
    const payload = res.payload as Record<string, unknown>
    expect(payload.disposition).toBe('applied')
    expect(Object.keys(payload).sort()).toEqual(['decided_at', 'decider_space_id', 'decider_uid', 'display', 'disposition', 'requester_uid', 'state'])
    expect(payload).not.toHaveProperty('botGrantResult')
    expect(payload).not.toHaveProperty('bot_summary')
    expect(vi.mocked(logBotGrantFailure)).toHaveBeenCalledWith(expect.objectContaining({
      docId: 'doc-1', requestId: 'req-1', botUid: 'bot_bad',
    }))
    expect(vi.mocked(logBotGrantSummary)).toHaveBeenCalledWith({
      source: 'card_callback',
      docId: 'doc-1',
      requestId: 'req-1',
      result: { requesterRole: 'writer', botsSucceeded: ['bot_ok'], botsFailed: ['bot_bad'] },
    })
  })

  it('a lost decide() CAS (replay/duplicate) grants NO bot', async () => {
    const { docAccessRequestRepo } = await import('../src/db/repos/docAccessRequestRepo.js')
    const { docCardActionReceiptRepo } = await import('../src/db/repos/docCardActionReceiptRepo.js')
    const { grantForwardAccess } = await import('../src/api/services/grantForward.js')
    // Fresh claim so we execute computeDecision, but the row is already approved
    // and decide() reports no transition => report-only, no grant.
    vi.mocked(docCardActionReceiptRepo.claim).mockResolvedValueOnce(true)
    vi.mocked(docCardActionReceiptRepo.getResponse).mockResolvedValueOnce(null)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValueOnce({
      uid: 'req-u', requested_role: 2, status: 2, bot_uids: ['bot_a'], decided_by: 'op-2',
    } as unknown as Awaited<ReturnType<typeof docAccessRequestRepo.getByRequestId>>)
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValueOnce(false) // CAS loses
    vi.mocked(grantForwardAccess).mockReset()
    vi.mocked(grantForwardAccess).mockResolvedValue({ finalRole: 'writer', changed: true })

    const res = await drive('4102')
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })

  it('zero-bot approve omits the bots field (legacy response shape)', async () => {
    const { docAccessRequestRepo } = await import('../src/db/repos/docAccessRequestRepo.js')
    const { grantForwardAccess } = await import('../src/api/services/grantForward.js')
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValueOnce({
      uid: 'req-u', requested_role: 1, status: 1, bot_uids: [],
    } as unknown as Awaited<ReturnType<typeof docAccessRequestRepo.getByRequestId>>)
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValueOnce(true)
    vi.mocked(grantForwardAccess).mockReset()
    vi.mocked(grantForwardAccess).mockResolvedValue({ finalRole: 'reader', changed: true })

    const res = await drive('4103')
    expect(res.statusCode).toBe(200)
    const payload = res.payload as Record<string, unknown>
    expect(payload.disposition).toBe('applied')
    expect(Object.keys(payload).sort()).toEqual(['decided_at', 'decider_space_id', 'decider_uid', 'display', 'disposition', 'requester_uid', 'state'])
    expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledTimes(1) // requester only
  })

  it('returns retryable failure when atomic primary grant rolls back, then succeeds on redelivery', async () => {
    const { docAccessRequestRepo } = await import('../src/db/repos/docAccessRequestRepo.js')
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue({
      uid: 'req-u', principal_space_id: 'space-requester', requested_role: 1, status: 1, bot_uids: [],
    } as unknown as Awaited<ReturnType<typeof docAccessRequestRepo.getByRequestId>>)
    mockApproveAccessRequest.mockRejectedValueOnce(new Error('primary grant failed'))

    const failed = await drive('4104')
    expect(failed.statusCode).toBe(503)
    expect(failed.payload).toEqual({ error: 'temporarily_unavailable' })

    mockApproveAccessRequest.mockResolvedValueOnce({ transitioned: true, requesterRole: 'reader' })
    const retried = await drive('4105')
    expect(retried.statusCode).toBe(200)
    expect((retried.payload as { state?: string }).state).toBe('approved')
  })
})
