import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { config } from '../../config/env.js'
import { type ParsedXlsxWorkbook, XlsxParseError } from './parse.js'

let active = false

/** One bounded child per API process, no queue retaining uploaded workbooks. */
export async function parseXlsxIsolated(data: Buffer, signal?: AbortSignal): Promise<ParsedXlsxWorkbook> {
  if (signal?.aborted) throw new XlsxParseError('cancelled')
  if (active) throw new XlsxParseError('busy')
  if (data.byteLength > config.docxImport.maxUploadBytes) throw new XlsxParseError('resource-limit')
  active = true
  try {
    return await new Promise<ParsedXlsxWorkbook>((resolve, reject) => {
      const compiled = new URL('./parseChild.js', import.meta.url)
      const isCompiled = existsSync(fileURLToPath(compiled))
      // NODE_OPTIONS overrides worker_threads limits; a separate process with explicit V8 flags
      // keeps parser heap exhaustion from terminating the API. Buffers/RSS are separate budgets.
      const child = fork(fileURLToPath(isCompiled ? compiled : new URL('./parseChild.ts', import.meta.url)), [], {
        execArgv: ['--max-old-space-size=512', ...(isCompiled ? [] : ['--import', 'tsx'])],
        env: { ...process.env, NODE_OPTIONS: '' },
        serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      })
      let result: ParsedXlsxWorkbook | undefined
      let error: XlsxParseError | undefined
      let sent = false
      const stop = (reason: XlsxParseError['reason']) => {
        error ??= new XlsxParseError(reason)
        child.kill('SIGKILL')
      }
      const abort = () => stop('cancelled')
      const timer = setTimeout(() => stop('resource-limit'), config.docxImport.timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      child.on('message', (reply: { ready?: boolean; heapLimit?: number; ok?: boolean; workbook?: ParsedXlsxWorkbook; reason?: XlsxParseError['reason'] }) => {
        if (error) return
        if (reply.ready && !sent) {
          if (!reply.heapLimit || reply.heapLimit > 600 * 1024 * 1024) return stop('resource-limit')
          sent = true
          child.send({ data, maxDocBytes: config.maxDocBytes, limits: config.docxImport }, (err) => { if (err) stop('resource-limit') })
        } else if (reply.ok && reply.workbook) result = reply.workbook
        else error = new XlsxParseError(reply.reason ?? 'resource-limit')
      })
      child.once('error', () => { error ??= new XlsxParseError('resource-limit') })
      // Keep the slot until the process and IPC channel are gone, including timeout/OOM paths.
      child.once('close', (code) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (!error && result && code === 0) resolve(result)
        else reject(error ?? new XlsxParseError('resource-limit'))
      })
      if (signal?.aborted) abort()
    })
  } finally { active = false }
}
