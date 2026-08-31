import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Offline unit tests for the access-decision card-sync service (task
// docs-access-decision-card-sync). config, docAccessNotifyCardRepo and
// global.fetch are mocked so we assert, without any DB or octo-server:
//   - config gating (missing internal token => no-op, no fetch)
//   - empty ledger => early return, no HTTP
//   - card-callback path (deciderCardHandledExternally:true) skips the decider's
//     own card; REST path (omitted/false) terminalizes the decider's card too
//   - happy path: every sibling mutated in place, each marked terminalized
//   - the mutate carries the AUTHORITATIVE decider IDs + decision time (by id),
//     and docs resolves NO user/Space profile
//   - mutate failure => NO second card (no duplicate outcome card)
//   - best-effort: a repo/HTTP failure never throws out of syncDecisionCards
vi.mock('../src/config/env.js', () => ({
  config: {
    octoIdentity: { serverBaseUrl: 'http://octo-server:8080' },
    notify: { docsToken: '', service: 'docs-service' },
    cardDisplayTimeZone: 'Asia/Shanghai',
  },
}))
vi.mock('../src/db/repos/docAccessNotifyCardRepo.js', () => ({
  NOTIFY_CARD_STATUS_ACTIVE: 1,
  NOTIFY_CARD_STATUS_TERMINALIZED: 2,
  docAccessNotifyCardRepo: {
    listByRequest: vi.fn(async () => []),
    markTerminalized: vi.fn(async () => {}),
  },
}))

import { syncDecisionCards } from '../src/api/services/docsDecisionCardSync.js'
import { config } from '../src/config/env.js'
import { docAccessNotifyCardRepo } from '../src/db/repos/docAccessNotifyCardRepo.js'

const cfg = config as unknown as { notify: { docsToken: string; service: string } }
const repo = docAccessNotifyCardRepo as unknown as {
  listByRequest: ReturnType<typeof vi.fn>
  markTerminalized: ReturnType<typeof vi.fn>
}

function row(recipientUid: string, deliverySpaceId = 'space-1') {
  return {
    request_id: 'req-1',
    recipient_uid: recipientUid,
    delivery_space_id: deliverySpaceId,
    channel_id: `ch-${recipientUid}`,
    channel_type: 1,
    message_id: `m-${recipientUid}`,
    client_msg_no: '',
    status: 1,
    created_at: new Date(),
    updated_at: new Date(),
  }
}

function baseParams() {
  return {
    requestId: 'req-1',
    spaceId: 'space-1',
    docId: 'doc-1',
    title: 'Test Doc',
    deciderUid: 'u-owner',
    deciderSpaceId: 'space-decider',
    denied: false,
  }
}

/** Parse the JSON body of the Nth fetch call. */
function bodyOf(fetchMock: ReturnType<typeof vi.fn>, i: number): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[i][1].body as string) as Record<string, unknown>
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  cfg.notify.docsToken = 'internal-token'
  repo.listByRequest.mockReset().mockResolvedValue([])
  repo.markTerminalized.mockReset().mockResolvedValue(undefined)
  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('syncDecisionCards', () => {
  it('is a no-op when the internal token is not configured', async () => {
    cfg.notify.docsToken = ''
    await syncDecisionCards(baseParams())
    expect(repo.listByRequest).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns early with no HTTP when the ledger is empty', async () => {
    repo.listByRequest.mockResolvedValue([])
    await syncDecisionCards(baseParams())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('card-callback path skips the decider own card (finalizer handled it)', async () => {
    repo.listByRequest.mockResolvedValue([row('u-owner'), row('u-admin1'), row('u-admin2')])
    await syncDecisionCards({ ...baseParams(), deciderUid: 'u-owner', clickedCardSpaceId: 'space-1', deciderCardHandledExternally: true })
    // Only the two non-decider siblings are mutated.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const targets = [bodyOf(fetchMock, 0).message_id, bodyOf(fetchMock, 1).message_id].sort()
    expect(targets).toEqual(['m-u-admin1', 'm-u-admin2'])
  })

  it('skips only the exact clicked principal and terminalizes same uid in another Space', async () => {
    repo.listByRequest.mockResolvedValue([
      row('same-admin', 'space-A'),
      row('same-admin', 'space-B'),
      row('sibling', 'space-C'),
    ])
    await syncDecisionCards({
      ...baseParams(), deciderUid: 'same-admin', deciderSpaceId: 'space-A',
      clickedCardSpaceId: 'space-A', deciderCardHandledExternally: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect([bodyOf(fetchMock, 0).space_id, bodyOf(fetchMock, 1).space_id].sort())
      .toEqual(['space-B', 'space-C'])
    expect(repo.markTerminalized).toHaveBeenCalledWith('req-1', 'same-admin', 'space-B')
    expect(repo.markTerminalized).toHaveBeenCalledWith('req-1', 'sibling', 'space-C')
  })

  it('REST path terminalizes the decider own card too (no finalizer)', async () => {
    repo.listByRequest.mockResolvedValue([row('u-owner'), row('u-admin1'), row('u-admin2')])
    // deciderCardHandledExternally omitted => REST path
    await syncDecisionCards({ ...baseParams(), deciderUid: 'u-owner' })
    // All three cards, INCLUDING the decider's own, are mutated.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const targets = [
      bodyOf(fetchMock, 0).message_id,
      bodyOf(fetchMock, 1).message_id,
      bodyOf(fetchMock, 2).message_id,
    ].sort()
    expect(targets).toEqual(['m-u-admin1', 'm-u-admin2', 'm-u-owner'])
  })

  it('happy path mutates in place and marks each card terminalized', async () => {
    repo.listByRequest.mockResolvedValue([row('u-admin1'), row('u-admin2')])
    await syncDecisionCards({ ...baseParams(), deciderCardHandledExternally: true })
    // All calls hit the in-place mutate endpoint (not a re-notify fallback).
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toContain('/v1/internal/cards/mutate')
      expect(call[1].headers['X-Internal-Token']).toBe('internal-token')
    }
    expect(repo.markTerminalized).toHaveBeenCalledTimes(2)
  })

  it('forwards the AUTHORITATIVE decider IDs by id, resolving no profile', async () => {
    repo.listByRequest.mockResolvedValue([row('u-admin1'), row('u-admin2')])
    await syncDecisionCards({
      ...baseParams(),
      deciderCardHandledExternally: true,
      decidedAtSeconds: 1_784_073_600,
    })
    for (let i = 0; i < fetchMock.mock.calls.length; i++) {
      const body = bodyOf(fetchMock, i)
      expect(body.decider_uid).toBe('u-owner')
      expect(body.decider_space_id).toBe('space-decider')
      expect(body.decided_at).toBe(1_784_073_600)
      // Docs no longer pre-resolves names; those fields must never be on the wire.
      expect(body).not.toHaveProperty('operator_name')
      expect(body).not.toHaveProperty('operator_space_name')
      expect(body).not.toHaveProperty('decided_at_display')
    }
  })

  it('sends an empty decider Space (never a guess) when none is provided', async () => {
    repo.listByRequest.mockResolvedValue([row('u-admin1')])
    const { deciderSpaceId: _omit, ...noSpace } = baseParams()
    await syncDecisionCards({ ...noSpace, deciderCardHandledExternally: true })
    expect(bodyOf(fetchMock, 0).decider_space_id).toBe('')
  })

  it('omits decided_at when no authoritative time is provided', async () => {
    repo.listByRequest.mockResolvedValue([row('u-admin1')])
    await syncDecisionCards({ ...baseParams(), deciderCardHandledExternally: true })
    expect(bodyOf(fetchMock, 0)).not.toHaveProperty('decided_at')
  })

  it('does not send a second card when an in-place mutate fails (no duplicate outcome card)', async () => {
    repo.listByRequest.mockResolvedValue([row('u-admin1')])
    fetchMock.mockResolvedValue({ ok: false, status: 500 })
    await syncDecisionCards({ ...baseParams(), deciderCardHandledExternally: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toContain('/v1/internal/cards/mutate')
    expect(repo.markTerminalized).not.toHaveBeenCalled()
  })

  it('carries the deny reason onto the terminal card when denied', async () => {
    repo.listByRequest.mockResolvedValue([row('u-admin1')])
    await syncDecisionCards({
      ...baseParams(),
      denied: true,
      denyReason: '权限不足',
      deciderCardHandledExternally: true,
    })
    expect(bodyOf(fetchMock, 0).deny_reason).toBe('权限不足')
  })

  it('does not send unsupported bot summary fields to mutate', async () => {
    repo.listByRequest.mockResolvedValue([row('u-admin1')])
    await syncDecisionCards({
      ...baseParams(),
      denied: false,
      deciderCardHandledExternally: true,
    })
    expect(bodyOf(fetchMock, 0)).not.toHaveProperty('bot_summary')
  })

  it('never throws even when the ledger lookup fails (best-effort)', async () => {
    repo.listByRequest.mockRejectedValue(new Error('db down'))
    await expect(syncDecisionCards(baseParams())).resolves.toBeUndefined()
  })
})
