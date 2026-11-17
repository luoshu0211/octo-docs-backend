import { AsyncLocalStorage } from 'node:async_hooks'

type CliSpace = { uid: string; spaceId: string }

const verifiedCli = new AsyncLocalStorage<CliSpace>()

/** Only the v2 router may bind the authenticated user's Space to a request. */
export function withVerifiedCliSpace<T>(scope: CliSpace, run: () => T): T {
  return verifiedCli.run(scope, run)
}

export function verifiedCliSpace(uid: string): string | undefined {
  const scope = verifiedCli.getStore()
  return scope?.uid === uid ? scope.spaceId : undefined
}
