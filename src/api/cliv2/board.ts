import type { Request, Response } from 'express'
import { readLiveDocState } from '../../collab/liveDocRead.js'
import { BoardSnapshotInvalidError, decodeBoardSnapshot, WHITEBOARD_DOC_TYPE } from '../../collab/versionRestore.js'
import { config } from '../../config/env.js'
import { docAttachmentRepo } from '../../db/repos/docAttachmentRepo.js'
import { getObjectStore } from '../../storage/objectStore.js'
import { requireDocRole } from '../guard.js'
import { sanitizeSceneImage } from '../routes/boardExport.js'
import { parseBoardAnchor, validElementId, type BoardAnchor } from '../services/commentAnchors.js'
import { CliError } from './auth.js'
import { boardCoordinateLimit, selectionAnchor } from './boardGeometry.js'

async function loadBoard(documentName: string) {
  const state = await readLiveDocState(documentName)
  try {
    return decodeBoardSnapshot(state)
  } catch (error) {
    if (error instanceof BoardSnapshotInvalidError) throw new CliError('CONFLICT', { reason: 'board_snapshot_invalid' })
    throw error
  }
}

const decimal = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i

function pointAnchor(point: unknown): { anchor: BoardAnchor; label: string } {
  const coordinates = typeof point === 'string' ? point.split(',').map(value => value.trim()) : []
  if (coordinates.length !== 2 || !coordinates.every(value => decimal.test(value))) {
    throw new CliError('VALIDATION_ERROR', { reason: 'invalid_board_point' })
  }
  const x = Number(coordinates[0]), y = Number(coordinates[1])
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > boardCoordinateLimit || Math.abs(y) > boardCoordinateLimit) {
    throw new CliError('VALIDATION_ERROR', { reason: 'invalid_board_point' })
  }
  return { anchor: { version: 1, kind: 'point', x, y }, label: `Canvas point · ${x.toFixed(0)}, ${y.toFixed(0)}` }
}

async function elementAnchor(elementIds: unknown, documentName: string): Promise<{ anchor: BoardAnchor; label: string }> {
  if (!Array.isArray(elementIds) || !elementIds.length || elementIds.length > 100 ||
    !elementIds.every(id => typeof id === 'string' && validElementId(id.trim()))) {
    throw new CliError('VALIDATION_ERROR', { reason: 'invalid_element_ids' })
  }
  const scene = await loadBoard(documentName)
  const live = new Map<string, Record<string, unknown>>()
  for (const element of scene.elements) {
    if (element.isDeleted !== true && typeof element.id === 'string') live.set(element.id, element)
  }
  const ids = new Set<string>()
  for (const raw of elementIds) {
    const id: string = raw.trim()
    const element = live.get(id)
    if (!element) throw new CliError('VALIDATION_ERROR', { reason: 'element_not_found' })
    const container = element.containerId
    ids.add(typeof container === 'string' && live.has(container) ? container : id)
  }
  const selected = Array.from(ids)
  let position
  try {
    position = selectionAnchor(selected, live)
  } catch (error) {
    if (error instanceof RangeError) throw new CliError('VALIDATION_ERROR', { reason: 'invalid_board_geometry' })
    throw error
  }
  const elementId = selected[0]!
  return {
    anchor: { version: 1, kind: 'element', elementId, ...(selected.length > 1 ? { elementIds: selected } : {}), x: position[0], y: position[1] },
    label: selected.length > 1 ? `Canvas selection · ${selected.length}` : `Canvas element · ${elementId}`,
  }
}

export async function prepareBoardComment(req: Request, res: Response, body: Record<string, unknown>): Promise<boolean> {
  const hasPoint = Object.hasOwn(body, 'point')
  const hasElements = Object.hasOwn(body, 'elementIds')
  if (!hasPoint && !hasElements) return true
  if (hasPoint === hasElements ||
    ['parentId', 'anchorStart', 'anchorEnd', 'anchorText', 'blockPath', 'occurrence', 'anchor'].some(key => Object.hasOwn(body, key))) {
    throw new CliError('VALIDATION_ERROR', { reason: 'conflicting_board_anchor' })
  }
  if (hasElements && res.locals.cliCanReadContent !== true) throw new CliError('FORBIDDEN')
  const guard = await requireDocRole(req, res, req.params.docId!, 'commenter')
  if (!guard) return false
  if (guard.meta.doc_type !== WHITEBOARD_DOC_TYPE) throw new CliError('CONFLICT', { reason: 'unsupported_doc_type' })
  const { anchor, label } = hasPoint ? pointAnchor(body.point) : await elementAnchor(body.elementIds, guard.meta.document_name)
  const bytes = Buffer.from(JSON.stringify(anchor))
  if (bytes.length > 4096 || !parseBoardAnchor(bytes)) {
    throw new CliError('VALIDATION_ERROR', { reason: 'invalid_board_anchor' })
  }
  const encoded = bytes.toString('base64')
  req.body = { body: body.body, anchorStart: encoded, anchorEnd: encoded, anchorText: label }
  return true
}

