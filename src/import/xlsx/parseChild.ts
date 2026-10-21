import { getHeapStatistics } from 'node:v8'
import { config } from '../../config/env.js'
import { parseXlsx, XlsxParseError } from './parse.js'

process.send?.({ ready: true, heapLimit: getHeapStatistics().heap_size_limit })
process.once('message', async (input: { data: Buffer; maxDocBytes: number; limits: typeof config.docxImport }) => {
  Object.assign(config, { maxDocBytes: input.maxDocBytes })
  Object.assign(config.docxImport, input.limits)
  let reply: unknown
  try { reply = { ok: true, workbook: await parseXlsx(input.data) } }
  catch (error) { reply = { ok: false, reason: error instanceof XlsxParseError ? error.reason : 'unreadable' } }
  process.send?.(reply, () => process.disconnect())
})
