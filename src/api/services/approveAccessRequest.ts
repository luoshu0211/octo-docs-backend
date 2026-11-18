import { transaction } from '../../db/pool.js'
import { docAccessRequestRepo, REQUEST_STATUS_APPROVED } from '../../db/repos/docAccessRequestRepo.js'
import { docLibraryEventRepo } from '../../db/repos/docLibraryEventRepo.js'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import { refreshAndPublish } from '../../permission/epoch.js'
import { roleAtLeast, roleFromNumber, roleToNumber, type Role } from '../../permission/role.js'

export interface ApproveAccessRequestParams {
  docId: string
  requestId: string
  documentName: string
  ownerUid: string
  ownerSpaceId: string
  uid: string
  principalSpaceId: string
  roleNum: number
  allowAdmin?: boolean
  decidedBy: string
  /** The winning decider's trusted Space, persisted atomically with the CAS. */
  decidedBySpaceId: string
  /** Authoritative decision time (unix seconds), persisted atomically with the CAS. */
  decidedAtUnix: number
}

export interface ApproveAccessRequestResult {
  transitioned: boolean
  requesterRole?: Role
}

/**
 * Atomically consumes a pending request and applies its primary Human grant.
 * Bot fan-out deliberately happens after this transaction. A failed primary
 * grant throws, rolling the CAS and epoch mutation back so approval is retryable.
 */
export async function approveAccessRequest(
  params: ApproveAccessRequestParams,
): Promise<ApproveAccessRequestResult> {
  const granted = roleFromNumber(params.roleNum)
  if (!granted || (granted === 'admin' && params.allowAdmin !== true)) {
    throw new Error(`invalid approval role ${params.roleNum}`)
  }

  const committed = await transaction(async (tx) => {
    const transitioned = await docAccessRequestRepo.decideTx(tx, {
      docId: params.docId,
      requestId: params.requestId,
      status: REQUEST_STATUS_APPROVED,
      decidedBy: params.decidedBy,
      decidedBySpaceId: params.decidedBySpaceId,
      decidedAtUnix: params.decidedAtUnix,
    })
    if (!transitioned) return { transitioned: false as const }

    const owner = params.uid === params.ownerUid && params.principalSpaceId === params.ownerSpaceId
    const current = owner
      ? 'admin' as const
      : (await docMemberRepo.getRoleTx(tx, params.docId, params.uid, params.principalSpaceId)) ?? 'none'
    const changed = current !== 'admin' && await docMemberRepo.upsertGrantMaxTx(tx, {
      docId: params.docId,
      uid: params.uid,
      principalSpaceId: params.principalSpaceId,
      roleNum: params.roleNum,
      grantedBy: params.decidedBy,
    })
    let newEpoch: number | undefined
    if (changed) {
      await docMetaRepo.bumpEpochTx(tx, params.docId)
      const rows = await tx.query<{ permission_epoch: number }>(
        'SELECT permission_epoch FROM doc_meta WHERE doc_id = ? LIMIT 1',
        [params.docId],
      )
      newEpoch = Number(rows[0]?.permission_epoch ?? 0)
    }
    const requesterRole: Role = roleAtLeast(current, granted) ? current as Role : granted
    await docLibraryEventRepo.record(tx, { uid: params.uid, spaceId: params.principalSpaceId }, {
      kind: 'access_approved', docId: params.docId, requestId: params.requestId,
      actorUid: params.decidedBy, newRole: roleToNumber(requesterRole),
    })
    return { transitioned: true as const, requesterRole, newEpoch }
  })

  if (committed.transitioned && committed.newEpoch !== undefined) {
    await refreshAndPublish(params.documentName, committed.newEpoch, params.uid)
  }
  return committed
}
