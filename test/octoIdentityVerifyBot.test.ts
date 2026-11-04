import { describe, it, expect, vi, afterEach } from 'vitest'
import { HttpOctoIdentity } from '../src/auth/octoIdentity.js'

// Verify HttpOctoIdentity.verifyBot calls octo-server's existing
// POST /v1/auth/verify-bot with a { bot_token } body and maps the response
// (bot_uid -> uid, space_id -> spaceId). octo-server owns the space reverse
// lookup, so the client sends only the token and trusts the returned space.

function botResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HttpOctoIdentity.verifyBot — /v1/auth/verify-bot', () => {
  it('posts the bot token and maps bot_uid/space_id/owner_uid to uid/spaceId/ownerUid', async () => {
    const fetchMock = vi.fn(async () =>
      botResponse({ bot_uid: 'bot_9', bot_name: 'Helper', owner_uid: 'u_owner', space_id: 's_42' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const identity = new HttpOctoIdentity('http://octo.test')
    const result = await identity.verifyBot('bot-bearer-token')

    expect(result).toEqual({ uid: 'bot_9', spaceId: 's_42', ownerUid: 'u_owner' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('http://octo.test/v1/auth/verify-bot')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ bot_token: 'bot-bearer-token' })
  })

  it('omits ownerUid when the bot has no human creator (owner_uid empty)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => botResponse({ bot_uid: 'bot_9', owner_uid: '', space_id: 's_42' })),
    )
    const identity = new HttpOctoIdentity('http://octo.test')
    // A platform bot with no human owner: owner_uid comes back '' and must not
    // surface as an ownerUid key (the doc-create grant is then skipped).
    expect(await identity.verifyBot('t')).toEqual({ uid: 'bot_9', spaceId: 's_42' })
  })

  it('omits ownerUid when the response has no owner_uid field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => botResponse({ bot_uid: 'bot_9', space_id: 's_42' })),
    )
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.verifyBot('t')).toEqual({ uid: 'bot_9', spaceId: 's_42' })
  })

  it('returns null when octo-server reverse-resolves no space (spaceless bot must not be authorized)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => botResponse({ bot_uid: 'bot_9', space_id: '' })))
    const identity = new HttpOctoIdentity('http://octo.test')
    // A bot with no resolvable space is rejected at the identity layer (returns
    // null) so verifyBotMiddleware 401s it, rather than proceeding with an empty
    // req.spaceId that would defeat per-space doc scoping.
    expect(await identity.verifyBot('t')).toBeNull()
  })

  it('returns null when the response omits space_id entirely', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => botResponse({ bot_uid: 'bot_9' })))
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.verifyBot('t')).toBeNull()
  })

  it('returns null without calling fetch when the token is empty', async () => {
    const fetchMock = vi.fn(async () => botResponse({}))
    vi.stubGlobal('fetch', fetchMock)
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.verifyBot('')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null on a non-OK response (invalid bot token => 401)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => botResponse({ msg: 'invalid bot token' }, false, 401)))
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.verifyBot('bad')).toBeNull()
  })

  it('returns null when the response lacks a bot_uid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => botResponse({ space_id: 's_1' })))
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.verifyBot('t')).toBeNull()
  })

  it('returns null when the identity source is unreachable (fetch throws)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.verifyBot('t')).toBeNull()
  })
})

describe('HttpOctoIdentity.verifyApiKey — /v1/auth/verify-api-key', () => {
  it('posts the native API key and maps uid/space_id to a verified human principal', async () => {
    const fetchMock = vi.fn(async () =>
      botResponse({ uid: 'u_reader', space_id: 's_current' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const identity = new HttpOctoIdentity('http://octo.test')
    const result = await identity.verifyApiKey('uk_native_key')

    expect(result).toEqual({ uid: 'u_reader', spaceId: 's_current' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('http://octo.test/v1/auth/verify-api-key')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ api_key: 'uk_native_key' })
  })

  it('returns null for rejected keys and responses without a bound uid or Space', async () => {
    const responses = [
      botResponse({ msg: 'invalid api key' }, false, 401),
      botResponse({ uid: 'u_reader' }),
      botResponse({ space_id: 's_current' }),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!))

    const identity = new HttpOctoIdentity('http://octo.test')
    await expect(identity.verifyApiKey('uk_rejected')).resolves.toBeNull()
    await expect(identity.verifyApiKey('uk_missing_space')).resolves.toBeNull()
    await expect(identity.verifyApiKey('uk_missing_uid')).resolves.toBeNull()
  })
})
