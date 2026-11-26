import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * uk_ user API keys are allow-listed for exactly two POST routes: the metadata
 * lookup drive batches, and the copy primitive drive calls on the user's behalf
 * (§4.4 duplicate). Everything else stays session-token only.
 */
vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: () => ({ verifyApiKey: vi.fn(async (token: string) => (token === 'uk_good' ? { uid: 'u1', spaceId: 's1' } : null)) }),
}))

import { authMiddleware } from '../src/api/middleware/auth.js'

function mockReq(path: string, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    path,
    header: (name: string) => headers[name.toLowerCase()],
  } as never
}

function mockRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this },
    json(b: unknown) { this.body = b; return this },
  }
}

async function run(path: string, headers: Record<string, string>) {
  const req = mockReq(path, headers)
  const res = mockRes()
  const next = vi.fn()
  await authMiddleware(req, res as never, next)
  return { req: req as unknown as Record<string, unknown>, res, next }
}

beforeEach(() => vi.clearAllMocks())

describe('uk_ API key allowlist', () => {
  it('lets a user key call the duplicate route and binds the verified space', async () => {
    const { req, res, next } = await run('/d_src/duplicate', { token: 'uk_good' })
    expect(next).toHaveBeenCalled()
    expect(res.statusCode).toBe(0)
    expect(req.uid).toBe('u1')
    expect(req.principalSpaceId).toBe('s1')
  })

  it('rejects the same key on any other business route', async () => {
    const { res, next } = await run('/d_src/members', { token: 'uk_good' })
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
  })

  it('still rejects an X-Space-Id that disagrees with the key identity', async () => {
    const { res, next } = await run('/d_src/duplicate', { token: 'uk_good', 'x-space-id': 'other' })
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
  })
})
