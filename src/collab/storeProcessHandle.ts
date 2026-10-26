import { fork, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { StoreReply } from './storeWorker.js'

export interface StoreWorkerHandle {
  on(event: 'message', listener: (reply: StoreReply) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  on(event: 'ready', listener: (heapLimitBytes: number) => void): unknown
  postMessage(message: unknown): void
  ref(): void
  unref(): void
  terminate(): Promise<number>
}

/**
 * A Worker resourceLimit is overridden by the parent's --max-old-space-size,
 * including NODE_OPTIONS. A child process owns its V8 flags and can fail without
 * exhausting the server heap. This is a heap bound, NOT a total RSS/cgroup cap.
 */
class StoreProcessHandle extends EventEmitter implements StoreWorkerHandle {
  private readonly child: ChildProcess
  private readonly exited: Promise<number>
  private exitCode: number | undefined

  constructor() {
    super()
    const compiled = new URL('./storeProcess.js', import.meta.url)
    const built = existsSync(fileURLToPath(compiled))
    this.child = fork(built ? compiled : new URL('./storeProcess.ts', import.meta.url), [], {
      execArgv: ['--max-old-space-size=512', ...(built ? [] : ['--import', 'tsx'])],
      // Helpers need neither the server's heap flags nor its injected loaders.
      env: { ...process.env, NODE_OPTIONS: '' },
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    this.exited = new Promise(resolve => {
      this.child.once('exit', (code, signal) => {
        this.exitCode = code ?? -1
        resolve(this.exitCode)
        this.emit('exit', this.exitCode, signal)
      })
      this.child.once('error', error => {
        // A failed spawn has no exit event. No process exists to await/kill.
        if (this.child.pid === undefined) { this.exitCode = -1; resolve(-1) }
        this.emit('error', error)
      })
    })
    this.child.on('message', reply => {
      if (typeof reply === 'object' && reply !== null && 'heapLimitBytes' in reply) {
        const limit = reply.heapLimitBytes
        if (typeof limit !== 'number' || !Number.isFinite(limit) || limit > 576 * 1024 * 1024) {
          this.emit('error', new Error('Yjs store process heap limit was overridden'))
        } else this.emit('ready', limit)
      } else this.emit('message', reply)
    })
  }

  postMessage(message: unknown): void {
    this.child.send(message as Parameters<ChildProcess['send']>[0], error => {
      if (error) this.emit('error', error)
    })
  }

  ref(): void { this.child.ref(); this.child.channel?.ref() }
  unref(): void { this.child.unref(); this.child.channel?.unref() }

  terminate(): Promise<number> {
    if (this.exitCode === undefined) {
      // An idle helper is unref'ed. Keep the event loop alive until its exit
      // event resolves shutdown (a pending Promise alone does not do that).
      this.ref()
      this.child.kill('SIGKILL')
    }
    return this.exited
  }
}

export function createStoreProcess(): StoreWorkerHandle { return new StoreProcessHandle() }
