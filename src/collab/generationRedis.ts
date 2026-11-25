import type { Redis as HocuspocusRedis } from '@hocuspocus/extension-redis'
import { IncomingMessage, MessageType, type Document } from '@hocuspocus/server'
import { stateGenerationOf } from './stateGeneration.js'
import { retainPeerDurableReceipt } from './durableReceipt.js'
import { waitForDocumentEditEvidence } from './documentActivity.js'

/**
 * The pinned Redis extension derives every pub/sub/lock channel through getKey.
 * Keep business document names unchanged, but isolate the transport by state generation.
 * Its private channel seam is covered by the real two-node integration test.
 */
export function fenceRedisGenerations(extension: HocuspocusRedis): void {
  const generations = new Map<string, string | null>()
  const documents = new Map<string, Document>()
  const channel = (name: string) => {
    const generation = generations.get(name)
    return generation ? `${extension.configuration.prefix}:generation:${generation}:${name}` : `${extension.configuration.prefix}:${name}`
  }
  Object.defineProperty(extension, 'getKey', { value: channel })
  const afterLoad = extension.afterLoadDocument.bind(extension)
  extension.afterLoadDocument = async data => {
    generations.set(data.documentName, stateGenerationOf(data.document) ?? null)
    // Peer messages can arrive before Hocuspocus registers instance.documents.
    documents.set(data.documentName, data.document)
    try { await afterLoad(data) } catch (error) {
      if (documents.get(data.documentName) === data.document) {
        documents.delete(data.documentName)
        generations.delete(data.documentName)
      }
      throw error
    }
  }
  const afterUnload = extension.afterUnloadDocument.bind(extension)
  extension.afterUnloadDocument = async data => {
    await afterUnload(data)
    if (!data.instance.documents.has(data.documentName)) {
      generations.delete(data.documentName)
      documents.delete(data.documentName)
    }
  }
  // A queued message from an old subscription must not apply to a newly loaded generation.
  const receive = Reflect.get(extension, 'handleIncomingMessage') as (channel: Buffer, data: Buffer) => Promise<void>
  extension.sub.off('messageBuffer', receive)
  extension.sub.on('messageBuffer', (incomingChannel: Buffer, data: Buffer) => {
    try {
      const identifierLength = data[0]
      if (identifierLength === undefined || identifierLength + 1 >= data.length) return
      if (data.subarray(1, identifierLength + 1).toString() === extension.configuration.identifier) return
      const message = new IncomingMessage(data.subarray(identifierLength + 1))
      const name = message.readVarString()
      if (!generations.has(name) || incomingChannel.toString() !== channel(name)) return
      const document = documents.get(name)
      const type = message.readVarUint()
      if (document && type === MessageType.BroadcastStateless) {
        retainPeerDurableReceipt(document, message.readVarString())
      }
      // A peer's sync request can cause this replica to send state without
      // going through our onChange hook. Apply the same evidence fence.
      const receiveAfterEvidence = async () => {
        if (document && (type === MessageType.Sync || type === MessageType.SyncReply)) {
          await waitForDocumentEditEvidence(document)
        }
        if (documents.get(name) === document) await receive(incomingChannel, data)
      }
      void receiveAfterEvidence().catch(error => {
        // eslint-disable-next-line no-console -- Redis callbacks cannot surface rejected promises to the caller
        console.error('[collab-generation] Redis receive failed', error)
      })
    } catch { /* malformed transport messages never reach Yjs */ }
  })
}
