import { fenceRedisGenerations } from './generationRedis.js'
import { Redis } from 'ioredis'
import { Redis as HocuspocusRedis } from '@hocuspocus/extension-redis'
import { SkipFurtherHooksError } from '@hocuspocus/common'
import type { onStoreDocumentPayload } from '@hocuspocus/server'
import type { RedisConnectionConfig } from '../config/redis.js'
import { buildRedisOptions } from '../db/redisOptions.js'
import { observeRedisErrors } from '../db/redisLifecycle.js'
import { hasPendingDocumentBodyEdits } from './documentActivity.js'

class CollabRedis extends HocuspocusRedis {
  override async onStoreDocument(data: onStoreDocumentPayload): Promise<void> {
    try {
      await super.onStoreDocument(data)
    } catch (error) {
      if (!(error instanceof SkipFurtherHooksError) || !hasPendingDocumentBodyEdits(data.document)) throw error
      // The other replica can persist our Yjs update but cannot know its
      // author. Let the SQL row lock and generation fence serialize this save
      // so the original replica also commits the edit evidence.
    }
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
