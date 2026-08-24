/**
 * Oversize write guard (incident 2026-08-21).
 *
 * PROBLEM. `persistence.store` rejects a document whose encoded state exceeds
 * `config.maxDocBytes`, but that check runs AFTER Hocuspocus has already encoded
 * the whole Y.Doc, and the throw is swallowed by the extension-database hook
 * ("Document stays in memory to avoid data loss"). The document therefore keeps
 * accepting writes it can never persist: it grew 9.06 MB -> 17.47 MB in ~20
 * minutes, each store attempt re-encoding 17 MB on the single JS thread until
 * the liveness probe timed out and the pod was killed. On restart the clients
 * reconnected, re-inflated the doc, and the cycle repeated (23 restarts).
 *
 * FIX. Once a store is rejected for size we remember it here, and
 * `beforeHandleMessage` refuses further collaborative writes to that document
 * (flipping the connection read-only so the client stops retrying). The mark is
 * cleared as soon as a store succeeds, so a document that shrinks below the cap
 * — e.g. after the owner deletes rows — recovers on its own with no operator
 * action.
 *
 * The lookup MUST stay O(1): it is on the hot path of every inbound Yjs update.
 * We deliberately do NOT re-encode the document to measure it here; the size is
 * only ever recorded from a store attempt that had already paid for the encode.
 */

/** What we remember about a document that failed its size check. */
export interface OversizeMark {
  /** Encoded byte size of the update that was rejected. */
  readonly bytes: number
  /** The cap that was exceeded (`config.maxDocBytes` at rejection time). */
  readonly limit: number
  /** Epoch millis of the most recent rejection, for logging/observability. */
  readonly since: number
}

const oversized = new Map<string, OversizeMark>()

/**
 * Stateless frame announcing that a document is over the persistence cap.
 *
 * WHY A STATELESS FRAME AND NOT A CLOSE CODE. The obvious design — throw an
 * error carrying WS 1009 from `beforeHandleMessage` and let the client read
 * `event.code` — cannot work, and this was proven on the running stack rather
 * than argued: Hocuspocus's `Connection.close()` does NOT close the socket. It
 * removes the connection from the document and sends an in-band application
 * CLOSE message carrying `reason` only, because one socket multiplexes several
 * documents and closing it would take the others down. So `code` never reaches
 * the browser: the same connection was observed being "closed" three times and
 * receiving messages in between. @hocuspocus/provider's `shouldConnect = false`
 * branch keys off `event.code`, so it never fires either.
 *
 * The stateless channel is the mechanism the client already listens on for
 * out-of-band document state (see statelessRole.ts / `provider.on('stateless')`),
 * it survives the multiplexing because it is addressed per document, and it can
 * be sent the moment the FIRST store is rejected — before any further write
 * arrives. A reason-string sniff could only fire on the NEXT write attempt, and
 * by then the connection semantics are already broken.
 */
export const OVERSIZE_FRAME_TYPE = 'doc.over-size-cap'

/** The wire shape broadcast to clients. `type` is matched literally. */
export interface OversizeFrame {
  type: typeof OVERSIZE_FRAME_TYPE
  bytes: number
  limit: number
}

/** Serialise the frame. Kept here so both sender and tests agree on one shape. */
export function oversizeFramePayload(mark: OversizeMark): string {
  const frame: OversizeFrame = {
    type: OVERSIZE_FRAME_TYPE,
    bytes: mark.bytes,
    limit: mark.limit,
  }
  return JSON.stringify(frame)
}

/**
 * How the guard reaches connected clients.
 *
 * Injected rather than imported because `server.ts` already imports this module
 * (and `persistence.ts`): importing it back would close a cycle. Left null in
 * tests that do not care, so nothing is announced.
 */
type Announce = (documentName: string, payload: string) => void
let announce: Announce | null = null

/** Wire the notifier once, at server construction. */
export function setOversizeAnnouncer(fn: Announce | null): void {
  announce = fn
}

