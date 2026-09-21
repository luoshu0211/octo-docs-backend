import type { RedisConnectionConfig } from '../config/redis.js'

/** Structural interface shared by both locked ioredis versions. */
export interface RedisConnection {
  status: string
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
  disconnect(): void
  auth(password: string): Promise<unknown>
  auth(username: string, password: string): Promise<unknown>
}

export type RedisPurpose = 'commands' | 'collab-pub' | 'collab-sub' | 'events'
export type RedisFailure = 'auth_failed' | 'acl_denied' | 'tls_failed' | 'connection_failed'

export function redisFailure(error: unknown): RedisFailure {
  const e = error as { message?: unknown; code?: unknown; command?: { name?: unknown } } | null
  const message = typeof e?.message === 'string' ? e.message : ''
  if (String(e?.command?.name).toLowerCase() === 'auth' || /WRONGPASS|NOAUTH|auth[_ ]failed/i.test(message)) return 'auth_failed'
  if (/NOPERM/.test(message)) return 'acl_denied'
  if (typeof e?.code === 'string' && /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(e.code)) return 'tls_failed'
  return 'connection_failed'
}

export function safeRedisError(error: unknown): Error {
  return new Error(`Redis ${redisFailure(error)}`)
}

/** AUTH errors are also used to reject queued business commands on reconnect.
 * Strip their payload before those promise handlers (including framework logs)
 * run. ioredis flushes the queue and emits this same object synchronously.
 */
export function observeRedisErrors(client: RedisConnection, purpose: RedisPurpose): void {
  client.on('error', (error: unknown) => {
    const failure = redisFailure(error)
    if (failure === 'auth_failed' && error instanceof Error) {
      for (const key of Object.keys(error)) Reflect.deleteProperty(error, key)
      error.message = 'Redis auth_failed'
      error.stack = 'Error: Redis auth_failed'
      Reflect.deleteProperty(error, 'cause')
    }
    // eslint-disable-next-line no-console
    console.error(`[octo-docs] Redis ${purpose}: ${failure}`)
  })
}

export const REDIS_STARTUP_TIMEOUT_MS = 10_000

/** Keep one deadline across readiness, explicit AUTH and event subscription.
 * Explicit AUTH also rejects ioredis' compatibility fallback when a password
 * was supplied to a server with no password configured.
 */
export async function waitForRedisStartup(
  clients: RedisConnection[],
  config: RedisConnectionConfig,
  subscribe: () => Promise<unknown>,
  timeoutMs = REDIS_STARTUP_TIMEOUT_MS,
): Promise<void> {
  const disposers: Array<() => void> = []
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const failure = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Redis startup timed out')), timeoutMs)
      for (const client of clients) {
        // ioredis retries transport failures itself. Keep waiting within the
        // shared startup deadline, but fail fast for configuration/permission
        // failures that cannot recover without an operator change.
        const onError = (error: unknown) => {
          const failure = redisFailure(error)
          const command = (error as { command?: unknown } | null)?.command
          if (failure !== 'connection_failed' || command) reject(new Error(`Redis ${failure}`))
        }
        const onEnd = () => reject(new Error('Redis connection ended during startup'))
        client.on('error', onError)
        client.on('end', onEnd)
        disposers.push(() => { client.off('error', onError); client.off('end', onEnd) })
      }
    })
    const waitUntilAllReady = () => new Promise<void>((resolve, reject) => {
      const removeReadyListeners = () => {
        for (const client of clients) client.off('ready', onReady)
      }
      const onReady = () => {
        if (clients.some(client => client.status === 'end')) {
          removeReadyListeners()
          reject(new Error('Redis connection ended during startup'))
          return
        }
        if (clients.every(client => client.status === 'ready')) {
          removeReadyListeners()
          resolve()
        }
      }
      for (const client of clients) client.on('ready', onReady)
      onReady()
      disposers.push(removeReadyListeners)
    })
    await Promise.race([waitUntilAllReady(), failure])
    if (config.password) {
      await Promise.race([
        Promise.all(clients.map(client => (config.username
          ? client.auth(config.username, config.password!) : client.auth(config.password!))
          .catch(error => { throw safeRedisError(error) }))),
        failure,
      ])
    }
    await Promise.race([subscribe().catch(error => { throw safeRedisError(error) }), failure])
    await Promise.race([waitUntilAllReady(), failure])
  } catch (error) {
    for (const client of clients) client.disconnect()
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    for (const dispose of disposers) dispose()
  }
}
