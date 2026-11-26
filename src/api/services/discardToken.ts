/**
 * Copy-compensation token (§4.4 复制).
 *
 * The copy primitive returns a `discardToken` that binds the new docId to the
 * caller that minted it. Drive echoes it back only when its own entry insert
 * failed, so `POST /internal/docs/:docId/discard-copy` cannot be aimed at a
 * document that was never produced by a copy request (a guessed docId, or a
 * copy that is already linked and in use).
 *
 * The token is stateless: an HMAC over docId + owner + issue time under the
 * service's collab signing secret. No schema, no extra round trip. Age is
 * enforced twice — by the token's own timestamp and by the same 24h window the
 * compensation route applies to doc_meta.created_at.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../../config/env.js'

const VERSION = 'v1'

function sign(raw: string): string {
  return createHmac('sha256', config.collabToken.secret).update(raw).digest('base64url')
}

export function signDiscardToken(docId: string, ownerUid: string, issuedAtMs = Date.now()): string {
  const raw = `${VERSION}.${docId}.${ownerUid}.${issuedAtMs}`
  return `${Buffer.from(raw).toString('base64url')}.${sign(raw)}`
}

export interface VerifiedDiscardToken {
  docId: string
  ownerUid: string
  issuedAtMs: number
}

/** Returns null for anything that is not a token this service issued. */
export function verifyDiscardToken(token: string): VerifiedDiscardToken | null {
  const trimmed = token.trim()
  const dot = trimmed.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = trimmed.slice(0, dot)
  const signature = trimmed.slice(dot + 1)
  let raw: string
  try {
    raw = Buffer.from(payload, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const expected = sign(raw)
  const got = Buffer.from(signature)
  const want = Buffer.from(expected)
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  const [version, docId, ownerUid, issued] = raw.split('.')
  if (version !== VERSION || !docId || !ownerUid) return null
  const issuedAtMs = Number(issued)
  if (!Number.isFinite(issuedAtMs)) return null
  return { docId, ownerUid, issuedAtMs }
}
