/** Full-document JSON budgets are independent of relay frames and asset blobs. */
export function parsePptWriteConfig(env: NodeJS.ProcessEnv) {
  const bytes = (name: string, fallback: number) => {
    const raw = env[name]?.trim()
    if (!raw) return fallback
    const value = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > 1024 * 1024 * 1024) {
      throw new Error(`${name} must be an integer byte count between 1 and 1073741824`)
    }
    return value
  }
  const maxDocumentBytes = bytes('PPT_MAX_DOCUMENT_BYTES', 32 * 1024 * 1024)
  const maxRequestBytes = bytes('PPT_WRITE_MAX_REQUEST_BYTES', 40 * 1024 * 1024)
  if (maxRequestBytes < maxDocumentBytes + 1024) {
    throw new Error('PPT_WRITE_MAX_REQUEST_BYTES must leave at least 1024 bytes above PPT_MAX_DOCUMENT_BYTES')
  }
  return { maxDocumentBytes, maxRequestBytes }
}
