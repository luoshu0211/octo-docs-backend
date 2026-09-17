import { describe, expect, it } from 'vitest'
import { parseRedisConfig } from '../src/config/redis.js'
import { buildRedisOptions } from '../src/db/redisOptions.js'

describe('Redis connection configuration', () => {
  it('preserves legacy defaults and host/port overrides', () => {
    expect(parseRedisConfig({})).toEqual({ source: 'fields', host: '127.0.0.1', port: 6379,
      username: undefined, password: undefined, db: 0, tls: false })
    expect(parseRedisConfig({ REDIS_HOST: 'redis.internal', REDIS_PORT: '6380' }))
      .toMatchObject({ host: 'redis.internal', port: 6380 })
  })

  it('uses URL fields exclusively, including omitted URL credentials and defaults', () => {
    const config = parseRedisConfig({ REDIS_URL: 'redis://redis.internal', REDIS_HOST: 'old.internal',
      REDIS_PORT: 'bad', REDIS_USERNAME: 'old', REDIS_PASSWORD: 'old-password', REDIS_DB: 'bad', REDIS_TLS: 'bad' })
    expect(config).toEqual({ source: 'url', host: 'redis.internal', port: 6379,
      username: undefined, password: undefined, db: 0, tls: false })
  })

  it.each([
    ['redis://:pass@redis.internal/', undefined, 'pass', 0, false],
    ['redis://docs:pass@redis.internal:6380/2', 'docs', 'pass', 2, false],
    ['rediss://docs:pass@redis.internal/0', 'docs', 'pass', 0, true],
    ['redis://docs:p%40ss%3A%2F%23%25@redis.internal', 'docs', 'p@ss:/#%', 0, false],
    ['redis://%E7%94%A8%E6%88%B7:%20%2520%20@redis.internal', '用户', ' %20 ', 0, false],
  ])('parses credentials exactly once: %s', (url, username, password, db, tls) => {
    expect(parseRedisConfig({ REDIS_URL: url })).toMatchObject({ username, password, db, tls })
  })

  it('preserves raw field passwords and accepts IPv6 in either mode', () => {
    expect(parseRedisConfig({ REDIS_PASSWORD: ' %40# ', REDIS_DB: '2', REDIS_TLS: 'TRUE' }))
      .toMatchObject({ password: ' %40# ', db: 2, tls: true })
    expect(parseRedisConfig({ REDIS_URL: 'redis://:pass@[::1]:6380/2' }))
      .toMatchObject({ host: '::1', port: 6380, db: 2 })
    expect(parseRedisConfig({ REDIS_HOST: '::1' }).host).toBe('::1')
  })

  it.each([
    ' ', 'redis://', 'http://host', 'redis://host:', 'redis://host:0', 'redis://host:65536',
    'redis://host:-1', 'redis://host:1.2', 'redis://host/-1', 'redis://host/1.5',
    'redis://host/1/2', 'redis://host/1/../2', 'redis://host/%32', 'redis://host/9007199254740992',
    'redis://host?', 'redis://host#', 'redis://host/?password=private', 'redis://host/#private',
    'redis://user@host', 'redis://user:@host', 'redis://:%ZZ@host', 'redis://:%FF@host',
    'redis://:raw password@host', 'redis://host\n', 'redis://host\\path',
  ])('rejects malformed URLs without printing them: %j', url => {
    try {
      parseRedisConfig({ REDIS_URL: url, REDIS_HOST: 'valid-fallback' })
      expect.fail('expected invalid URL')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/^Invalid REDIS_URL/)
      if (url.trim()) expect((error as Error).stack).not.toContain(url)
      expect(error).not.toHaveProperty('cause')
    }
  })

  it.each([
    { REDIS_PORT: '0' }, { REDIS_PORT: '65536' }, { REDIS_PORT: '1e3' }, { REDIS_PORT: '0x19eb' },
    { REDIS_DB: '-1' }, { REDIS_DB: 'Infinity' }, { REDIS_DB: '1.5' }, { REDIS_TLS: 'yes' },
    { REDIS_USERNAME: 'docs' }, { REDIS_USERNAME: 'docs', REDIS_PASSWORD: '' },
    { REDIS_HOST: 'redis://:private@host' }, { REDIS_HOST: 'host:6379' },
  ])('rejects invalid field configuration: %j', env => {
    expect(() => parseRedisConfig(env)).toThrow(/^Invalid REDIS_/)
  })

  it('creates independent TLS options with DNS SNI and no duplicate key prefix', () => {
    const config = parseRedisConfig({ REDIS_URL: 'rediss://docs:pass@redis.internal/2' })
    const a = buildRedisOptions(config)
    const b = buildRedisOptions(config)
    expect(a).toMatchObject({ host: 'redis.internal', port: 6379, username: 'docs', password: 'pass', db: 2,
      tls: { rejectUnauthorized: true, servername: 'redis.internal' } })
    expect(a.tls).not.toBe(b.tls)
    expect(a).not.toHaveProperty('keyPrefix')
    expect(a).not.toHaveProperty('maxRetriesPerRequest')
    expect(buildRedisOptions(parseRedisConfig({ REDIS_URL: 'rediss://[::1]' })).tls)
      .toEqual({ rejectUnauthorized: true })
    expect(buildRedisOptions(parseRedisConfig({}))).not.toHaveProperty('tls')
  })
})
