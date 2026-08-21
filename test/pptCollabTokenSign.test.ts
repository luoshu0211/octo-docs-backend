// Env seeding MUST be first so config/env.ts reads it at load time.
import './helpers/pptRelayEnv.js'

import { beforeEach, describe, it, expect, vi } from 'vitest'
import {
  issuePptCollabToken,
  verifyPptRelayToken,
  verifyPptRelayTicket,
  InMemoryTicketStore,
  PPT_RELAY_AUD,
  PPT_RELAY_TICKET_AUD,
} from '../src/auth/pptCollabToken.js'
import jwt from 'jsonwebtoken'
import { config } from '../src/config/env.js'

/**
 * R4-B1 unit coverage for the PPT relay token + one-time WS ticket (§7.1),
 * underpinning PPT-TOKEN-001 (issuance contents) and the single-use ticket half
 * of PPT-WS-001. Pure sign/verify — no network, no DB.
 */
describe('PPT collab token + one-time ticket (§7.1)', () => {
  beforeEach(() => {
    config.collabToken.allowLegacyWithoutHomeSpaceProof = false
  })
  const base = {
    uid: 'u_1',
    docId: 'd_ppt1',
    documentName: 'octo:s_1:f_default:ppt:d_ppt1',
    role: 'writer' as const,
    permission_epoch: 3,
    principalSpaceId: 's_1',
    snapshotVersion: 7,
    homeSpaceVerified: true,
    name: 'Ada',
  }

  it('issues a relay token + ticket carrying the required fields (PPT-TOKEN-001)', () => {
    const r = issuePptCollabToken(base)
    expect(r.token).toBeTruthy()
    expect(r.ticket).toBeTruthy()
    expect(r.role).toBe('writer')
    expect(r.epoch).toBe(3)
    expect(r.docId).toBe('d_ppt1')
    expect(r.documentName).toBe(base.documentName)
    expect(r.snapshotVersion).toBe(7)
    expect(r.name).toBe('Ada')
    expect(r.pptWsUrl).toBe('ws://ppt-relay.example.test')
    expect(typeof r.expiresAt).toBe('string')
    expect(typeof r.ticketExpiresAt).toBe('string')
    // token and ticket are distinct credentials with distinct audiences.
    expect(r.token).not.toBe(r.ticket)
  })

  it('the relay token has aud=ppt-relay; the ticket has aud=ppt-relay-ticket + a jti', () => {
    const r = issuePptCollabToken(base)
    const tok = verifyPptRelayToken(r.token)
    expect(tok.uid).toBe('u_1')
    expect(tok.role).toBe('writer')
    expect(tok.permission_epoch).toBe(3)
    expect(tok.principal_space_id).toBe('s_1')

    const tik = verifyPptRelayTicket(r.ticket)
    expect(tik.docId).toBe('d_ppt1')
    expect(tik.principal_space_id).toBe('s_1')
    expect(typeof tik.jti).toBe('string')
    expect(tik.jti.length).toBeGreaterThan(0)

    // raw payload audiences are exactly as specified.
    expect((jwt.decode(r.token) as { aud?: string }).aud).toBe(PPT_RELAY_AUD)
    expect((jwt.decode(r.ticket) as { aud?: string }).aud).toBe(PPT_RELAY_TICKET_AUD)
  })

  it('rejects pre-hotfix relay credentials without verified home-Space proof', () => {
    const legacyClaims = {
      uid: 'u_legacy',
      docId: 'd_ppt1',
      documentName: base.documentName,
      role: 'writer',
      permission_epoch: 3,
    }
    const legacyToken = jwt.sign(legacyClaims, config.collabToken.secret, {
      algorithm: 'HS256', audience: PPT_RELAY_AUD, expiresIn: 60,
    })
    const legacyTicket = jwt.sign({ ...legacyClaims, jti: 'legacy-jti' }, config.collabToken.secret, {
      algorithm: 'HS256', audience: PPT_RELAY_TICKET_AUD, expiresIn: 60,
    })
    expect(() => verifyPptRelayToken(legacyToken)).toThrow(/home-space proof/)
    expect(() => verifyPptRelayTicket(legacyTicket)).toThrow(/home-space proof/)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    config.collabToken.allowLegacyWithoutHomeSpaceProof = true
    expect(verifyPptRelayToken(legacyToken).uid).toBe('u_legacy')
    expect(verifyPptRelayTicket(legacyTicket).jti).toBe('legacy-jti')
    expect(warn).toHaveBeenCalledWith(
      '[octo-docs] legacy_home_space_token_accepted',
      { credentialKind: 'ppt_relay' },
    )
    expect(warn).toHaveBeenCalledWith(
      '[octo-docs] legacy_home_space_token_accepted',
      { credentialKind: 'ppt_ticket' },
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain('u_legacy')
    warn.mockRestore()
  })

  it('recovers same-Space principal context for rollout credentials that predate the claim', () => {
    const legacyClaims = {
      uid: 'u_legacy',
      docId: 'd_ppt1',
      documentName: base.documentName,
      role: 'writer',
      permission_epoch: 3,
      home_space_verified: true,
    }
    const token = jwt.sign(legacyClaims, config.collabToken.secret, {
      algorithm: 'HS256', audience: PPT_RELAY_AUD, expiresIn: 60,
    })
    expect(verifyPptRelayToken(token).principal_space_id).toBe('s_1')
  })

  it('rejects a rollout credential without a principal claim when documentName is not canonical PPT addressing', () => {
    const malformed = jwt.sign({
      uid: 'u_legacy',
      docId: 'd_ppt1',
      documentName: 'octo:s_1:f_default:d_ppt1',
      role: 'writer',
      permission_epoch: 3,
      home_space_verified: true,
    }, config.collabToken.secret, {
      algorithm: 'HS256', audience: PPT_RELAY_AUD, expiresIn: 60,
    })
    expect(() => verifyPptRelayToken(malformed)).toThrow(/invalid ppt collab token claims/)
  })

  it('cross-audience replay is rejected: a relay token is not a valid ticket (and vice versa)', () => {
    const r = issuePptCollabToken(base)
    expect(() => verifyPptRelayTicket(r.token)).toThrow()
    expect(() => verifyPptRelayToken(r.ticket)).toThrow()
  })

  it('a tampered/forged credential fails verification', () => {
    const forged = jwt.sign({ uid: 'u_x', docId: 'd', documentName: 'n', role: 'admin', permission_epoch: 0 }, 'wrong-secret', {
      algorithm: 'HS256',
      audience: PPT_RELAY_AUD,
      expiresIn: 60,
    })
    expect(() => verifyPptRelayToken(forged)).toThrow()
  })

  it('omits name / pptWsUrl when not supplied / unconfigured is handled by config', () => {
    const r = issuePptCollabToken({ ...base, name: undefined })
    expect(r.name).toBeUndefined()
    // pptWsUrl is present because the test env sets PPT_RELAY_PUBLIC_WS_URL.
    expect(r.pptWsUrl).toBe(config.ppt.relay.publicWsUrl)
  })

  describe('InMemoryTicketStore single-use (PPT-WS-001 ticket half)', () => {
    it('consumes a jti exactly once', async () => {
      const store = new InMemoryTicketStore()
      expect(await store.consume('jti-1')).toBe(true)
      expect(await store.consume('jti-1')).toBe(false)
      expect(await store.consume('jti-2')).toBe(true)
    })
  })
})
