/** Real SQL/Redis with two isolated Node processes. This is not browser/auth acceptance. */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { Server } from '@hocuspocus/server'
import { config } from '../src/config/env.js'
import { query, transaction, closePool } from '../src/db/pool.js'
import { closeRedis } from '../src/db/redis.js'
import { yjsDocumentRepo } from '../src/db/repos/yjsDocumentRepo.js'
import { CollabDatabase } from '../src/collab/collabDatabase.js'
import { persistence } from '../src/collab/persistence.js'
import { createCollabRedis } from '../src/collab/redis.js'
import { storeWorkerPool } from '../src/collab/storeWorkerPool.js'
import { durableReceipt } from '../src/collab/durableReceipt.js'

assert.equal(config.mysql.host, '127.0.0.1')
assert.equal(config.mysql.port, 57932)
assert.equal(config.mysql.database, 'octo_whole_capacity')
assert.equal(config.redis.port, 57934)
assert(config.redis.prefix.startsWith('whole-capacity-'))

interface Command { id: number; op: string; name: string; key?: string; value?: unknown }
interface Reply { id: number; ok: boolean; result?: unknown; error?: string }

if (process.argv[2] === 'node') {
  const server = new Server({ quiet: true, debounce: 2000, maxDebounce: 10000,
    extensions: [new CollabDatabase(persistence), createCollabRedis(config.redis)] })
  const connections = new Map<string, Awaited<ReturnType<Server['hocuspocus']['openDirectConnection']>>>()
  async function execute(command: Command): Promise<unknown> {
    const { op, name } = command
    if (op === 'open') {
      connections.set(name, await server.hocuspocus.openDirectConnection(name, { user: { id: 'capacity-test' } }))
      return { pid: process.pid, memory: process.memoryUsage() }
    }
    const connection = connections.get(name)
    if (op === 'close') {
      for (const c of connections.values()) await c.disconnect()
      connections.clear(); await server.destroy(); await storeWorkerPool.close(); await closeRedis(); await closePool()
      return { closed: true }
    }
    assert(connection?.document)
    if (op === 'edit') {
      await connection.transact(doc => {
        if (command.value === null) doc.getMap('sheet').delete(command.key!)
        else doc.getMap('sheet').set(command.key!, command.value)
      })
      return { edited: true }
    }
    if (op === 'flush') { await persistence.store(name, connection.document, { user: { id: 'capacity-test' } }); return { saved: true } }
    if (op === 'disconnect') {
      await connection.disconnect(); connections.delete(name)
      return { rooms: server.hocuspocus.documents.size }
    }
    assert.equal(op, 'read')
    return { value: connection.document.getMap('sheet').get(command.key!), cells: connection.document.getMap('sheet').size,
      receipt: durableReceipt(connection.document), rooms: server.hocuspocus.documents.size, memory: process.memoryUsage() }
  }
  process.on('message', (command: Command) => {
    void execute(command).then(result => process.send!({ id: command.id, ok: true, result } satisfies Reply),
      error => process.send!({ id: command.id, ok: false, error: error.message } satisfies Reply))
  })
  process.send!({ ready: true })
} else {
  const evidence = process.env.BENCHMARK_OUTPUT_DIR
  assert(evidence)
  const nodes: ReturnType<typeof startNode>[] = []
  let nextId = 1
  function startNode() {
    const child = fork(new URL(import.meta.url), ['node'], {
      execArgv: ['--max-old-space-size=1536', '--import', 'tsx'], serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
    child.on('message', (reply: Reply) => {
      const waiter = pending.get(reply.id)
      if (!waiter) return
      pending.delete(reply.id); clearTimeout(waiter.timer)
      if (reply.ok) waiter.resolve(reply.result)
      else waiter.reject(new Error(reply.error))
    })
    child.on('exit', code => {
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`node exited ${code}`)) }
      pending.clear()
    })
    return { child, request(op: string, name: string, key?: string, value?: unknown): Promise<Record<string, unknown>> {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${op}`)); child.kill('SIGKILL') }, 60_000)
        pending.set(id, { resolve: value => resolve(value as Record<string, unknown>), reject, timer })
        child.send({ id, op, name, key, value } satisfies Command)
      })
    } }
  }
  const name = `octo:whole-capacity:f_default:collab-${Date.now()}`
  const failed = `${name}-failure`
  async function seed(documentName: string, fixture: string) {
    await query(`INSERT INTO doc_meta (doc_id,document_name,owner_id,owner_space_id,space_id,folder_id,doc_type,created_by)
      VALUES (?,?,'capacity-test','whole-capacity','whole-capacity','f_default','sheet','capacity-test')`, [documentName.split(':').at(-1), documentName])
    const state = await readFile(`${evidence}/fixtures/${fixture}`)
    await transaction(tx => yjsDocumentRepo.upsertStateTx(tx, documentName, state, 2))
  }
  async function checksum(documentName: string) {
    return (await query<{ checksum: string }>('SELECT SHA2(state,256) AS checksum FROM yjs_document WHERE document_name=?', [documentName]))[0]!.checksum
  }
  const result: Record<string, unknown> = { name, failed, node: process.version, layer: 'two processes + real Hocuspocus/Redis/MySQL; direct connections; no browser/auth' }
  try {
    await seed(name, 'numeric-medium-v2.bin')
    await seed(failed, 'numeric-50m-v2.bin')
    const a = startNode(), b = startNode(); nodes.push(a, b)
    result.open = await Promise.all(nodes.map(n => n.request('open', name)))
    const latencies: number[] = []
    const collaborationStarted = performance.now()
    for (let i = 0; i < 100; i++) {
      const start = performance.now(), writer = nodes[i % 2]!, reader = nodes[(i + 1) % 2]!
      await writer.request('edit', name, 'default!0:0', { v: i, t: 2 })
      for (;;) {
        const read = await reader.request('read', name, 'default!0:0')
        if ((read.value as { v: number })?.v === i) break
        assert(performance.now() - start < 10_000, 'Redis convergence deadline')
        await delay(5)
      }
      latencies.push(performance.now() - start)
      await delay(Math.max(0, 50 - (performance.now() - start)))
    }
    const collaborationMs = performance.now() - collaborationStarted
    await Promise.all([a.request('edit', name, 'default!0:1', { v: 'left', t: 1 }), b.request('edit', name, 'default!0:2', { v: 'right', t: 1 })])
    await b.request('edit', name, 'default!0:3', null)
    await Promise.all(nodes.map(n => n.request('flush', name)))
    await Promise.all(nodes.map(n => n.request('disconnect', name)))
    await delay(100)
    result.reopen = await a.request('open', name)
    assert.deepEqual((await a.request('read', name, 'default!0:0')).value, { v: 99, t: 2 })
    assert.deepEqual((await a.request('read', name, 'default!0:1')).value, { v: 'left', t: 1 })
    assert.deepEqual((await a.request('read', name, 'default!0:2')).value, { v: 'right', t: 1 })
    assert.equal((await a.request('read', name, 'default!0:3')).value, undefined)
    result.sqlChecksum = await checksum(name)
    result.collaboration = { edits: 100, targetEditsPerSecond: 20, closedLoop: true, elapsedMs: collaborationMs,
      achievedEditsPerSecond: 100000 / collaborationMs, latencyMs: latencies,
      p95Ms: [...latencies].sort((x, y) => x - y)[94], maxMs: Math.max(...latencies), reloadValuesAndDeletionVerified: true }
    await a.request('disconnect', name)

    await a.request('open', failed)
    const beforeRow = await checksum(failed)
    const beforeReceipt = (await a.request('read', failed, 'default!0:0')).receipt
    await a.request('edit', failed, 'default!0:0', { v: 'must-remain-uncommitted', t: 1 })
    await assert.rejects(() => a.request('flush', failed), /worker exited/)
    assert.equal(await checksum(failed), beforeRow)
    assert.equal((await a.request('read', failed, 'default!0:0')).receipt, beforeReceipt)
    assert.deepEqual((await a.request('read', failed, 'default!0:0')).value, { v: 'must-remain-uncommitted', t: 1 })
    await b.request('open', name); await b.request('edit', name, 'default!0:4', { v: 'healthy-after-failure', t: 1 }); await b.request('flush', name)
    result.failure = { sqlRowUnchanged: true, noFalseDurableReceipt: true, unsavedEditsStillInLiveDocument: true, otherNodeSaved: true }
    await writeFile(`${evidence}/results/real-persistence.json`, JSON.stringify(result, null, 2))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    for (const node of nodes) {
      try { await node.request('close', name) } finally { node.child.kill('SIGTERM') }
    }
    await storeWorkerPool.close(); await closeRedis(); await closePool()
  }
}
