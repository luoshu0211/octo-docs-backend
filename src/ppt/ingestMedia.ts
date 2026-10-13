import { fileTypeFromBuffer } from 'file-type'
import { PPT_MEDIA_MIMES } from './media.js'
import { sanitizeSvg } from '../util/sanitizeSvg.js'

/** Content identification, not a codec/playability guarantee. Never trust a URL or MIME header. */
export async function identifyPptMedia(bytes: Buffer): Promise<{ bytes: Buffer; mime: string } | null> {
  try {
    const type = await fileTypeFromBuffer(bytes)
    // XML is only a container candidate; the sanitizer below must prove an SVG root.
    if (type && type.mime !== 'application/xml' && type.mime !== 'text/xml') {
      const mime = type.mime === 'audio/x-m4a' ? 'audio/mp4'
        : type.mime === 'audio/x-flac' ? 'audio/flac'
          : type.mime === 'audio/ogg; codecs=opus' ? 'audio/ogg' : type.mime
      return PPT_MEDIA_MIMES.has(mime) ? { bytes, mime } : null
    }
  } catch {
    // Truncated binary content must not fall back to a claimed Content-Type.
    return null
  }
  try {
    return { bytes: sanitizeSvg(bytes), mime: 'image/svg+xml' }
  } catch {
    return null
  }
}
