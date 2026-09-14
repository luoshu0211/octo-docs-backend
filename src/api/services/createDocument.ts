import { transaction, type Tx } from '../../db/pool.js'
import { docMetaRepo, type CreateDocInput } from '../../db/repos/docMetaRepo.js'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { ROLE_ADMIN } from '../../permission/role.js'

/** Content adapters participate in the same metadata/member transaction. */
export interface DocumentCreation<T> {
  input: CreateDocInput
  humanOwnerUid?: string
  before?: (tx: Tx) => Promise<void>
  initialize?: (tx: Tx) => Promise<void>
  complete: (tx: Tx, meta: Awaited<ReturnType<typeof docMetaRepo.getByDocIdTx>>) => Promise<T>
}

export function createDocument<T>(creation: DocumentCreation<T>): Promise<T> {
  return transaction(async tx => {
    await creation.before?.(tx)
    const input = creation.input
    await docMetaRepo.createTx(tx, input)
    for (const uid of new Set([input.ownerId, creation.humanOwnerUid].filter((uid): uid is string => !!uid))) {
      await docMemberRepo.upsertDirectTx(tx, { docId: input.docId, uid,
        principalSpaceId: input.spaceId, roleNum: ROLE_ADMIN, grantedBy: input.createdBy })
    }
    await creation.initialize?.(tx)
    return creation.complete(tx, await docMetaRepo.getByDocIdTx(tx, input.docId))
  })
}
