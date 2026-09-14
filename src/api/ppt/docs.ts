import type { Request } from 'express'
import { pptDocStateRepo } from '../../db/repos/pptDocStateRepo.js'
import {
  pptIdempotencyRepo,
  PPT_IDEMPOTENCY_SCOPE_CREATE,
} from '../../db/repos/pptIdempotencyRepo.js'
import { createDocument } from '../services/createDocument.js'
import { hashCanonicalPayload } from '../../ppt/idempotency.js'
import { buildPptDocumentName, DocumentNameError } from '../../permission/documentName.js'
import { HTML_PPT_DOC_TYPE } from '../../db/docType.js'
import { newDocId } from '../../util/ids.js'
import { buildDocShareUrl, buildPptEditorUrl } from '../../util/docShareLink.js'
import { config } from '../../config/env.js'
import { getPptTemplate } from '../../ppt/templates.js'
import { instantiateTemplate } from '../../ppt/bentoDoc.js'
import { PptApiError } from './envelope.js'

const DEFAULT_FOLDER = 'f_default'
/** Matches `doc_meta.title VARCHAR(512)` and the legacy create title bound. */
const MAX_TITLE_LEN = 512
/** `Idempotency-Key` header length cap (idempotency_key VARCHAR(255)). */
const MAX_IDEMPOTENCY_KEY_LEN = 255

/**
 * Body fields a client MUST NOT supply on human create: they are either
 * server-owned identity/mount fields (spoofing guard, §4.1 / PPT-API-004) or the
 * header-only idempotency key (§4.1 / PPT-IDEMP-003). Any presence is a hard 400.
 */
const FORBIDDEN_BODY_FIELDS = ['ownerId', 'spaceId', 'mountType', 'octoDocSlug', 'botToken', 'idempotencyKey'] as const

function vErr(message: string, details?: unknown): PptApiError {
  return new PptApiError('VALIDATION_ERROR', message, details === undefined ? {} : { details })
}

/** Enveloped `data` payload of a successful create (also the replayed body). */
interface PptCreateResponse {
  docId: string
  documentName: string
  title: string
  spaceId: string
  folderId: string
  ownerId: string
  docType: string
  role: 'admin'
  templateId: string
  draftRevision: number
  snapshotVersion: number
  editorUrl: string
  shareUrl: string
  createdAt?: Date
}

/**
 * Internal sentinel: a concurrent request already reserved this idempotency key,
 * so the current transaction must abort (rolling back its own placeholder attempt)
 * and fall through to a committed re-read. Never leaves the module.
 */
class KeyReservedElsewhereError extends Error {
  constructor() {
    super('idempotency key reserved by a concurrent request')
    this.name = 'KeyReservedElsewhereError'
  }
}

