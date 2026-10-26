/** Bounded admission BEFORE fetching/encoding snapshots or taking SQL row locks. */
export class CapacityBusyError extends Error {
  constructor(reason: string) { super(`collab_capacity_busy: ${reason}; retry later`); this.name = 'CapacityBusyError' }
}

interface Entry {
  start(): void
  reject(error: Error): void
  timer?: NodeJS.Timeout
}

function completionSignal() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

export class CapacityLane {
  private active = false
  private readonly queue: Entry[] = []
  private completed = completionSignal()
  constructor(private readonly maxJobs = 16, private readonly waitMs = 30_000) {}

  /**
   * A live document already contains accepted edits. Admission pressure must
   * delay its flush, not reject it into Hocuspocus's error-swallowing disconnect
   * path. Keep the caller pending (and its document save mutex held) until it
   * gets a turn. Only the bounded run() queue may capture buffers / take locks.
   *
   * Overflow waits share a completion signal; they hold only the caller's live
   * document reference, not snapshots, row locks or polling timers. This is NOT
   * a bound on resident documents or HTTP latency. Loads still use run(), where
   * rejection happens before accepting edits. Never retry an operation failure.
   */
  async runRetained<T>(operation: () => Promise<T>): Promise<T> {
    for (;;) {
      // Subscribe before admission: a completion between rejection and catch
      // must not be missed, even when the rejected entry was queued then expired.
      const progress = this.completed.promise
      let started = false
      try {
        return await this.run(() => { started = true; return operation() })
      } catch (error) {
        if (started || !(error instanceof CapacityBusyError)) throw error
      }
      await progress
    }
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (Number(this.active) + this.queue.length >= this.maxJobs) {
      return Promise.reject(new CapacityBusyError('snapshot queue is full'))
    }
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = {
        reject,
        start: () => {
          clearTimeout(entry.timer)
          this.active = true
          // Do not release admission until the operation actually finishes. A
          // timeout cannot interrupt a synchronous decoder or an SQL transaction.
          void (async () => {
            try { resolve(await operation()) } catch (error) { reject(error) }
            finally {
              const completed = this.completed
              this.completed = completionSignal()
              this.active = false
              this.queue.shift()?.start()
              completed.resolve()
            }
          })()
        },
      }
      if (!this.active) entry.start()
      else {
        this.queue.push(entry)
        entry.timer = setTimeout(() => {
          const index = this.queue.indexOf(entry)
          if (index < 0) return
          this.queue.splice(index, 1)
          reject(new CapacityBusyError('snapshot queue wait expired'))
        }, this.waitMs)
      }
    })
  }
}
