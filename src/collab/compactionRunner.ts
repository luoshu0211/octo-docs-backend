/**
 * Runs `compactionWorker` on a thread and enforces one at a time.
 *
 * The rebuild is several seconds of synchronous CPU (~4.7 s measured on a
 * document at incident scale), so it cannot run on the event loop: that is the
 * stall that fails liveness probes. A worker keeps the main thread free to serve
 * requests and answer `/healthz` while it works.
 *
 * The single-slot gate matters as much as the thread. Compaction fires on
 * unload, and unloads arrive in bursts — a redeploy or a network blip drops
 * every connection at once. Without the gate that becomes N threads each
 * holding a multi-megabyte document, and the memory ceiling, not the CPU, is
 * what falls over. One at a time turns a burst into a queue that drains.
 */
import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { CompactWorkerInput, CompactWorkerOutput } from './compactionWorker.js'

/**
 * Locate the worker entry next to this module.
 *
 * In production this file is `dist/collab/compactionRunner.js` and the sibling
 * `.js` is right there, so the worker is started from that path directly.
 *
 * Under `tsx watch` and under vitest it is the `.ts` source and no sibling `.js`
 * exists. Passing `execArgv: ['--import', 'tsx']` does NOT work there: the flag
 * registers tsx for the worker's own entry, but the resolver it installs is not
 * in effect for that entry's static imports, so `./docRebuild.js` — the
 * extension-rewritten specifier every ESM/TS module in this repo uses — fails to
 * resolve and the worker dies with ERR_MODULE_NOT_FOUND before running a line.
 * Measured, not assumed: both `--import tsx` and `--import tsx/esm` fail this
 * way, and `--loader tsx` is rejected outright by Node 20+.
 *
 * The form that does work is an `eval` bootstrap that calls tsx's register()
 * INSIDE the worker before importing the entry, so the hook is installed by the
 * time the entry's imports are resolved.
 *
 * This branch is load-bearing for verification, not just for convenience: the
 * event-loop assertion in test/compactionWorker.test.ts can only run if the
 * worker actually starts, and a worker that never starts reports `ok: false`,
 * which is indistinguishable from a business-level refusal unless the reason is
 * read.
 */
type WorkerEntry = { source: string; eval: boolean }

function resolveWorkerEntry(): WorkerEntry {
  const compiled = fileURLToPath(new URL('./compactionWorker.js', import.meta.url))
  if (existsSync(compiled)) return { source: compiled, eval: false }

  const sourceUrl = new URL('./compactionWorker.ts', import.meta.url)
  if (existsSync(fileURLToPath(sourceUrl))) {
    return {
      source:
        `import { register } from 'tsx/esm/api'\n` +
        `register()\n` +
        `await import(${JSON.stringify(sourceUrl.href)})\n`,
      eval: true,
    }
  }

  return { source: compiled, eval: false }
}

/**
 * Abandon a compaction that has not finished in this long. A worker cannot
 * block the main thread, but a wedged one would hold a slot forever and stop
 * every other document from ever being compacted.
 */
const WORKER_TIMEOUT_MS = 60_000

/** At most one compaction in flight across the process. */
let inFlight: Promise<unknown> | null = null

/** True while a compaction is running — exposed for tests and metrics. */
export function isCompactionRunning(): boolean {
  return inFlight !== null
}

/**
 * Run the rebuild on a worker thread.
 *
 * Returns `{ ok: false, reason: 'busy' }` rather than queueing when another
 * compaction holds the slot: the caller fires on unload, and the same document
 * will unload again. Queueing here would build an unbounded backlog of stale
 * work behind a burst.
 */
export async function runCompactionOffThread(
  input: CompactWorkerInput,
): Promise<CompactWorkerOutput | { ok: false; reason: 'busy' }> {
  if (inFlight) return { ok: false, reason: 'busy' }

  const run = execute(input)
  inFlight = run
  try {
    return await run
  } finally {
    inFlight = null
  }
}

function execute(input: CompactWorkerInput): Promise<CompactWorkerOutput> {
  return new Promise<CompactWorkerOutput>((resolve) => {
    let settled = false
    const finish = (out: CompactWorkerOutput): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(out)
    }

    const entry = resolveWorkerEntry()
    const worker = new Worker(entry.source, {
      eval: entry.eval,
      workerData: input,
      // The input is deliberately NOT transferred. `state` comes from mysql2 as
      // a Node Buffer, and a small one is a VIEW into a shared allocation pool —
      // transferring its `.buffer` would detach that whole pool and corrupt
      // every unrelated Buffer sharing it. One structured clone of a few
      // megabytes costs about a millisecond against a multi-second rebuild.
      // (The results come back transferred: those buffers are worker-allocated
      // and exactly sized, so there is no pool to detach.)
    })

    const timer = setTimeout(
      () => finish({ ok: false, reason: `compaction worker exceeded ${WORKER_TIMEOUT_MS}ms` }),
      WORKER_TIMEOUT_MS,
    )

    worker.on('message', (out: CompactWorkerOutput) => finish(out))
    worker.on('error', (err: Error) => finish({ ok: false, reason: `worker error: ${err.message}` }))
    worker.on('exit', (code) => {
      // A clean exit after a message is the normal path; this only fires first
      // when the worker died without reporting, which must not hang the caller.
      finish({ ok: false, reason: `worker exited with code ${code} before reporting` })
    })
  })
}
