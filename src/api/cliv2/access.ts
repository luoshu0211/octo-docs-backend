import type { Request, Response } from 'express'
import { docMemberRepo, memberTransaction } from '../../db/repos/docMemberRepo.js'
import { docMetaRepo, type DocMeta } from '../../db/repos/docMetaRepo.js'
import type { Tx } from '../../db/pool.js'
import { refreshAndPublish } from '../../permission/epoch.js'
import { isMemberRole, roleToNumber } from '../../permission/role.js'
import { DISCOVERABILITY_SPACE, SHARE_SCOPE_AUTHENTICATED } from '../../permission/shareScope.js'
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
  const body = result.body as { data?: { user?: { user_id?: string; principal_type?: unknown }; space?: { space_id?: string } } } | null
  const user = body?.data?.user
  if (result.status !== 200 || user?.user_id !== uid || body?.data?.space?.space_id !== spaceId) {
    throw new CliError('UPSTREAM_UNAVAILABLE')
  }
  if (user.principal_type === 'user_bot' || user.principal_type === 'app_bot') throw new CliError('NOT_FOUND')
  if (user.principal_type !== 'human') throw new CliError('UPSTREAM_UNAVAILABLE')
}

async function lockCliAdminDoc(tx: Tx, req: Request, docId: string): Promise<DocMeta> {
  const [meta] = await tx.query<DocMeta>('SELECT * FROM doc_meta WHERE doc_id = ? FOR UPDATE', [docId])
  if (!meta || meta.status === 0 || meta.space_id !== req.spaceId) throw new CliError('NOT_FOUND')
  const owner = meta.owner_id === req.uid && meta.owner_space_id === req.principalSpaceId
  const role = owner ? 'admin' : await docMemberRepo.getRoleTx(tx, meta.doc_id, req.uid!, req.principalSpaceId!, true)
  if (role !== 'admin') throw new CliError('FORBIDDEN')
  if (meta.status !== 1) throw new CliError('CONFLICT')
  return meta
}

async function requireCliAdminTx(tx: Tx, req: Request, authorized: DocMeta): Promise<DocMeta> {
  const meta = await lockCliAdminDoc(tx, req, authorized.doc_id)
  if (Number(meta.permission_epoch) !== Number(authorized.permission_epoch)) {
    throw new CliError('CONFLICT', { reason: 'epoch_changed' })
  }
  return meta
}

export async function renameCliDoc(req: Request, authorized: DocMeta, title: string): Promise<void> {
  await memberTransaction(async tx => {
    const meta = await requireCliAdminTx(tx, req, authorized)
    await docMetaRepo.rename(meta.doc_id, title, req.uid!, tx)
  })
}

export async function setCliShareSettings(
  req: Request, docId: string, scopeNum: number, roleNum: number, expectedPermissionEpoch: number,
) {
  return memberTransaction(async tx => {
    const meta = await lockCliAdminDoc(tx, req, docId)
    if (meta.share_scope === SHARE_SCOPE_AUTHENTICATED) throw new CliError('FORBIDDEN')
    return docMetaRepo.setShareSettingsTx(
      tx, meta.doc_id, scopeNum, roleNum, meta.discoverability_scope === DISCOVERABILITY_SPACE, expectedPermissionEpoch,
    )
  })
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
  const write = {
    docId: guard.meta.doc_id, uid, principalSpaceId: spaceId,
    roleNum: roleToNumber(role), grantedBy: req.uid!,
  }
  const { created } = await memberTransaction(async tx => {
    const meta = await requireCliAdminTx(tx, req, guard.meta)
    const owner = uid === meta.owner_id && spaceId === meta.owner_space_id
    let created = false
    if (owner) await docMemberRepo.upsertDirectTx(tx, write)
    else ({ created } = await docMemberRepo.upsertDirectWithNotificationTx(tx, { ...write, notifyRecipient: true }))
    await docMetaRepo.bumpEpochTx(tx, meta.doc_id)
    return { created }
  })
  await refreshAndPublish(guard.meta.document_name, Number(guard.meta.permission_epoch) + 1, uid)
  res.json({ ok: true, created, notified: created })
}

export async function removeCliMember(req: Request, res: Response) {
  const guard = await requireDocRole(req, res, req.params.docId!, 'admin')
  if (!guard) return
  const uid = req.params.uid!
  const spaceId = req.query.principalSpaceId
  if (typeof spaceId !== 'string' || !spaceId.trim() || spaceId.trim() !== spaceId) throw new CliError('VALIDATION_ERROR')
  if (uid === req.uid && spaceId === req.spaceId) throw new CliError('FORBIDDEN')
  const removed = await memberTransaction(async tx => {
    const meta = await requireCliAdminTx(tx, req, guard.meta)
    if (uid === meta.owner_id && spaceId === meta.owner_space_id) throw new CliError('FORBIDDEN')
    return docMemberRepo.removePrincipalExactTx(tx, { docId: meta.doc_id, uid, principalSpaceId: spaceId })
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
  const result = await memberTransaction(async tx => {
    const meta = await requireCliAdminTx(tx, req, guard.meta)
    return grantForwardAccess({
      docId: meta.doc_id, documentName: meta.document_name, uid,
      principalSpaceId: meta.space_id, roleNum: roleToNumber(role), grantedBy: req.uid!,
    }, { tx, ownerId: meta.owner_id, ownerSpaceId: meta.owner_space_id })
  })
  if (result.changed) await refreshAndPublish(guard.meta.document_name, Number(guard.meta.permission_epoch) + 1, uid)
  res.json({ ok: true, role: result.finalRole, changed: result.changed })
}
