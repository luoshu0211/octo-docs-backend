import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRedisConfig } from '../src/config/redis.js'
import { observeRedisErrors, waitForRedisStartup } from '../src/db/redisLifecycle.js'

class FakeRedis extends EventEmitter {
  status = 'connecting'
  auth = vi.fn<(...args: string[]) => Promise<unknown>>().mockResolvedValue('OK')
  disconnect = vi.fn(() => { this.status = 'end' })
  ready() { this.status = 'ready'; this.emit('ready') }
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('Redis startup lifecycle', () => {
  it('waits for all four clients and authenticates each before subscribing', async () => {
    const clients = Array.from({ length: 4 }, () => new FakeRedis())
    const subscribe = vi.fn().mockResolvedValue(3)
    const startup = waitForRedisStartup(clients, parseRedisConfig({ REDIS_URL: 'redis://docs:pass@host' }), subscribe)
    clients.slice(0, 3).forEach(c => c.ready())
    await Promise.resolve()
    expect(subscribe).not.toHaveBeenCalled()
    clients[3]!.ready()
    await startup
    for (const client of clients) {
      expect(client.auth).toHaveBeenCalledWith('docs', 'pass')
      expect(client.listenerCount('ready')).toBe(0)
      expect(client.listenerCount('error')).toBe(0)
      expect(client.listenerCount('end')).toBe(0)
      expect(client.disconnect).not.toHaveBeenCalled()
    }
    expect(subscribe).toHaveBeenCalledOnce()
  })

  it('accepts already-ready connections and sends no AUTH for legacy config', async () => {
    const client = new FakeRedis(); client.ready()
    await waitForRedisStartup([client], parseRedisConfig({}), async () => 3)
    expect(client.auth).not.toHaveBeenCalled()
  })

  it('rejects a password supplied to a passwordless server without leaking AUTH args', async () => {
    const client = new FakeRedis(); client.ready()
    client.auth.mockRejectedValue(Object.assign(new Error('ERR AUTH called without any password configured'),
      { command: { name: 'auth', args: ['private-value'] } }))
    const subscribe = vi.fn()
    await expect(waitForRedisStartup([client], parseRedisConfig({ REDIS_PASSWORD: 'private-value' }), subscribe))
      .rejects.toThrow('Redis auth_failed')
    expect(client.disconnect).toHaveBeenCalledOnce()
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('redacts the same AUTH error used to reject queued business work on reconnect', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = new FakeRedis()
    observeRedisErrors(client, 'commands')
    const error = Object.assign(new Error('WRONGPASS private-value'), {
      command: { name: 'auth', args: ['user', 'private-value'] }, cause: 'private-value',
    })
    // ioredis flushQueue rejects promises before synchronously emitting error.
    const queued = Promise.reject(error).catch(e => String(e.stack) + JSON.stringify(e))
    client.emit('error', error)
    expect(await queued).not.toContain('private-value')
    expect(log).toHaveBeenCalledWith('[octo-docs] Redis commands: auth_failed')
    expect(client.disconnect).not.toHaveBeenCalled() // runtime retries belong to ioredis
  })

  it('fails immediately on AUTH errors, closes every connection and cleans listeners', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const clients = [new FakeRedis(), new FakeRedis()]
    observeRedisErrors(clients[0]!, 'commands')
    const startup = waitForRedisStartup(clients, parseRedisConfig({}), async () => 3)
    const checked = expect(startup).rejects.toThrow('auth_failed')
    clients[0]!.emit('error', new Error('WRONGPASS wrong password'))
    await checked
    for (const client of clients) {
      expect(client.disconnect).toHaveBeenCalledOnce()
      expect(client.listenerCount('ready')).toBe(0)
      expect(client.listenerCount('end')).toBe(0)
    }
    expect(clients[0]!.listenerCount('error')).toBe(1) // permanent safe logging remains
  })

  it('keeps waiting after a transient connection failure and succeeds before the deadline', async () => {
    const client = new FakeRedis()
    const subscribe = vi.fn().mockResolvedValue(3)
    const startup = waitForRedisStartup([client], parseRedisConfig({}), subscribe, 100)
    client.emit('error', Object.assign(new Error('connect ECONNREFUSED private-host'), { code: 'ECONNREFUSED' }))
    await Promise.resolve()
    expect(client.disconnect).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
    client.ready()
    await startup
    expect(subscribe).toHaveBeenCalledOnce()
  })

  it('revokes stale readiness when a client reconnects before the other clients are ready', async () => {
    const clients = Array.from({ length: 4 }, () => new FakeRedis())
    const subscribe = vi.fn().mockResolvedValue(3)
    const startup = waitForRedisStartup(clients, parseRedisConfig({}), subscribe, 100)
    clients[0]!.ready()
    clients[0]!.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
    clients[0]!.status = 'reconnecting'
    clients.slice(1).forEach(client => client.ready())
    await Promise.resolve()
    expect(subscribe).not.toHaveBeenCalled()
    clients[0]!.ready()
    await startup
    expect(subscribe).toHaveBeenCalledOnce()
  })

  it('disconnects every client when transient connection failures outlast the deadline', async () => {
    vi.useFakeTimers()
    const clients = [new FakeRedis(), new FakeRedis()]
    const startup = waitForRedisStartup(clients, parseRedisConfig({}), async () => 3, 100)
    const checked = expect(startup).rejects.toThrow('Redis startup timed out')
    clients[0]!.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    await vi.advanceTimersByTimeAsync(100)
    await checked
    for (const client of clients) expect(client.disconnect).toHaveBeenCalledOnce()
  })

  it('fails immediately when a Redis setup command is rejected', async () => {
    const client = new FakeRedis()
    const startup = waitForRedisStartup([client], parseRedisConfig({ REDIS_DB: '20' }), async () => 3, 100)
    const checked = expect(startup).rejects.toThrow('Redis connection_failed')
    client.emit('error', Object.assign(new Error('ERR DB index is out of range'), { command: { name: 'select' } }))
    await checked
    expect(client.disconnect).toHaveBeenCalledOnce()
  })

  it.each(['readiness', 'authentication', 'subscription'])('bounds %s by the same startup deadline', async stage => {
    vi.useFakeTimers()
    const client = new FakeRedis()
    if (stage !== 'readiness') client.ready()
    if (stage === 'authentication') client.auth.mockReturnValue(new Promise(() => {}))
    const subscribe = () => stage === 'subscription' ? new Promise(() => {}) : Promise.resolve(3)
    const startup = waitForRedisStartup([client], parseRedisConfig({ REDIS_PASSWORD: 'pass' }), subscribe, 100)
    const checked = expect(startup).rejects.toThrow('Redis startup timed out')
    await vi.advanceTimersByTimeAsync(100)
    await checked
    expect(client.disconnect).toHaveBeenCalledOnce()
    expect(client.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects subscription ACL failures and closed clients', async () => {
    const client = new FakeRedis(); client.ready()
    await expect(waitForRedisStartup([client], parseRedisConfig({}), async () => {
      throw Object.assign(new Error('NOPERM private-channel'), { command: { args: ['private-channel'] } })
    })).rejects.toThrow('Redis acl_denied')
    await expect(waitForRedisStartup([client], parseRedisConfig({}), async () => 3))
      .rejects.toThrow('ended during startup')
  })
})
