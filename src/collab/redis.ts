import { fenceRedisGenerations } from './generationRedis.js'
import { Redis } from 'ioredis'
import { Redis as HocuspocusRedis } from '@hocuspocus/extension-redis'
import type { onChangePayload } from '@hocuspocus/server'
import type { RedisConnectionConfig } from '../config/redis.js'
import { buildRedisOptions } from '../db/redisOptions.js'
import { observeRedisErrors } from '../db/redisLifecycle.js'
import { waitForDocumentEditEvidence } from './documentActivity.js'

class CollabRedis extends HocuspocusRedis {
  override async onChange(data: onChangePayload): Promise<void> {
    await waitForDocumentEditEvidence(data.document)
    await super.onChange(data)
  }
}

export function createCollabRedis(config: RedisConnectionConfig & { prefix: string }): HocuspocusRedis {
  const extension = new CollabRedis({
    host: config.host,
    port: config.port,
    prefix: config.prefix,
    // The extension's positional-host constructor misparses IPv6 as a URL
    // (even bracketed IPv6 becomes a Unix socket path). The public factory
    // accepts options directly and still gives the extension two owned clients.
    createClient: () => new Redis(buildRedisOptions(config)),
  })
  // The extension only supplies retryCount to Redlock. Its Lua scripts SELECT
  // settings.db (default 0), independently of the ioredis connection's db. Set
  // this once, before any lock is used; keep the extension's other settings.
  Object.assign(extension.redlock.settings, { db: config.db })
  observeRedisErrors(extension.pub, 'collab-pub')
  observeRedisErrors(extension.sub, 'collab-sub')
  fenceRedisGenerations(extension)
  return extension
}