/** Create from `{ title, folderId?, templateId }` after the mount's auth guards. */
export async function createPptDocument(req: Request): Promise<PptCreateResponse> {
  const uid = req.uid!
  const spaceId = req.spaceId!
  const body = (req.body ?? {}) as Record<string, unknown>

  // 1. Reject spoofed server-owned fields + body idempotencyKey BEFORE any work.
  const present = FORBIDDEN_BODY_FIELDS.filter((f) => body[f] !== undefined)
  if (present.length > 0) {
    throw vErr('request body must not include server-owned fields', { fields: present })
  }

  // 2. Idempotency is header-only and required on create (§4.1).
  const rawKey = req.header('Idempotency-Key')
  const idempotencyKey = typeof rawKey === 'string' ? rawKey.trim() : ''
  if (idempotencyKey === '') {
    throw vErr('Idempotency-Key header is required', { field: 'Idempotency-Key' })
  }
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LEN) {
    throw vErr('Idempotency-Key header is too long', { field: 'Idempotency-Key', max: MAX_IDEMPOTENCY_KEY_LEN })
  }

  // 3. Title: required, non-empty (after trim), within the column bound.
  const title = body.title
  if (typeof title !== 'string' || title.trim() === '') {
    throw vErr('title is required', { field: 'title' })
  }
  if (title.length > MAX_TITLE_LEN) {
    throw vErr('title is too long', { field: 'title', max: MAX_TITLE_LEN })
  }

  // 4. templateId: required, one of the four fixed bundled templates.
  const templateIdRaw = body.templateId ?? 'blank'
  const template = typeof templateIdRaw === 'string' ? getPptTemplate(templateIdRaw) : null
  if (!template) {
    throw vErr('templateId must be one of the four bundled templates', { field: 'templateId' })
  }
  const templateId = templateIdRaw as string

  // 5. Folder: optional; default reserved folder. Building the documentName here
  //    validates the space + folder segments. Attribute a rejected segment to the
  //    correct field: the space comes from the X-Space-Id header, the folder from
  //    the body (the docId segment is server-minted and always valid), so a
  //    client is never misled about which input was bad.
  const folderRaw = body.folderId
  const folder = typeof folderRaw === 'string' && folderRaw !== '' ? folderRaw : DEFAULT_FOLDER
  const docId = newDocId()
  let documentName: string
  try {
    documentName = buildPptDocumentName(spaceId, folder, docId)
  } catch (err) {
    if (err instanceof DocumentNameError) {
      // buildPptDocumentName's message names the offending segment (space|folder|doc).
      if (/\bspace\b/.test(err.message)) throw vErr('invalid X-Space-Id segment', { field: 'X-Space-Id' })
      throw vErr('invalid folderId segment', { field: 'folderId' })
    }
    throw err
  }

  // Canonical payload for idempotency: only the fields that determine the created
  // resource (NOT the header, NOT the minted docId). Same key + same canonical
  // payload replays; same key + different payload conflicts.
  const requestHash = hashCanonicalPayload({ title, folderId: folder, templateId })

  // Replay/conflict against a prior COMMITTED record for this (space, create, uid,
  // key). The idempotency row is scoped by the authenticated `uid`: the created
  // deck is owned by / grants admin to this caller and the stored response carries
  // that identity, so a DIFFERENT user reusing the same key must NOT replay this
  // caller's response (cross-user leak). Read outside the transaction — only
  // committed rows are visible here.
  const prior = await pptIdempotencyRepo.get(spaceId, PPT_IDEMPOTENCY_SCOPE_CREATE, uid, idempotencyKey)
  if (prior) {
    if (prior.requestHash !== requestHash) {
      throw new PptApiError('CONFLICT', 'Idempotency-Key was reused with a different payload', {
        details: { idempotencyKey },
      })
    }
    // A committed row is always complete (reserve+complete commit together), so
    // this replays the original response.
    return prior.responseData as PptCreateResponse
  }

  // Materialize the deck (pure, no I/O): strip `template`, mint a fresh Bento
  // docId, drop collab. Done before the transaction so no work is wasted holding
  // a DB connection.
  const deck = instantiateTemplate(template, new Date().toISOString())
  deck.title = title.trim()

  // ATOMIC create. Reserve the idempotency key, write doc_meta + owner membership
  // + PPT state, and complete the idempotency record in ONE transaction. If any
  // step throws, the whole transaction rolls back: no orphan doc_meta/member/state
  // row is left behind, and the reserve placeholder is rolled back too — so the
  // key is NEVER permanently stranded and a later retry with the same key can
  // still succeed (no duplicate deck).
  let data: PptCreateResponse
  try {
    data = await createDocument({
      input: { docId, documentName, title, ownerId: uid, spaceId, folderId: folder, docType: HTML_PPT_DOC_TYPE, createdBy: uid },
      humanOwnerUid: req.docSpaceScope?.mode === 'bot' ? req.botOwnerUid : undefined,
      before: async tx => {
      const { reserved } = await pptIdempotencyRepo.reserveTx(
        tx,
        spaceId,
        PPT_IDEMPOTENCY_SCOPE_CREATE,
        uid,
        idempotencyKey,
        requestHash,
      )
      // A concurrent request already claimed this key. Abort (rolling back this
      // transaction's placeholder attempt) and fall through to a committed re-read.
      if (!reserved) throw new KeyReservedElsewhereError()

      },
      initialize: tx => pptDocStateRepo.createTx(tx, { docId, templateId, draftDoc: deck }),
      complete: async (tx, meta) => {
      const payload: PptCreateResponse = {
        docId,
        documentName,
        title,
        spaceId,
        folderId: folder,
        ownerId: uid,
        docType: HTML_PPT_DOC_TYPE,
        role: 'admin',
        templateId,
        draftRevision: 0,
        snapshotVersion: 0,
        editorUrl: buildPptEditorUrl(config.webOrigin, docId, spaceId),
        shareUrl: buildDocShareUrl(config.webOrigin, docId, spaceId),
        ...(meta?.created_at ? { createdAt: meta.created_at } : {}),
      }
      // Record the response as the LAST write so a header replay returns it
      // byte-for-byte. It commits atomically with the doc writes above.
      await pptIdempotencyRepo.completeTx(
        tx,
        spaceId,
        PPT_IDEMPOTENCY_SCOPE_CREATE,
        uid,
        idempotencyKey,
        201,
        payload,
        docId,
      )
      return payload
      },
    })
  } catch (err) {
    if (err instanceof KeyReservedElsewhereError) {
      // The winner has committed (or is a prior create). Re-read committed data
      // and replay/conflict — WITHOUT creating a duplicate deck.
      const winner = await pptIdempotencyRepo.get(spaceId, PPT_IDEMPOTENCY_SCOPE_CREATE, uid, idempotencyKey)
      if (winner && winner.requestHash !== requestHash) {
        throw new PptApiError('CONFLICT', 'Idempotency-Key was reused with a different payload', {
          details: { idempotencyKey },
        })
      }
      if (winner && winner.completed) {
        return winner.responseData as PptCreateResponse
      }
      // The winner's transaction has not committed yet (rare, transient). Ask the
      // client to retry; nothing was created here.
      throw new PptApiError('CONFLICT', 'an identical create is in progress; retry', {
        details: { idempotencyKey },
        hint: 'retry',
      })
    }
    throw err
  }

  return data
}
