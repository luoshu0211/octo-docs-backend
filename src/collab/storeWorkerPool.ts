import { createStoreProcess, type StoreWorkerHandle } from './storeProcessHandle.js'
import { StorageBudgetError, UnknownEncodingError } from './storageCodec.js'
import type { StoreJob, StoreReply, StoreResult } from './storeWorker.js'

export const createStoreWorker = createStoreProcess

interface PendingJob {
  id: number
  input: StoreJob
  bytes: number
  resolve(result: StoreResult): void
  reject(error: Error): void
}
interface Slot { worker: StoreWorkerHandle | null; job: PendingJob | null; timer?: NodeJS.Timeout; stopping?: Promise<void> }

/** Bounded, reused workers; no live Y.Doc or unbounded mirror cache is retained. */
export class StoreWorkerPool {
  private readonly slots: Slot[]
  private readonly queue: PendingJob[] = []
  private bytes = 0
  private nextId = 1
  private closing = false
  private drained?: () => void
  private closePromise?: Promise<void>

  constructor(private readonly options: {
    workers?: number; maxJobs?: number; maxBytes?: number; timeoutMs?: number
    workerFactory?: () => StoreWorkerHandle
  } = {}) {
    this.slots = Array.from({ length: options.workers ?? 1 }, () => ({ worker: null, job: null }))
  }

  run(input: StoreJob): Promise<StoreResult> {
    const bytes = input.update.byteLength + (input.existing?.state.byteLength ?? 0)
      + input.targetVector.byteLength + (input.baseVector?.byteLength ?? 0)
    const count = this.queue.length + this.slots.filter(s => s.job).length
    if (this.closing) return Promise.reject(new Error('Yjs store worker pool is closed'))
    if (count >= (this.options.maxJobs ?? 16) || this.bytes + bytes > (this.options.maxBytes ?? 64 * 1024 * 1024)) {
      return Promise.reject(new Error('Yjs store worker queue capacity exceeded; write was not committed'))
    }
    this.bytes += bytes
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, input, bytes, resolve, reject })
      this.dispatch()
    })
  }

  private dispatch(): void {
    for (const slot of this.slots) {
      if (slot.job || slot.stopping || !this.queue.length) continue
      const job = this.queue.shift()!
      slot.job = job
      try {
        if (!slot.worker) {
          const worker = (this.options.workerFactory ?? createStoreWorker)()
          slot.worker = worker
          worker.on('message', (reply: StoreReply) => {
            if (slot.worker !== worker || slot.stopping || slot.job?.id !== reply.id) return
            if (reply.ok) this.finish(slot, undefined, reply.result)
            else {
              const e = reply.error
              const error = e.name === 'StorageBudgetError' && e.dimension && e.bytes !== undefined && e.limit !== undefined
                ? new StorageBudgetError(e.dimension, e.bytes, e.limit)
                : e.name === 'UnknownEncodingError'
                  ? new UnknownEncodingError(slot.job.input.documentName, slot.job.input.existing?.encoding)
                  : Object.assign(new Error(e.message), { name: e.name })
              this.finish(slot, error)
            }
          })
          worker.on('error', error => this.failedWorker(slot, worker, error))
          worker.on('exit', code => this.failedWorker(slot, worker, new Error(`Yjs store worker exited (${code})`)))
        }
        const worker = slot.worker
        worker.ref()
        slot.timer = setTimeout(() => this.failedWorker(slot, worker, new Error('Yjs store worker timed out')),
          this.options.timeoutMs ?? 30_000)
        // Input buffers can belong to mysql2/Yjs; copy, never detach their slabs.
        worker.postMessage({ id: job.id, job: job.input })
      } catch (error) {
        if (slot.worker) this.failedWorker(slot, slot.worker, error instanceof Error ? error : new Error(String(error)))
        else this.finish(slot, error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private failedWorker(slot: Slot, worker: StoreWorkerHandle, error: Error): void {
    if (slot.worker !== worker || slot.stopping) return
    clearTimeout(slot.timer)
    // Keep the slot and its byte reservation until the OS confirms exit. Starting
    // a replacement while the old decoder is alive defeats the memory bound.
    slot.stopping = worker.terminate().then(() => {
      slot.worker = null
      slot.stopping = undefined
      if (slot.job) this.finish(slot, error)
      else this.dispatch()
    })
  }

  private finish(slot: Slot, error?: Error, result?: StoreResult): void {
    const job = slot.job!
    clearTimeout(slot.timer)
    slot.job = null
    slot.worker?.unref()
    this.bytes -= job.bytes
    if (error) job.reject(error)
    else job.resolve(result!)
    this.dispatch()
    if (!this.queue.length && this.slots.every(s => !s.job)) this.drained?.()
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = (async () => {
      if (this.queue.length || this.slots.some(s => s.job)) await new Promise<void>(resolve => { this.drained = resolve })
      await Promise.all(this.slots.map(async slot => {
        await slot.stopping
        const worker = slot.worker
        slot.worker = null
        if (worker) await worker.terminate()
      }))
    })()
    return this.closePromise
  }
}

export const storeWorkerPool = new StoreWorkerPool()