/**
 * Tell ONE arriving connection that the document it just opened is already over
 * the cap, if it is. Returns whether a notice was sent (for tests / logging).
 *
 * `markOversized`'s broadcast only reaches whoever was connected at rejection
 * time. Without this, a client that opens the document afterwards gets a normal,
 * editable surface whose every edit is silently unpersistable — exactly the
 * state in which the incident document kept accumulating writes nobody could
 * save. Extracted from the `connected` hook so it is testable without standing
 * up a real Hocuspocus server.
 */
export function noticeOversizeOnJoin(
  documentName: string,
  send: (payload: string) => void,
): boolean {
  const mark = oversized.get(documentName)
  if (!mark) return false
  send(oversizeFramePayload(mark))
  return true
}

/**
 * Record that `documentName` could not be persisted because it exceeds `limit`,
 * and TELL the clients editing it.
 *
 * Called from `persistence.store` on the size-cap branch, i.e. only after an
 * encode that already happened — the mark itself adds no work.
 *
 * The announcement fires on every rejected store, not only the first. That is
 * deliberate: a client that connected after the first rejection has to learn
 * about it too, and the frame is a few dozen bytes against a store attempt that
 * just encoded megabytes. Announcement failure must never mask the size error
 * the caller is about to throw, so it is swallowed here.
 */
export function markOversized(documentName: string, bytes: number, limit: number): void {
  const mark: OversizeMark = { bytes, limit, since: Date.now() }
  oversized.set(documentName, mark)
  try {
    announce?.(documentName, oversizeFramePayload(mark))
  } catch {
    // Best-effort: the caller's size rejection is the important signal.
  }
}

/**
 * Forget a document, on the two events that make the mark stale:
 *   - a store SUCCEEDED (it now fits, so writes must be allowed again), and
 *   - the document was unloaded (a later load re-derives the mark from its own
 *     first store attempt, and leaving the entry would leak for every document
 *     that ever tripped the cap).
 */
export function clearOversized(documentName: string): void {
  oversized.delete(documentName)
}

/** The mark for `documentName`, or null when it is within the cap. O(1). */
export function getOversized(documentName: string): OversizeMark | null {
  return oversized.get(documentName) ?? null
}

/** Number of currently-marked documents. Exposed for tests/metrics only. */
export function oversizedCount(): number {
  return oversized.size
}

/** Test-only reset so suites do not leak marks into each other. */
export function resetOversizedForTest(): void {
  oversized.clear()
}

/**
 * Rejection carrier for a write to an oversized document.
 *
 * This deliberately does NOT try to carry a WebSocket close code. An earlier
 * version set `code = 1009` (MessageTooBig) on the theory that Hocuspocus reads
 * `.code`/`.reason` off a thrown hook error and closes the socket with them, and
 * that @hocuspocus/provider honours 1009 by setting `shouldConnect = false`.
 * Both halves are true in the source and the combination still does not work:
 * `Connection.close()` sends an in-band application CLOSE message carrying
 * `reason` ONLY — the socket stays open (one socket multiplexes several
 * documents), so no CloseEvent and no `code` ever reaches the browser. Measured:
 * the server "closed" one connection nine times, the client saw zero close
 * frames and kept sending.
 *
 * Telling the user is therefore the stateless frame's job (see
 * `OVERSIZE_FRAME_TYPE`), which is pushed the moment the FIRST store is
 * rejected. This error's remaining job is narrow and purely server-side: refuse
 * the write so the in-memory document cannot keep inflating.
 */
export class DocumentTooLargeError extends Error {
  readonly reason: string

  constructor(documentName: string, bytes: number, limit: number) {
    const reason = `Document Too Large: ${bytes} > ${limit} bytes`
    super(`${reason} (${documentName})`)
    this.name = 'DocumentTooLargeError'
    this.reason = reason
  }
}
