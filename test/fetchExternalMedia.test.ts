import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { IncomingMessage, RequestOptions } from 'node:http'

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('node:http', () => ({ default: { request: mocks.request } }))
vi.mock('node:https', () => ({ default: { request: mocks.request } }))
import { fetchExternalImage, fetchExternalMedia } from '../src/util/fetchExternalImage.js'
import { config } from '../src/config/env.js'

interface Reply { status?: number; location?: string; bytes?: Buffer; keepOpen?: boolean }
let replies: Reply[]
let requests: Array<EventEmitter & { end: () => void; destroy: ReturnType<typeof vi.fn> }>
beforeEach(() => {
  vi.resetAllMocks()
  replies = [{ bytes: Buffer.from('media') }]
  requests = []
  mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  mocks.request.mockImplementation((_options: RequestOptions, cb: (res: IncomingMessage) => void) => {
    const reply = replies.shift() ?? {}
    const req = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end() {
        queueMicrotask(() => {
          const res = Object.assign(new PassThrough(), {
            statusCode: reply.status ?? 200,
            headers: { 'content-type': 'application/octet-stream', location: reply.location },
          })
          cb(res as unknown as IncomingMessage)
          if (reply.bytes) res.write(reply.bytes)
          if (!reply.keepOpen) res.end()
        })
      },
    })
    requests.push(req)
    return req
  })
})
afterEach(() => vi.useRealTimers())

it('retains the image Accept contract while supporting media and forwarding no credentials', async () => {
  await fetchExternalMedia('https://cdn.example/file?key=public', 100)
  const options = mocks.request.mock.calls[0]![0] as RequestOptions
  expect(options.headers).toMatchObject({ Accept: 'image/*,audio/*,video/*,application/octet-stream' })
  expect(options.headers).not.toHaveProperty('Authorization')
  expect(options.headers).not.toHaveProperty('Cookie')
  expect(options).not.toHaveProperty('auth')
  expect(options.path).toBe('/file?key=public')
  replies.push({ bytes: Buffer.from('image') })
  await fetchExternalImage('https://cdn.example/image', 100)
  expect(mocks.request.mock.calls[1]![0].headers.Accept).toBe('image/*')
})
it('pins the connection lookup to the single validated DNS result', async () => {
  await fetchExternalMedia('https://cdn.example/media', 100)
  const callback = vi.fn()
  mocks.request.mock.calls[0]![0].lookup('cdn.example', {}, callback)
  expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4)
  expect(mocks.lookup).toHaveBeenCalledTimes(1)
})
it.each(['http://127.0.0.1/x', 'http://169.254.169.254/x', 'http://[::1]/x', 'https://cdn.example:8080/x', 'file:///tmp/video'])('blocks unsafe media source %s', async (url) => {
  await expect(fetchExternalMedia(url, 100)).rejects.toHaveProperty('code')
  expect(mocks.request).not.toHaveBeenCalled()
})
it('blocks mixed public/private DNS answers', async () => {
  mocks.lookup.mockResolvedValue([{ address: '93.184.216.34' }, { address: '10.0.0.1' }])
  await expect(fetchExternalMedia('https://cdn.example/x', 100)).rejects.toHaveProperty('code', 'ssrf_blocked')
  expect(mocks.request).not.toHaveBeenCalled()
})
it('revalidates redirects and refuses metadata targets without a second connection', async () => {
  replies = [{ status: 302, location: 'http://169.254.169.254/latest' }]
  await expect(fetchExternalMedia('https://cdn.example/x', 100)).rejects.toHaveProperty('code', 'ssrf_blocked')
  expect(mocks.request).toHaveBeenCalledTimes(1)
})
it('follows a safe redirect and resolves the next host independently', async () => {
  replies = [{ status: 302, location: 'https://other.example/x' }, { bytes: Buffer.from('ok') }]
  expect((await fetchExternalMedia('https://cdn.example/x', 100)).bytes.toString()).toBe('ok')
  expect(mocks.lookup).toHaveBeenCalledTimes(2)
})
it('bounds redirect loops', async () => {
  replies = Array.from({ length: config.og.maxRedirects + 1 }, () => ({ status: 302, location: '/loop' }))
  await expect(fetchExternalMedia('https://cdn.example/x', 100)).rejects.toHaveProperty('code', 'fetch_failed')
  expect(mocks.request).toHaveBeenCalledTimes(config.og.maxRedirects + 1)
})
it('accepts the exact streamed byte cap and aborts cap+1', async () => {
  expect((await fetchExternalMedia('https://cdn.example/x', 5)).bytes.length).toBe(5)
  replies.push({ bytes: Buffer.from('123456') })
  await expect(fetchExternalMedia('https://cdn.example/x', 5)).rejects.toHaveProperty('code', 'response_too_large')
  expect(requests[1]!.destroy).toHaveBeenCalled()
})
it('aborts a continuous/unfinished response at the absolute deadline', async () => {
  vi.useFakeTimers()
  replies = [{ bytes: Buffer.from('x'), keepOpen: true }]
  const result = fetchExternalMedia('https://cdn.example/x', 100)
  const rejection = expect(result).rejects.toHaveProperty('code', 'fetch_failed')
  await vi.advanceTimersByTimeAsync(config.og.fetchTimeoutMs + 1)
  await rejection
  expect(requests[0]!.destroy).toHaveBeenCalled()
})
it('includes DNS resolution in the same deadline', async () => {
  vi.useFakeTimers()
  mocks.lookup.mockImplementation(() => new Promise(() => {}))
  const result = fetchExternalMedia('https://cdn.example/x', 100)
  const rejection = expect(result).rejects.toHaveProperty('code', 'fetch_failed')
  await vi.advanceTimersByTimeAsync(config.og.fetchTimeoutMs + 1)
  await rejection
  expect(mocks.request).not.toHaveBeenCalled()
})