const maxPortableAttachments = 100
const maxPortableAttachmentBytes = 20 << 20

function portableMimeType(value: string): string {
  const mime = value.split(';', 1)[0]!.trim().toLowerCase()
  if (mime === 'image/jpg' || mime === 'image/pjpeg') return 'image/jpeg'
  if (mime === 'image/x-png') return 'image/png'
  return mime
}

export async function exportExcalidraw(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(req, res, req.params.docId!, 'reader')
  if (!guard) return
  if (guard.meta.doc_type !== WHITEBOARD_DOC_TYPE) throw new CliError('CONFLICT', { reason: 'unsupported_doc_type' })
  const { elements: live, files: refs } = await loadBoard(guard.meta.document_name)
  const elements = live.filter(element => element.isDeleted !== true).map(element =>
    element.type === 'arrow' || element.type === 'line' ? { ...element, lastCommittedPoint: null } : element)
  const fileIds = new Set(elements.flatMap(element =>
    typeof element.fileId === 'string' && element.fileId !== '' ? [element.fileId] : []))
  const files: Record<string, unknown> = Object.create(null)
  const exported = { type: 'excalidraw', version: 2, source: 'octo-cli', elements, appState: {}, files }
  const limit = Math.min(config.docxImport.maxUploadBytes, 25 << 20)
  let used = Buffer.byteLength(JSON.stringify(exported))
  if (fileIds.size > maxPortableAttachments || used > limit) throw new CliError('PAYLOAD_TOO_LARGE')

  if (fileIds.size > 0) {
    if (res.locals.cliCanReadAttachments !== true) throw new CliError('FORBIDDEN')
    const attachments = await docAttachmentRepo.listByDoc(guard.meta.doc_id)
    const byId = new Map(attachments.map(attachment => [attachment.attachId, attachment]))
    const signal = AbortSignal.timeout(30_000)
    for (const fileId of fileIds) {
      const ref = refs[fileId]
      const attachment = typeof ref?.attachId === 'string' ? byId.get(ref.attachId) : undefined
      if (!attachment || attachment.docId !== guard.meta.doc_id) {
        throw new CliError('CONFLICT', { reason: 'portable_attachment_missing' })
      }
      const mime = portableMimeType(attachment.mime)
      const entry = {
        id: fileId, mimeType: mime,
        dataURL: `data:${mime};base64,`,
        created: typeof ref?.createdAt === 'number' ? ref.createdAt : 0, lastRetrieved: 0,
      }
      const overhead = Buffer.byteLength(JSON.stringify(fileId) + ':' + JSON.stringify(entry)) + 1
      const maxBytes = Math.min(maxPortableAttachmentBytes, 3 * Math.floor((limit - used - overhead) / 4))
      if (maxBytes < 1 || attachment.sizeBytes > maxBytes) throw new CliError('PAYLOAD_TOO_LARGE')
      let bytes: Uint8Array
      try {
        bytes = await getObjectStore().download(attachment.objectKey, { maxBytes, signal })
      } catch {
        throw new CliError('UPSTREAM_UNAVAILABLE', { reason: 'portable_attachment_unavailable' })
      }
      const image = sanitizeSceneImage(Buffer.from(bytes))
      if (!image || image.mime !== mime) {
        throw new CliError('CONFLICT', { reason: 'portable_attachment_invalid' })
      }
      const encoded = image.bytes.toString('base64')
      used += overhead + encoded.length
      if (used > limit) throw new CliError('PAYLOAD_TOO_LARGE')
      entry.dataURL += encoded
      files[fileId] = entry
    }
  }
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Disposition', `attachment; filename="${guard.meta.doc_id}.excalidraw"`)
  res.type('application/vnd.excalidraw+json').send(JSON.stringify(exported))
}
