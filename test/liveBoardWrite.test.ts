import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { BaseVersionStaleError } from '../src/collab/docBodyEdit.js'
import { validateBoardOps } from '../src/whiteboard/boardEdit.js'

const connection = vi.hoisted(() => ({ open: vi.fn(), disconnect: vi.fn() }))
vi.mock('../src/collab/server.js', () => ({
  getCollabServer: () => ({ hocuspocus: { openDirectConnection: connection.open } }),
}))

import { commitLiveBoardEdit } from '../src/collab/liveBoardWrite.js'

let live: Y.Doc
const ops = validateBoardOps({ files: { image: { attachId: 'att_new' } } })

beforeEach(() => {
  live = new Y.Doc()
  connection.disconnect.mockReset().mockResolvedValue(undefined)
  connection.open.mockReset().mockResolvedValue({
    transact: async (callback: (doc: Y.Doc) => void) => { live.transact(() => callback(live)) },
    disconnect: connection.disconnect,
  })
})

afterEach(() => { live.destroy() })

describe('board mutation notification for import attachment cleanup', () => {
  it('signals before adding live file references', async () => {
    const started = vi.fn(() => { expect(live.getMap('files').size).toBe(0) })
    await commitLiveBoardEdit('board', 'u1', Y.encodeStateVector(live), ops, started)
    expect(started).toHaveBeenCalledOnce()
    expect(live.getMap('files').toJSON()).toEqual({ image: { attachId: 'att_new' } })
    expect(connection.disconnect).toHaveBeenCalledOnce()
  })

  it('leaves cleanup safe when opening the connection fails', async () => {
    const started = vi.fn()
    connection.open.mockRejectedValueOnce(new Error('connection failed'))
    await expect(commitLiveBoardEdit('board', 'u1', Y.encodeStateVector(live), ops, started))
      .rejects.toThrow('connection failed')
    expect(started).not.toHaveBeenCalled()
    expect(live.getMap('files').size).toBe(0)
  })

  it('leaves cleanup safe when the state-vector guard rejects the edit', async () => {
    const started = vi.fn()
    const stale = Y.encodeStateVector(live)
    live.getMap('elements').set('concurrent', new Y.Map([['id', 'concurrent']]))
    await expect(commitLiveBoardEdit('board', 'u1', stale, ops, started))
      .rejects.toBeInstanceOf(BaseVersionStaleError)
    expect(started).not.toHaveBeenCalled()
    expect(live.getMap('files').size).toBe(0)
    expect(connection.disconnect).toHaveBeenCalledOnce()
  })

  it('signals an uncertain write when persistence fails after adding file references', async () => {
    const started = vi.fn()
    connection.disconnect.mockRejectedValueOnce(new Error('persistence failed'))
    await expect(commitLiveBoardEdit('board', 'u1', Y.encodeStateVector(live), ops, started))
      .rejects.toThrow('persistence failed')
    expect(started).toHaveBeenCalledOnce()
    expect(live.getMap('files').toJSON()).toEqual({ image: { attachId: 'att_new' } })
  })
})
