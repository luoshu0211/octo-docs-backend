/** Separate process: Node reads NODE_EXTRA_CA_CERTS only at process startup. */
import { config } from '../../src/config/env.js'
import { getRedis, createRedisSubscriber, closeRedis } from '../../src/db/redis.js'
import { createCollabRedis } from '../../src/collab/redis.js'
import { waitForRedisStartup } from '../../src/db/redisLifecycle.js'

const extension = createCollabRedis(config.redis)
const sub = createRedisSubscriber()
try {
  await waitForRedisStartup([getRedis(), extension.pub, extension.sub, sub], config.redis,
    () => sub.subscribe(`${config.redis.prefix}:tls`), 3000)
  await getRedis().set(`${config.redis.prefix}:tls-check`, 'ok')
  if (await getRedis().get(`${config.redis.prefix}:tls-check`) !== 'ok') throw new Error('read failed')
  process.stdout.write('TLS_OK\n')
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`)
  process.exitCode = 1
} finally {
  sub.disconnect()
  extension.pub.disconnect()
  extension.sub.disconnect()
  await closeRedis()
}
