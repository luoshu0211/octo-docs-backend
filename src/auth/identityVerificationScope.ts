import { AsyncLocalStorage } from 'node:async_hooks'
import type { NextFunction, Request, Response } from 'express'

export interface IdentityVerificationResponse {
  ok: boolean
  status: number
  body: unknown
}

interface VerificationScope {
  active: boolean
  responses: Map<object, Map<string, Promise<IdentityVerificationResponse>>>
}

const scopes = new AsyncLocalStorage<VerificationScope>()

/** Share an authority response only while this HTTP request is being handled. */
export function identityVerificationScope(_req: Request, res: Response, next: NextFunction): void {
  const scope: VerificationScope = { active: true, responses: new Map() }
  const close = () => {
    scope.active = false
    scope.responses.clear()
  }
  // Detached async work can inherit AsyncLocalStorage. Explicitly close the
  // scope so such work cannot reuse an authenticated session after the response.
  res.once('finish', close)
  res.once('close', close)
  scopes.run(scope, next)
}

export function requestIdentityVerification(owner: object, key: string): Promise<IdentityVerificationResponse> | undefined {
  const scope = scopes.getStore()
  return scope?.active ? scope.responses.get(owner)?.get(key) : undefined
}

export function reuseRequestIdentityVerification(
  owner: object,
  key: string,
  load: () => Promise<IdentityVerificationResponse>,
): Promise<IdentityVerificationResponse> {
  const scope = scopes.getStore()
  if (!scope?.active) return load()
  let responses = scope.responses.get(owner)
  if (!responses) {
    responses = new Map()
    scope.responses.set(owner, responses)
  }
  const existing = responses.get(key)
  if (existing) return existing
  const pending = load()
  responses.set(key, pending)
  return pending
}
