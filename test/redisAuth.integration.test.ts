import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createTcpServer } from 'node:net'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { Server } from '@hocuspocus/server'
import * as Y from 'yjs'
import { Redis } from 'ioredis'
import { createCollabRedis } from '../src/collab/redis.js'
import { parseRedisConfig, type RedisEnvironment } from '../src/config/redis.js'
import { buildRedisOptions } from '../src/db/redisOptions.js'
import { waitForRedisStartup } from '../src/db/redisLifecycle.js'

const enabled = process.env.REDIS_AUTH_INTEGRATION === '1'
const exec = promisify(execFile)
const cleanups: Array<() => Promise<unknown> | void> = []
const password = `p@ss:/#% ${randomUUID()}`
const prefix = `redis-auth-${randomUUID()}`

async function freePort(host = '127.0.0.1'): Promise<number> {
  const server = createTcpServer()
  server.listen(0, host)
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No TCP port')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
  try { await exited } finally { clearTimeout(timer) }
}

async function redisServer(
  mode: 'none' | 'password' | 'acl' | 'tls' = 'acl',
  host = '127.0.0.1',
  requestedPort?: number,
) {
  const dir = await mkdtemp(join(tmpdir(), 'octo-redis-auth-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const port = requestedPort ?? await freePort(host)
  let extra = ''
  if (mode === 'tls') {
    await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
      '-keyout', join(dir, 'server.key'), '-out', join(dir, 'server.crt')])
    extra = `tls-port ${port}\ntls-cert-file ${join(dir, 'server.crt')}\ntls-key-file ${join(dir, 'server.key')}\ntls-auth-clients no\n`
  }
  const auth = mode === 'none' ? '' : mode === 'password' ? `requirepass ${JSON.stringify(password)}\n` :
    `user default off\nuser docs on ${JSON.stringify('>' + password)} ~${prefix}:* &${prefix}:* +@all\n` +
    `user restricted on ${JSON.stringify('>' + password)} ~${prefix}:* &${prefix}:* +auth +info +ping +select +client\n` +
    `user disabled off ${JSON.stringify('>' + password)} ~* &* +@all\n`
  const config = join(dir, 'redis.conf')
  await writeFile(config, `bind ${host}\nport ${mode === 'tls' ? 0 : port}\nsave ""\nappendonly no\ndir ${dir}\n${auth}${extra}`, { mode: 0o600 })
  const child = spawn('redis-server', [config], { stdio: ['ignore', 'pipe', 'pipe'] })
  cleanups.push(() => stop(child))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Dedicated Redis startup timed out')), 5000)
    const finish = (error?: Error) => {
      clearTimeout(timer); child.off('error', onError); child.off('exit', onExit)
      child.stdout!.off('data', onData)
      if (error) reject(error); else resolve()
    }
    const onError = () => finish(new Error('Cannot start redis-server; install it before enabling integration tests'))
    const onExit = () => finish(new Error('Dedicated Redis exited during startup'))
    const onData = (data: Buffer) => { if (data.toString().includes('Ready to accept connections')) finish() }
    child.on('error', onError); child.on('exit', onExit); child.stdout!.on('data', onData)
  })
  return { port, dir }
}

