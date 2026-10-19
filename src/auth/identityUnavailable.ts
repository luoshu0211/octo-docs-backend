/** Failure to contact/understand the identity authority is not session expiry. */
export class IdentityUnavailableError extends Error {
  constructor() {
    super('identity service unavailable')
    this.name = 'IdentityUnavailableError'
  }
}

export function identityUnavailable(
  reason: 'transport_error' | 'non_ok_response' | 'malformed_response',
  upstreamStatus?: number,
): IdentityUnavailableError {
  // Never include the session token, response body, URL or transport message.
  // eslint-disable-next-line no-console
  console.warn('[octo-docs] identity_verify_unavailable', {
    reason,
    ...(upstreamStatus === undefined ? {} : { status: upstreamStatus }),
  })
  return new IdentityUnavailableError()
}
