import { isIP } from 'node:net'

/** Parse only the supported Redis connection fields, without opening a socket. */
export interface RedisConnectionConfig {
  source: 'url' | 'fields'
  host: string
  port: number
  username?: string
  password?: string
  db: number
  tls: boolean
}

export interface RedisEnvironment {
  REDIS_URL?: string
  REDIS_HOST?: string
  REDIS_PORT?: string
  REDIS_USERNAME?: string
  REDIS_PASSWORD?: string
  REDIS_DB?: string
  REDIS_TLS?: string
}

function invalid(name: string, reason: string): never {
  // Never attach the input or URL parser's cause: either may contain credentials.
  throw new Error(`Invalid ${name}: ${reason}`)
}

function integer(raw: string, name: string, min: number, max: number): number {
  const n = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    invalid(name, `expected a decimal integer in ${min}..${max}`)
  }
  return n
}

function credentials(username: string | undefined, password: string | undefined, name: string) {
  if (username && !password) invalid(name, 'username requires a non-empty password')
  return { username: username || undefined, password: password || undefined }
}

function hostname(raw: string, name: string): string {
  const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  if (!host || /[\s/@?#%\\]/u.test(host) || [...host].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
    invalid(name, 'expected a hostname or IP address')
  }
  return host
}

export function parseRedisConfig(env: RedisEnvironment): RedisConnectionConfig {
  const raw = env.REDIS_URL
  if (raw !== undefined && raw !== '') {
    if (!/^rediss?:\/\//.test(raw) || /[\s?#\\]/u.test(raw) ||
      [...raw].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
      invalid('REDIS_URL', 'expected redis:// or rediss:// without whitespace, query or fragment')
    }
    let url: URL
    let username: string
    let password: string
    try {
      url = new URL(raw)
      username = decodeURIComponent(url.username)
      password = decodeURIComponent(url.password)
    } catch {
      invalid('REDIS_URL', 'malformed URL or credential encoding')
    }
    // WHATWG permits an empty explicit port; this contract does not.
    const address = raw.slice(raw.indexOf('://') + 3)
    const slash = address.indexOf('/')
    const authority = slash < 0 ? address : address.slice(0, slash)
    const path = slash < 0 ? '' : address.slice(slash)
    if (authority.endsWith(':')) invalid('REDIS_URL', 'port must not be empty')
    return {
      source: 'url',
      host: hostname(url.hostname, 'REDIS_URL'),
      port: integer(url.port || '6379', 'REDIS_URL port', 1, 65535),
      ...credentials(username, password, 'REDIS_URL'),
      db: integer(path === '' || path === '/' ? '0' : path.slice(1),
        'REDIS_URL database', 0, Number.MAX_SAFE_INTEGER),
      tls: url.protocol === 'rediss:',
    }
  }

  const tls = (env.REDIS_TLS || 'false').trim().toLowerCase()
  if (!['true', 'false', '1', '0'].includes(tls)) invalid('REDIS_TLS', 'expected true/false/1/0')
  const host = hostname(env.REDIS_HOST || '127.0.0.1', 'REDIS_HOST')
  // A colon is valid only in an IPv6 address, never host:port or a URL.
  if (host.includes(':') && !isIP(host)) invalid('REDIS_HOST', 'put the port in REDIS_PORT')
  return {
    source: 'fields', host,
    port: integer((env.REDIS_PORT || '6379').trim(), 'REDIS_PORT', 1, 65535),
    ...credentials(env.REDIS_USERNAME, env.REDIS_PASSWORD, 'REDIS_USERNAME'),
    db: integer((env.REDIS_DB || '0').trim(), 'REDIS_DB', 0, Number.MAX_SAFE_INTEGER),
    tls: tls === 'true' || tls === '1',
  }
}