async function connections(env: RedisEnvironment) {
  vi.resetModules()
  for (const name of ['REDIS_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_USERNAME', 'REDIS_PASSWORD', 'REDIS_DB', 'REDIS_TLS']) {
    vi.stubEnv(name, env[name as keyof RedisEnvironment] ?? '')
  }
  vi.stubEnv('REDIS_PREFIX', prefix)
  vi.stubEnv('COLLAB_TOKEN_PUBLIC_WS_URL', 'ws://localhost:1234')
  const { config } = await import('../src/config/env.js')
  const { getRedis, createRedisSubscriber, closeRedis } = await import('../src/db/redis.js')
  const commands = getRedis()
  const extension = createCollabRedis(config.redis)
  const sub = createRedisSubscriber()
  cleanups.push(async () => { sub.disconnect(); extension.pub.disconnect(); extension.sub.disconnect(); await closeRedis() })
  const channel = `${prefix}:events`
  const startup = () => waitForRedisStartup([commands, extension.pub, extension.sub, sub], config.redis,
    () => sub.subscribe(channel), 3000)
  return { commands, extension, sub, startup, channel, config: config.redis }
}

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe.skipIf(!enabled)('authenticated Redis (dedicated local instances)', () => {
  it('waits through connection refusal when Redis starts within the startup deadline', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const port = await freePort()
    const c = await connections({ REDIS_URL: `redis://127.0.0.1:${port}/2` })
    const startup = c.startup()
    const checked = expect(startup).resolves.toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 250))
    await redisServer('none', '127.0.0.1', port)
    await checked
    expect(log).toHaveBeenCalledWith(expect.stringContaining('connection_failed'))
  })

  it.each(['none', 'password', 'acl'] as const)('covers all four production connections: %s', async mode => {
    const { port } = await redisServer(mode)
    const userinfo = mode === 'none' ? '' : `${mode === 'acl' ? 'docs' : ''}:${encodeURIComponent(password)}@`
    const c = await connections({ REDIS_URL: `redis://${userinfo}127.0.0.1:${port}/2` })
    await c.startup()
    expect(c.commands.options.maxRetriesPerRequest).toBe(2)
    await c.commands.set(`${prefix}:key`, 'value')
    expect(await c.commands.get(`${prefix}:key`)).toBe('value')
    const message = once(c.sub, 'message')
    await c.extension.pub.publish(c.channel, 'from-collab')
    expect(await message).toEqual([c.channel, 'from-collab'])
    const lock = await c.extension.redlock.acquire([`${prefix}:lock`], 1000)
    expect(await c.commands.get(`${prefix}:lock`)).toBeTruthy()
    await lock.release()
    expect(await c.commands.get(`${prefix}:lock`)).toBeNull()
    const db0 = new Redis({ ...buildRedisOptions(c.config), db: 0 })
    cleanups.push(() => db0.disconnect())
    expect(await db0.get(`${prefix}:key`)).toBeNull()
  })

  it('fails closed when Redis rejects the configured DB during connection setup', async () => {
    const { port } = await redisServer('none')
    const c = await connections({ REDIS_URL: `redis://127.0.0.1:${port}/20` })
    await expect(c.startup()).rejects.toThrow('Redis connection_failed')
  })

  it('connects all four clients over IPv6 without the legacy constructor misparsing the host', async () => {
    const { port } = await redisServer('acl', '::1')
    const c = await connections({ REDIS_URL: `redis://docs:${encodeURIComponent(password)}@[::1]:${port}/2` })
    await c.startup()
    expect(c.extension.pub.options.host).toBe('::1')
    const message = once(c.sub, 'message')
    await c.extension.pub.publish(c.channel, 'ipv6')
    expect(await message).toEqual([c.channel, 'ipv6'])
  })

  it('supports raw field credentials, ACL restrictions and auto-resubscription after reconnect', async () => {
    const { port } = await redisServer()
    const c = await connections({ REDIS_HOST: '127.0.0.1', REDIS_PORT: String(port),
      REDIS_USERNAME: 'docs', REDIS_PASSWORD: password, REDIS_DB: '2' })
    await c.startup()
    await expect(c.commands.set('another-namespace:key', 'bad')).rejects.toThrow('NOPERM')
    await expect(c.commands.publish('another-namespace:events', 'bad')).rejects.toThrow('NOPERM')
    const list = String(await c.commands.client('LIST', 'TYPE', 'PUBSUB'))
    const id = list.match(/(?:^|\n)id=(\d+)/)?.[1]
    expect(id).toBeDefined()
    const reconnected = once(c.sub, 'ready')
    await c.commands.client('KILL', 'ID', id!)
    await reconnected
    const received = once(c.sub, 'message')
    await vi.waitFor(async () => expect(await c.commands.publish(c.channel, 'after-reconnect')).toBe(1))
    expect(await received).toEqual([c.channel, 'after-reconnect'])
  })

  it.each(['wrong-password', 'disabled-user', 'missing-channel-permission'] as const)('fails safely: %s', async scenario => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { port } = await redisServer()
    const user = scenario === 'disabled-user' ? 'disabled' : scenario === 'missing-channel-permission' ? 'restricted' : 'docs'
    const c = await connections({ REDIS_URL: `redis://${user}:${encodeURIComponent(scenario === 'wrong-password' ? 'wrong' : password)}@127.0.0.1:${port}` })
    await expect(c.startup()).rejects.toThrow(scenario === 'missing-channel-permission' ? 'acl_denied' : 'auth_failed')
    expect(JSON.stringify(log.mock.calls)).not.toContain(password)
  })

  it('refuses ioredis passwordless-server fallback', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { port } = await redisServer('none')
    const c = await connections({ REDIS_URL: `redis://:${encodeURIComponent(password)}@127.0.0.1:${port}` })
    await expect(c.startup()).rejects.toThrow('auth_failed')
  })

  it('verifies TLS with NODE_EXTRA_CA_CERTS and rejects missing trust or mismatched hostnames', async () => {
    const { port, dir } = await redisServer('tls')
    const run = async (host: string, trust: boolean) => {
      try {
        const result = await exec(process.execPath, ['--import', 'tsx', 'test/helpers/redisTlsClient.ts'], {
          env: { ...process.env, REDIS_URL: `rediss://docs:${encodeURIComponent(password)}@${host}:${port}/2`,
            REDIS_PREFIX: prefix, NODE_EXTRA_CA_CERTS: trust ? join(dir, 'server.crt') : '', NODE_TLS_REJECT_UNAUTHORIZED: '1' },
          timeout: 8000,
        })
        return { ok: true, output: result.stdout + result.stderr }
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string }
        return { ok: false, output: (e.stdout ?? '') + (e.stderr ?? '') }
      }
    }
    expect(await run('localhost', true)).toMatchObject({ ok: true, output: expect.stringContaining('TLS_OK') })
    for (const result of [await run('localhost', false), await run('127.0.0.1', true)]) {
      expect(result).toMatchObject({ ok: false, output: expect.stringContaining('tls_failed') })
      expect(result.output).not.toContain(password)
    }
  }, 20000)

  it('synchronizes two Hocuspocus instances and persists/reloads through authenticated locks', async () => {
    const { port } = await redisServer()
    const config = { ...parseRedisConfig({ REDIS_URL: `redis://docs:${encodeURIComponent(password)}@127.0.0.1:${port}/2` }), prefix }
    const extensions = [createCollabRedis(config), createCollabRedis(config)]
    cleanups.push(() => { for (const e of extensions) { e.pub.disconnect(); e.sub.disconnect() } })
    await waitForRedisStartup(extensions.flatMap(e => [e.pub, e.sub]), config, async () => 0, 3000)
    let stored: Uint8Array | undefined
    const servers = extensions.map(extension => new Server({
      quiet: true, extensions: [extension], debounce: 10, maxDebounce: 50,
      async onLoadDocument({ document }) { if (stored) Y.applyUpdate(document, stored) },
      async onStoreDocument({ document }) { stored = Y.encodeStateAsUpdate(document) },
    }))
    cleanups.push(async () => { for (const server of servers) await server.destroy() })
    const a = await servers[0]!.hocuspocus.openDirectConnection('octo:space:folder:redis-auth')
    const b = await servers[1]!.hocuspocus.openDirectConnection('octo:space:folder:redis-auth')
    cleanups.push(async () => { await a.disconnect(); await b.disconnect() })
    await a.transact(doc => doc.getText('text').insert(0, 'authenticated sync'))
    await vi.waitFor(() => expect(b.document!.getText('text').toString()).toBe('authenticated sync'))
    await b.transact(doc => doc.getText('text').insert(18, '!'))
    await vi.waitFor(() => expect(a.document!.getText('text').toString()).toBe('authenticated sync!'))
    await a.disconnect()
    await b.disconnect()
    expect(stored).toBeDefined()
    const reloaded = await servers[0]!.hocuspocus.openDirectConnection('octo:space:folder:redis-auth')
    cleanups.push(() => reloaded.disconnect())
    expect(reloaded.document!.getText('text').toString()).toBe('authenticated sync!')
  }, 15000)
})
