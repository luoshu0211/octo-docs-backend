import { setTimeout as delay } from 'node:timers/promises'

const { ARGOCD_SERVER, ARGOCD_TOKEN, CONTAINER_IMAGE, DEPLOY_REVISION, IMAGE_DIGEST } = process.env
if (!ARGOCD_SERVER || !ARGOCD_TOKEN || !CONTAINER_IMAGE ||
    !/^[0-9a-f]{40}$/.test(DEPLOY_REVISION ?? '') || !/^sha256:[0-9a-f]{64}$/.test(IMAGE_DIGEST ?? '')) {
  throw new Error('Argo CD access, deploy revision and image digest are required')
}
const endpoint = new URL('/api/v1/applications/octo-docs-backend-test', `http://${ARGOCD_SERVER}`)
const expectedImage = `${CONTAINER_IMAGE}@${IMAGE_DIGEST}`
const headers = { Authorization: `Bearer ${ARGOCD_TOKEN}`, 'Content-Type': 'application/json' }
const deadline = Date.now() + 15 * 60_000

async function request(url, options) {
  const response = await fetch(url, { ...options, headers, redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Argo CD HTTP ${response.status}`)
  return response
}

const sync = await request(`${endpoint}/sync`, {
  method: 'POST',
  body: JSON.stringify({ revision: DEPLOY_REVISION, prune: false, dryRun: false }),
})
await sync.body?.cancel()

while (Date.now() < deadline) {
  const { status } = await (await request(`${endpoint}?refresh=normal`)).json()
  const operation = status?.operationState
  if (operation?.syncResult?.revision === DEPLOY_REVISION) {
    if (operation.phase === 'Failed' || operation.phase === 'Error') {
      throw new Error('Argo CD could not synchronize the requested Docs revision')
    }
    if (operation.phase === 'Succeeded' && status.sync?.status === 'Synced' &&
        status.sync.revision === DEPLOY_REVISION && status.health?.status === 'Healthy' &&
        status.summary?.images?.includes(expectedImage)) {
      console.log('Expected Docs revision and image are Synced/Healthy after startup migration')
      process.exit(0)
    }
  }
  console.log(`Waiting for Docs rollout: ${status?.sync?.status ?? 'unknown'}/${status?.health?.status ?? 'unknown'}`)
  await delay(5_000)
}
throw new Error('Docs rollout did not reach Synced/Healthy for the requested revision')
