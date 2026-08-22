import { describe, it, expect, beforeEach } from 'vitest'
import {
  markOversized,
  clearOversized,
  getOversized,
  oversizedCount,
  resetOversizedForTest,
} from '../src/collab/oversizeGuard.js'

const DOC = 'octo:space:f_default:d_abc'
const LIMIT = 10 * 1024 * 1024

describe('oversizeGuard', () => {
  beforeEach(() => resetOversizedForTest())

  it('a document is not marked until a store is rejected', () => {
    expect(getOversized(DOC)).toBeNull()
  })

  it('marking records the rejected size and the cap that was exceeded', () => {
    markOversized(DOC, 18_320_896, LIMIT)
    const mark = getOversized(DOC)
    expect(mark).not.toBeNull()
    expect(mark?.bytes).toBe(18_320_896)
    expect(mark?.limit).toBe(LIMIT)
    expect(typeof mark?.since).toBe('number')
  })

  it('clearing lets writes through again (document shrank back under the cap)', () => {
    markOversized(DOC, 18_320_896, LIMIT)
    expect(getOversized(DOC)).not.toBeNull()
    clearOversized(DOC)
    expect(getOversized(DOC)).toBeNull()
  })

  it('marks are per-document: one oversized doc never blocks another', () => {
    markOversized(DOC, 18_320_896, LIMIT)
    expect(getOversized('octo:space:f_default:d_other')).toBeNull()
  })

  it('re-marking overwrites rather than accumulating (no unbounded growth)', () => {
    markOversized(DOC, 11_000_000, LIMIT)
    markOversized(DOC, 18_320_896, LIMIT)
    expect(oversizedCount()).toBe(1)
    expect(getOversized(DOC)?.bytes).toBe(18_320_896)
  })

  it('clearing an unmarked document is a no-op (unload of a healthy doc)', () => {
    expect(() => clearOversized('octo:space:f_default:d_never_marked')).not.toThrow()
    expect(oversizedCount()).toBe(0)
  })

  /**
   * Regression for the 2026-08-21 incident shape: the document was rejected at
   * 17.47 MB, kept accepting collaborative writes, and re-encoded that state on
   * every store attempt until the liveness probe timed out. The guard must be
   * armed from the FIRST rejection, not after N of them.
   */
  it('is armed by a single rejection', () => {
    markOversized(DOC, 18_320_896, LIMIT)
    expect(getOversized(DOC)?.bytes).toBeGreaterThan(LIMIT)
  })
})

describe('DocumentTooLargeError rejection contract', () => {
  it('does NOT advertise a close code (Hocuspocus never delivers one)', async () => {
    const { DocumentTooLargeError } = await import('../src/collab/oversizeGuard.js')
    const err = new DocumentTooLargeError(DOC, 18_320_896, LIMIT)

    // An earlier version set `code = 1009` so @hocuspocus/provider would set
    // shouldConnect = false. Measured on the running stack, that never happens:
    // Connection.close() does not close the socket, it sends an in-band CLOSE
    // message carrying `reason` ONLY, so no CloseEvent and no code reach the
    // browser (one connection was "closed" nine times, the client saw zero close
    // frames). Asserting the ABSENCE keeps the dead mechanism from being
    // reinstated as if it worked — user-facing notification is the stateless
    // frame's job now.
    expect((err as unknown as { code?: unknown }).code).toBeUndefined()

    expect(err.reason).toContain('Document Too Large')
    expect(err.reason).toContain('18320896')
    expect(err).toBeInstanceOf(Error)
  })

  it('the reason string stays free of the documentName (not leaked to peers)', async () => {
    const { DocumentTooLargeError } = await import('../src/collab/oversizeGuard.js')
    const err = new DocumentTooLargeError('octo:secret-space:f:d_x', 1, 0)
    expect(err.reason).not.toContain('secret-space')
    expect(err.message).toContain('secret-space') // server-side log keeps it
  })
})

