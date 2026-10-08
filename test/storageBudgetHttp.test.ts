import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { NextFunction, Request, Response } from 'express'
import { createApp } from '../src/api/app.js'

vi.mock('../src/api/middleware/auth.js', async () => {
  const { StorageBudgetError } = await import('../src/collab/storageCodec.js')
  return {
    authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
      next(new StorageBudgetError(req.query.dimension === 'decoded' ? 'decoded' : 'stored', 1025, 1024))
    },
  }
})

let server: Server
let base: string
beforeAll(async () => {
  const app = createApp()
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

describe('storage budget HTTP error mapping with injected middleware error', () => {
  it.each(['decoded', 'stored'])('returns 413 and the %s budget dimension', async (dimension) => {
    const response = await fetch(`${base}/api/v1/docs/anything?dimension=${dimension}`)
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'doc_too_large', dimension, bytes: 1025, limit: 1024 })
  })
})
