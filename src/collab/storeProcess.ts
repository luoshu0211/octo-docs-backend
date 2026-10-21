/** Dedicated process entrypoint: importing storeWorker in the server has no IPC side effects. */
import { prepareStoreReply, type StoreJob } from './storeWorker.js'
import { getHeapStatistics } from 'node:v8'

if (!process.send) throw new Error('The Yjs store process requires an IPC channel')
process.send({ heapLimitBytes: getHeapStatistics().heap_size_limit })
process.on('message', (message: { id: number; job: StoreJob }) => {
  process.send!(prepareStoreReply(message.id, message.job))
})
// Never retain an orphaned snapshot after the parent shuts down.
process.once('disconnect', () => process.exit(0))
