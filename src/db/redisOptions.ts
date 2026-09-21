import { isIP } from 'node:net'
import type { RedisOptions } from 'ioredis'
import type { RedisConnectionConfig } from '../config/redis.js'

/** Fresh connection options only; key namespaces and retry policies belong to callers. */
export function buildRedisOptions(config: RedisConnectionConfig): RedisOptions {
  return {
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    db: config.db,
    ...(config.tls ? {
      tls: {
        rejectUnauthorized: true,
        ...(!isIP(config.host) ? { servername: config.host } : {}),
      },
    } : {}),
  }
}
