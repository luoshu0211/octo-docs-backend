import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpOctoIdentity } from '../src/auth/octoIdentity.js'

afterEach(() => vi.unstubAllGlobals())

describe('HttpOctoIdentity.spaceBots', () => {
  it('returns the Space-qualified Bot ownership directory', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { uid: 'bot_a', creator_uid: 'u_human' },
      { uid: 'bot_b', creator_uid: '' },
    ]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(new HttpOctoIdentity('http://octo.test').spaceBots('s_1', 'tok')).resolves.toEqual([
      { uid: 'bot_a', creatorUid: 'u_human' },
      { uid: 'bot_b' },
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      'http://octo.test/v1/robot/space_bots?space_id=s_1',
      { headers: { token: 'tok' } },
    )
  })

  it.each([
    ['missing token', '', new Response('[]', { status: 200 })],
    ['non-2xx', 'tok', new Response('{}', { status: 401 })],
    ['non-array body', 'tok', new Response('{}', { status: 200 })],
    ['invalid row', 'tok', new Response('[{"uid":7}]', { status: 200 })],
    ['duplicate uid', 'tok', new Response('[{"uid":"b"},{"uid":"b"}]', { status: 200 })],
  ])('fails closed on %s', async (_label, token, response) => {
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(new HttpOctoIdentity('http://octo.test').spaceBots('s_1', token)).resolves.toBeNull()
  })

  it('fails closed on transport errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(new HttpOctoIdentity('http://octo.test').spaceBots('s_1', 'tok')).resolves.toBeNull()
  })
})
