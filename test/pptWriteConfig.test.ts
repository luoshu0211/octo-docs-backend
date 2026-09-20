import { describe, expect, it } from 'vitest'
import { parsePptWriteConfig } from '../src/config/pptWrite.js'

describe('PPT document and request budgets', () => {
  it('defaults to 32 MiB of document JSON and 40 MiB of request bytes', () => {
    expect(parsePptWriteConfig({})).toEqual({ maxDocumentBytes: 32 * 1024 * 1024, maxRequestBytes: 40 * 1024 * 1024 })
  })
  it.each(['0', '-1', 'NaN', 'Infinity', '1.5', '1e8', '1073741825'])('rejects invalid limits: %s', raw => {
    for (const key of ['PPT_MAX_DOCUMENT_BYTES', 'PPT_WRITE_MAX_REQUEST_BYTES']) {
      expect(() => parsePptWriteConfig({ [key]: raw })).toThrow(key)
    }
  })
  it('rejects a request budget without envelope headroom', () => {
    expect(() => parsePptWriteConfig({ PPT_WRITE_MAX_REQUEST_BYTES: String(32 * 1024 * 1024) })).toThrow('1024')
  })
})
