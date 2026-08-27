/**
 * The oversize guard must not become a hole in authorization.
 *
 * `beforeHandleMessage` carries TWO enforcement duties: the §4.5 permission
 * recheck (does this principal still have write access?) and the capacity guard
 * (can this document take another byte?). They are independent, and the order
 * between them is load-bearing.
 *
 * The first fix for the unreadable-document defect returned early on a capped
 * document. That silently skipped the recheck: while a document sat over the
 * cap, a principal whose access had been revoked mid-connection stopped being
 * rechecked. Measured on ffbe2d7 by driving the real hook out of the real
 * createServer() config, with recheckCurrentRoleCached stubbed to 'none':
 *
 *     healthy document  -> Forbidden thrown, revocation enforced
 *     capped  document  -> nothing thrown, recheck never even called
 *
 * and against its parent e8330c1 the capped case DID enforce — so the early
 * return introduced the regression rather than inheriting it.
 *
 * Read-only is not a substitute here. A read-only connection still receives
 * document CONTENT (Hocuspocus short-circuits only the two write paths), which
 * is precisely what a revoked principal must no longer get. Authorization
 * first, capacity second.
 *
 * These tests drive the REAL hook, not a re-implementation: a copy of the
 * ordering logic would keep passing while server.ts regressed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const recheckSpy = vi.fn()
let currentRole = 'writer'

vi.mock('../src/permission/recheck.js', () => ({
  recheckCurrentRoleCached: (...args: unknown[]) => {
    recheckSpy(...args)
    return Promise.resolve(currentRole)
  },
}))

const DOC = 'octo:space:f_default:d_authz'
const LIMIT = 10 * 1024 * 1024

/** A principal whose token epoch is behind the watermark => must be rechecked. */
const staleCtx = () => ({
  user: { id: 'u_revoked' },
  permission_epoch: 1,
  principal_space_id: 's1',
  space_member: false,
  role: 'writer',
})

async function callHook(conn: { readOnly: boolean }) {
  const { createServer } = await import('../src/collab/server.js')
  const server = createServer()
  const hook = (server.configuration as Record<string, unknown>)
    .beforeHandleMessage as (d: unknown) => Promise<void>
  return hook({ documentName: DOC, context: staleCtx(), connection: conn })
}

describe('oversize guard must not bypass the permission recheck', () => {
  beforeEach(async () => {
    const { resetOversizedForTest, setOversizeAnnouncer } = await import(
      '../src/collab/oversizeGuard.js'
    )
    const { setEpochWatermark } = await import('../src/collab/server.js')
    resetOversizedForTest()
    setOversizeAnnouncer(null)
    setEpochWatermark(DOC, 99) // ahead of the ctx epoch => stale => recheck required
    recheckSpy.mockClear()
    currentRole = 'writer'
  })

  /** Baseline: without the cap in play, revocation is enforced. */
  it('rejects a revoked principal on a healthy document', async () => {
    currentRole = 'none'
    await expect(callHook({ readOnly: false })).rejects.toThrow('Forbidden')
  })

  /**
   * The regression itself. Turning `const capped = applyOversizeDecision(...)`
   * back into `if (applyOversizeDecision(...)) return` turns this red.
   */
  it('still rejects a revoked principal when the document is over the cap', async () => {
    const { markOversized } = await import('../src/collab/oversizeGuard.js')
    markOversized(DOC, 18_320_896, LIMIT)
    currentRole = 'none'
    await expect(callHook({ readOnly: false })).rejects.toThrow('Forbidden')
  })

  /** The recheck must actually RUN — not be skipped and coincidentally pass. */
  it('still performs the recheck when the document is over the cap', async () => {
    const { markOversized } = await import('../src/collab/oversizeGuard.js')
    markOversized(DOC, 18_320_896, LIMIT)
    currentRole = 'none'
    await callHook({ readOnly: false }).catch(() => {})
    expect(recheckSpy).toHaveBeenCalledTimes(1)
  })

  /** A demoted (reader) principal is a write rejection too, cap or no cap. */
  it('rejects a principal demoted below writer on a capped document', async () => {
    const { markOversized } = await import('../src/collab/oversizeGuard.js')
    markOversized(DOC, 18_320_896, LIMIT)
    currentRole = 'reader'
    await expect(callHook({ readOnly: false })).rejects.toThrow('Forbidden')
  })

  /**
   * And the fix must not undo the fix it sits on top of: a principal who still
   * HAS access must not be thrown at (that close is what made capped documents
   * unreadable), while the cap still applies to them.
   */
  it('does not throw at a still-authorized principal on a capped document', async () => {
    const { markOversized } = await import('../src/collab/oversizeGuard.js')
    markOversized(DOC, 18_320_896, LIMIT)
    currentRole = 'writer'
    const conn = { readOnly: false }
    await expect(callHook(conn)).resolves.toBeUndefined()
    expect(conn.readOnly).toBe(true) // capacity guard still applied
  })
})
