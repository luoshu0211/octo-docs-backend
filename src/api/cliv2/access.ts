import type { Request, Response } from 'express'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { bumpEpoch, refreshAndPublish } from '../../permission/epoch.js'
import { isMemberRole, roleToNumber } from '../../permission/role.js'
import { requireDocRole } from '../guard.js'
import { grantForwardAccess } from '../services/grantForward.js'
import { CliError, cliServiceURL, postCliService } from './auth.js'

async function requireSpaceUser(uid: string, spaceId: string) {
  const origin = process.env.OCTO_SERVER_INTERNAL_URL?.trim()
  const secret = process.env.OCTO_MEMBERSHIP_INTERNAL_TOKEN?.trim()
  if (!origin || !secret) throw new CliError('UPSTREAM_UNAVAILABLE')
  const result = await (async () => postCliService(
    cliServiceURL(origin, '/v1/internal/auth/identity'),
    { 'x-internal-token': secret }, { user_id: uid, space_id: spaceId },
  ))().catch(() => { throw new CliError('UPSTREAM_UNAVAILABLE') })
  if (result.status === 404) throw new CliError('NOT_FOUND')
  const body = result.body as { data?: { user?: { user_id?: string }; space?: { space_id?: string } } } | null
  if (result.status !== 200 || body?.data?.user?.user_id !== uid || body.data.space?.space_id !== spaceId) {
    throw new CliError('UPSTREAM_UNAVAILABLE')
  }
}

export async function setCliMember(req: Request, res: Response) {
  const guard = await requireDocRole(req, res, req.params.docId!, 'admin')
  if (!guard) return
  const { uid, role, principalSpaceId } = req.body ?? {}
  const spaceId = req.spaceId!
  if (typeof uid !== 'string' || !uid || uid.trim() !== uid || !isMemberRole(role) ||
      (principalSpaceId !== undefined && principalSpaceId !== spaceId)) {
    throw new CliError('VALIDATION_ERROR')
  }
  await requireSpaceUser(uid, spaceId)
  const owner = uid === guard.meta.owner_id && spaceId === guard.meta.owner_space_id
  const write = {
    docId: guard.meta.doc_id, uid, principalSpaceId: spaceId,
    roleNum: roleToNumber(role), grantedBy: req.uid!,
  }
  let created = false
  if (owner) await docMemberRepo.upsertDirect(write)
  else ({ created } = await docMemberRepo.upsertDirectWithNotification({ ...write, notifyRecipient: true }))
  await bumpEpoch(guard.meta.doc_id, guard.meta.document_name, uid)
  res.json({ ok: true, created, notified: created })
}

export async function removeCliMember(req: Request, res: Response) {
  const guard = await requireDocRole(req, res, req.params.docId!, 'admin')
  if (!guard) return
  const uid = req.params.uid!
  const spaceId = req.query.principalSpaceId
  if (typeof spaceId !== 'string' || !spaceId.trim() || spaceId.trim() !== spaceId) throw new CliError('VALIDATION_ERROR')
  if ((uid === guard.meta.owner_id && spaceId === guard.meta.owner_space_id) ||
      (uid === req.uid && spaceId === req.spaceId)) throw new CliError('FORBIDDEN')
  const removed = await docMemberRepo.removePrincipalExact({
    docId: guard.meta.doc_id, uid, principalSpaceId: spaceId,
  })
  if (removed.changed && removed.newEpoch !== undefined) {
    await refreshAndPublish(guard.meta.document_name, removed.newEpoch)
  }
  res.json({ ok: true, removedUids: removed.removedUids })
}

export async function forwardCliGrant(req: Request, res: Response) {
  const guard = await requireDocRole(req, res, req.params.docId!, 'admin')
  if (!guard) return
  const { uid, role } = req.body ?? {}
  if (typeof uid !== 'string' || !uid || uid.trim() !== uid || (role !== 'reader' && role !== 'commenter' && role !== 'writer')) {
    throw new CliError('VALIDATION_ERROR')
  }
  await requireSpaceUser(uid, guard.meta.space_id)
  const result = await grantForwardAccess({
    docId: guard.meta.doc_id, documentName: guard.meta.document_name, uid,
    principalSpaceId: guard.meta.space_id, roleNum: roleToNumber(role), grantedBy: req.uid!,
  })
  res.json({ ok: true, role: result.finalRole, changed: result.changed })
}