describe('oversize announcement (how the user actually finds out)', () => {
  it('pushes a stateless frame on the FIRST rejected store, not the next write', async () => {
    const { markOversized, setOversizeAnnouncer, OVERSIZE_FRAME_TYPE } = await import(
      '../src/collab/oversizeGuard.js'
    )
    const sent: Array<{ doc: string; payload: string }> = []
    setOversizeAnnouncer((doc, payload) => sent.push({ doc, payload }))
    try {
      markOversized(DOC, 18_320_896, LIMIT)

      // One rejected store => the editing clients already know. This is the
      // property a close-reason sniff cannot have: that would need a SUBSEQUENT
      // write to arrive before anything was reported.
      expect(sent).toHaveLength(1)
      expect(sent[0].doc).toBe(DOC)
      const frame = JSON.parse(sent[0].payload)
      expect(frame.type).toBe(OVERSIZE_FRAME_TYPE)
      expect(frame.bytes).toBe(18_320_896)
      expect(frame.limit).toBe(LIMIT)
    } finally {
      setOversizeAnnouncer(null)
    }
  })

  it('does not put the documentName on the wire', async () => {
    const { markOversized, setOversizeAnnouncer } = await import('../src/collab/oversizeGuard.js')
    const sent: string[] = []
    setOversizeAnnouncer((_doc, payload) => sent.push(payload))
    try {
      markOversized('octo:secret-space:f:d_x', 11_000_000, LIMIT)
      expect(sent[0]).not.toContain('secret-space')
    } finally {
      setOversizeAnnouncer(null)
    }
  })

  it('a failing announcer never masks the size rejection', async () => {
    const { markOversized, setOversizeAnnouncer, getOversized } = await import(
      '../src/collab/oversizeGuard.js'
    )
    setOversizeAnnouncer(() => {
      throw new Error('socket gone')
    })
    try {
      // The mark is the load-bearing half: without it beforeHandleMessage keeps
      // accepting writes and the document inflates. It must survive a broken
      // notifier (e.g. the document unloaded mid-store).
      expect(() => markOversized(DOC, 18_320_896, LIMIT)).not.toThrow()
      expect(getOversized(DOC)?.bytes).toBe(18_320_896)
    } finally {
      setOversizeAnnouncer(null)
    }
  })

  it('re-announces on every rejection so a late joiner is not left in the dark', async () => {
    const { markOversized, setOversizeAnnouncer } = await import('../src/collab/oversizeGuard.js')
    const sent: string[] = []
    setOversizeAnnouncer((_doc, payload) => sent.push(payload))
    try {
      markOversized(DOC, 18_320_896, LIMIT)
      markOversized(DOC, 18_400_000, LIMIT)
      expect(sent).toHaveLength(2)
      expect(JSON.parse(sent[1]).bytes).toBe(18_400_000)
    } finally {
      setOversizeAnnouncer(null)
    }
  })

  it('stays silent when no announcer is wired (unit/test contexts)', async () => {
    const { markOversized, setOversizeAnnouncer, getOversized } = await import(
      '../src/collab/oversizeGuard.js'
    )
    setOversizeAnnouncer(null)
    expect(() => markOversized(DOC, 18_320_896, LIMIT)).not.toThrow()
    expect(getOversized(DOC)).not.toBeNull()
  })
})

describe('a client that joins AFTER the document went over the cap', () => {
  it('is notified on join, not left with a silently unsaveable surface', async () => {
    const { markOversized, setOversizeAnnouncer, noticeOversizeOnJoin, OVERSIZE_FRAME_TYPE } =
      await import('../src/collab/oversizeGuard.js')
    setOversizeAnnouncer(null) // nobody was connected when the store was rejected
    markOversized(DOC, 18_320_896, LIMIT)

    // Now someone opens the document. The broadcast is long gone; this join-time
    // notice is their only signal. Without it they get a normal editor whose
    // every keystroke is unpersistable — how the incident document kept taking
    // writes for 20 minutes after it could no longer be saved.
    const sent: string[] = []
    const notified = noticeOversizeOnJoin(DOC, (payload) => sent.push(payload))

    expect(notified).toBe(true)
    expect(sent).toHaveLength(1)
    const frame = JSON.parse(sent[0])
    expect(frame.type).toBe(OVERSIZE_FRAME_TYPE)
    expect(frame.bytes).toBe(18_320_896)
    expect(frame.limit).toBe(LIMIT)
  })

  it('sends nothing when the document is under the cap (no false alarms)', async () => {
    const { noticeOversizeOnJoin, clearOversized } = await import('../src/collab/oversizeGuard.js')
    clearOversized(DOC)
    const sent: string[] = []
    expect(noticeOversizeOnJoin(DOC, (p) => sent.push(p))).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('stops notifying once the document is back under the cap', async () => {
    const { markOversized, setOversizeAnnouncer, clearOversized, noticeOversizeOnJoin } =
      await import('../src/collab/oversizeGuard.js')
    setOversizeAnnouncer(null)
    markOversized(DOC, 18_320_896, LIMIT)
    // e.g. compaction shrank it, or the document unloaded and was refetched.
    clearOversized(DOC)
    expect(noticeOversizeOnJoin(DOC, () => {})).toBe(false)
  })
})
