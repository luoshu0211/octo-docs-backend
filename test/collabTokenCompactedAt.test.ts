/**
 * `compactedAt` on the collab-token response.
 *
 * This field is the ONLY thing standing between compaction and being undone. The stateless-frame
 * version of the same idea was measured end-to-end and did nothing: the client hydrates its Y.Doc
 * from IndexedDB and only then connects, so its first sync re-uploads the removed history before
 * any frame can arrive (identical outcome, 365,233 bytes / 2 clientIDs, whether the frame was
 * handled or ignored). This response is awaited BEFORE the client builds its persistence, which
 * is the last point at which a stale cache is still unread.
 *
 * So the properties under test are: the stamp reaches the client when there is one, a Redis
 * failure never costs a token — a handshake that fails over a cache optimisation would be worse
 * than the optimisation is worth — and, because the client DELETES its IndexedDB copy on this
 * field, an over-cap document never gets stamped at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const stamp = vi.fn<(doc: string) => Promise<number | null>>()
const overCapAnywhere = vi.fn<(doc: string) => Promise<boolean>>()
vi.mock('../src/collab/compactionNotice.js', () => ({
  compactedAt: (doc: string) => stamp(doc),
  isOverCapAnywhere: (doc: string) => overCapAnywhere(doc),
  // oversizeGuard imports this on the mirror path; the real module is mocked away.
  markOverCapShared: async () => {},
}))

const { attachCompactedAtForTest } = await import('../src/auth/issueCollabToken.js')
const { markOversized, resetOversizedForTest } = await import('../src/collab/oversizeGuard.js')

const DOC = 'octo:s1:f_default:d_abc'
const base = () => ({ token: 't', expiresAt: 'x', role: 'writer' as const, permission_epoch: 3 })

describe('attachCompactedAt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetOversizedForTest()
    overCapAnywhere.mockResolvedValue(false)
  })

  it('stamps the response when the document has been compacted', async () => {
    stamp.mockResolvedValue(1_756_000_000_000)
    const r = base()
    await attachCompactedAtForTest(r, DOC)
    expect(r).toMatchObject({ compactedAt: 1_756_000_000_000 })
    expect(stamp).toHaveBeenCalledWith(DOC)
  })

  /** Absence must stay absent, not become 0 — a 0 would read as "older than everything". */
  it('leaves the field off entirely when there is no stamp', async () => {
    stamp.mockResolvedValue(null)
    const r = base()
    await attachCompactedAtForTest(r, DOC)
    expect('compactedAt' in r).toBe(false)
  })

  /**
   * The one that matters operationally: issuance must not depend on Redis. A missing stamp costs
   * a cache that could have been dropped; a failed handshake costs the user the document.
   */
  it('never throws when the lookup fails, and issues the token anyway', async () => {
    stamp.mockRejectedValue(new Error('ECONNREFUSED'))
    const r = base()
    await expect(attachCompactedAtForTest(r, DOC)).resolves.toBeUndefined()
    expect('compactedAt' in r).toBe(false)
    expect(r.token).toBe('t') // the rest of the envelope is untouched
  })
})

/**
 * THE OVER-CAP INTERLOCK.
 *
 * The client acts on this field by deleting its IndexedDB database before it loads. While a
 * document is over the persistence cap its stores are being rejected, so that cache is the only
 * copy of everything typed since the cap was hit. Stamping such a response destroys exactly the
 * content the over-size-cap banner tells the user to copy out by hand.
 *
 * `noticeStaleCacheOnJoin` already carries this interlock, but the token response is issued
 * STRICTLY EARLIER than any stateless frame, so gating only the frame left the interlock
 * decorative: the cache was already gone one handshake before the suppressed frame.
 */
describe('attachCompactedAt over-cap interlock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetOversizedForTest()
    overCapAnywhere.mockResolvedValue(false)
  })

  it('does not stamp while THIS replica is rejecting the document', async () => {
    stamp.mockResolvedValue(1_756_000_000_000)
    markOversized(DOC, 10_556_162, 10_485_760)
    const r = base()
    await attachCompactedAtForTest(r, DOC)
    expect('compactedAt' in r).toBe(false)
  })

  /** The local mark needs no network, so the shared lookup must not even be attempted. */
  it('short-circuits on the local mark without consulting Redis', async () => {
    stamp.mockResolvedValue(1_756_000_000_000)
    markOversized(DOC, 10_556_162, 10_485_760)
    await attachCompactedAtForTest(base(), DOC)
    expect(overCapAnywhere).not.toHaveBeenCalled()
    expect(stamp).not.toHaveBeenCalled()
  })

  /**
   * The measured divergence case: one replica served a clean 659,725-byte copy while another was
   * rejecting 10,556,162 bytes for the same document. A client landing on the clean replica must
   * still not be told to drop its cache.
   */
  it('does not stamp when ANOTHER replica is rejecting the document', async () => {
    stamp.mockResolvedValue(1_756_000_000_000)
    overCapAnywhere.mockResolvedValue(true)
    const r = base()
    await attachCompactedAtForTest(r, DOC)
    expect('compactedAt' in r).toBe(false)
    expect(stamp).not.toHaveBeenCalled()
  })

  /** Unreadable Redis must resolve to "keep the cache", never to "delete it". */
  it('does not stamp when the shared over-cap lookup fails', async () => {
    stamp.mockResolvedValue(1_756_000_000_000)
    overCapAnywhere.mockRejectedValue(new Error('ECONNREFUSED'))
    const r = base()
    await expect(attachCompactedAtForTest(r, DOC)).resolves.toBeUndefined()
    expect('compactedAt' in r).toBe(false)
  })

  /** And the gate must open again once the document fits: this is an interlock, not a mute. */
  it('stamps again once the document is no longer over the cap', async () => {
    stamp.mockResolvedValue(1_756_000_000_000)
    markOversized(DOC, 10_556_162, 10_485_760)
    await attachCompactedAtForTest(base(), DOC)
    resetOversizedForTest() // stands in for the successful store that clears the mark
    const r = base()
    await attachCompactedAtForTest(r, DOC)
    expect(r).toMatchObject({ compactedAt: 1_756_000_000_000 })
  })
})
