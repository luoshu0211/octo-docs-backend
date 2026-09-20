import { config } from '../config/env.js'
import { PptApiError } from '../api/ppt/errors.js'

export class PptDocumentCapacityError extends PptApiError {
  constructor(documentBytes: number) {
    super('PAYLOAD_TOO_LARGE', 'PPT document exceeds the size limit', {
      details: { dimension: 'document', documentBytes, limit: config.ppt.write.maxDocumentBytes },
      hint: 'Reduce embedded content or upload media separately before saving again.',
    })
  }
}

export function assertPptDocumentBudget(deck: unknown): number {
  const bytes = Buffer.byteLength(JSON.stringify(deck), 'utf8')
  if (bytes > config.ppt.write.maxDocumentBytes) throw new PptDocumentCapacityError(bytes)
  return bytes
}
