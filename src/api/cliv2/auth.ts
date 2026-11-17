import { lookup } from 'node:dns'
import { Agent, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'

const failures = {
  VALIDATION_ERROR: [400, 'Invalid request.'],
  AUTH_REQUIRED: [401, 'Authentication token is required or invalid.'],
  FORBIDDEN: [403, 'Access denied.'],
  NOT_FOUND: [404, 'Resource not found.'],
  CONFLICT: [409, 'The requested change conflicts with the current resource state.'],
  PAYLOAD_TOO_LARGE: [413, 'Request or result is too large.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Media type is not supported.'],
  DUPLICATE: [409, 'The resource already exists.'],
  RATE_LIMITED: [429, 'Too many requests.'],
  INTERNAL_ERROR: [500, 'Internal server error.'],
  UPSTREAM_UNAVAILABLE: [503, 'Authentication service unavailable.'],
} as const

export class CliError extends Error {
  constructor(readonly code: keyof typeof failures, readonly details?: Record<string, unknown>) {
    super(failures[code][1])
  }

  get status() { return failures[this.code][0] }

  get envelope() {
    return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) } }
  }
}

type PermissionGroup = { domain: string; actions: string[] }
export type CliPrincipal = { userId: string; spaceId: string }
type CliAccess = { principal: CliPrincipal; permissions: PermissionGroup[] }

const trustedPeers = new BlockList()
trustedPeers.addSubnet('127.0.0.0', 8)
trustedPeers.addSubnet('10.0.0.0', 8)
trustedPeers.addSubnet('172.16.0.0', 12)
trustedPeers.addSubnet('192.168.0.0', 16)
trustedPeers.addAddress('::1', 'ipv6')
trustedPeers.addSubnet('fc00::', 7, 'ipv6')

function isInternalPeer(address: string): boolean {
  const family = isIP(address)
  return family !== 0 && trustedPeers.check(address, family === 6 ? 'ipv6' : 'ipv4')
}

// Like the Go Auth SDK, send cleartext credentials only to an internal peer.
// Return the vetted address to the socket so it does not get resolved again.
const internalAgent = new Agent({
  keepAlive: true,
  lookup(hostname, options, callback) {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) { callback(error, ''); return }
      const peers = addresses.filter(({ address }) => isInternalPeer(address))
      const first = peers[0]
      if (!first) { callback(new Error('Auth requires an internal HTTP peer'), ''); return }
      if (options.all) callback(null, peers)
      else callback(null, first.address, first.family)
    })
  },
})

const serviceName = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\.svc(?:\.cluster\.local)?)?$/i

export function cliServiceURL(base: string, path: string): URL {
  let url: URL
  try { url = new URL(base) } catch { throw new Error('Invalid service URL') }
  const host = url.hostname.replace(/^\[|\]$|\.$/g, '')
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && (url.protocol !== 'http:' || !(isInternalPeer(host) || serviceName.test(host))))) {
    throw new Error('Service URL must use HTTPS or an internal HTTP address')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + path
  return url
}

const maxResolveBytes = 1024 * 1024

export function postCliService(url: URL, credential: Record<string, string>, input: unknown): Promise<{ status: number; body: unknown }> {
  const payload = JSON.stringify(input)
  const request = url.protocol === 'http:' ? httpRequest : httpsRequest
  return new Promise((resolve, reject) => {
    const call = request(url, {
      agent: url.protocol === 'http:' ? internalAgent : undefined,
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: {
        ...credential,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (response) => {
      // node:http does not follow redirects.
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxResolveBytes) response.destroy(new Error('Auth response exceeds limit'))
        else chunks.push(chunk)
      })
      response.once('error', reject)
      response.once('end', () => {
        try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) }) }
        catch (error) { reject(error) }
      })
    })
    call.once('error', reject)
    call.end(payload)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isID(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function isPermissionGroup(group: unknown): group is PermissionGroup {
  return isRecord(group) && typeof group.domain === 'string' &&
    Array.isArray(group.actions) && group.actions.every((action: unknown) => typeof action === 'string')
}

export function createAuthResolver(base?: string, secret?: string): ((token: string) => Promise<CliAccess>) | null {
  if (!base?.trim() && !secret?.trim()) return null
  if (!base?.trim() || !secret?.trim()) {
    throw new Error('OCTO_AUTH_SERVER_URL and OCTO_AUTH_SERVICE_SECRET must be configured together')
  }
  if (Buffer.byteLength(secret) < 32 || /\s/.test(secret)) throw new Error('Invalid OCTO_AUTH_SERVICE_SECRET')
  const url = cliServiceURL(base.trim(), '/v2/internal/tokens/_resolve')
  return async (token) => {
    const { status, body } = await postCliService(url, { authorization: 'Bearer ' + secret }, { token })
      .catch(() => { throw new CliError('UPSTREAM_UNAVAILABLE') })
    if (isRecord(body) && isRecord(body.error)) {
      if (status === 401 && body.error.code === 'AUTH_REQUIRED') throw new CliError('AUTH_REQUIRED')
      if (status === 403 && body.error.code === 'FORBIDDEN') throw new CliError('FORBIDDEN')
    }
    const data = isRecord(body) ? body.data : undefined
    if (status !== 200 || !isRecord(data) || !isRecord(data.principal) ||
        !Array.isArray(data.permissions) || !data.permissions.every(isPermissionGroup) ||
        !Array.isArray(data.bot_bindings) || data.bot_bindings.length > 1 ||
        !data.bot_bindings.every((binding: unknown) => isRecord(binding) && isID(binding.bot_id))) {
      throw new CliError('UPSTREAM_UNAVAILABLE')
    }
    const { token_id, subject_type, subject_id, owner_id, space_id } = data.principal
    if (!isID(token_id) || !isID(owner_id) || !isID(space_id) || subject_type !== 'user' || subject_id !== owner_id) {
      throw new CliError('UPSTREAM_UNAVAILABLE')
    }
    return { principal: { userId: owner_id, spaceId: space_id }, permissions: data.permissions }
  }
}

// Match the SDK's whole-field wildcards and require the declared group domain
// to agree with the action pattern. Prefix globs are not granted.
export function hasAction(groups: PermissionGroup[], required: string): boolean {
  if (!/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(required)) return false
  const [domain, verb] = required.split(':')
  return groups.some(({ domain: groupDomain, actions }) => {
    if (groupDomain === '*') return actions.some(action => action === '*' || action === '*:*' || action === '*:' + verb)
    return groupDomain === domain && actions.some(action => action === required || action === domain + ':*')
  })
}
