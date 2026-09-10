/** Separate OS process: no room maps, local events or queues are shared. */
import { createServer } from 'node:http'
import { getRedis, closeRedis } from '../../src/db/redis.js'
import { closePool } from '../../src/db/pool.js'
import { createPptRelay } from '../../src/ppt/relay/index.js'
import { pptRoomChannel, receivePptRoomEvent, startPptRoomPublishing } from '../../src/ppt/clusterEvents.js'

const sub = getRedis().duplicate()
await sub.subscribe(pptRoomChannel())
sub.on('message', (_channel, raw) => receivePptRoomEvent(raw))
const stop = startPptRoomPublishing()
const relay = createPptRelay()
const server = createServer((_req, res) => res.end('ok'))
relay.attach(server)
server.listen(0, '127.0.0.1', () => process.send?.({ port: (server.address() as { port: number }).port }))
process.on('message', async message => {
  if (message === 'miss-notifications') {
    await sub.unsubscribe(pptRoomChannel())
    process.send?.({ unsubscribed: true })
  }
})
process.on('SIGTERM', () => {
  stop(); relay.close(); sub.disconnect()
  server.close(() => { void Promise.all([closeRedis(), closePool()]).then(() => process.exit(0)) })
})
