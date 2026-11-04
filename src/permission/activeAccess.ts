import { docMetaRepo } from '../db/repos/docMetaRepo.js'
import {
  getDriveDerivedAccess,
  invalidateDriveDerivedAccess,
  type DerivedAccessBinding,
  type DerivedAccessVersion,
} from '../drive/derivedAccessClient.js'
import type { CurrentAccess } from './resolveRole.js'

const REVALIDATION_INTERVAL_MS = 5_000
const MAX_VERSION_BATCH = 50

export interface ActiveAccessState extends CurrentAccess { permissionEpoch: number }
export type ActiveAccessResolver = () => Promise<CurrentAccess>

export interface ActiveAccessParticipant {
  /** Synchronously stop all document-content delivery before a source check. */
  freeze(): void
  /** Resume delivery after an authoritative current-role result. */
  resume(state: ActiveAccessState): void
  /** Close only after authority is confirmed absent or its proof expires unknown. */
  close(code: 4401 | 4403, reason: string): void
}

export interface ActiveAccessBinding extends DerivedAccessBinding {
  documentName: string
}

interface BindingRecord {
  key: string
  binding: ActiveAccessBinding
  state: ActiveAccessState
  resolve: ActiveAccessResolver
  participants: Set<ActiveAccessParticipant>
  generation: number
  frozen: boolean
  refreshing: boolean
  probing: boolean
}

const bindings = new Map<string, BindingRecord>()
let pollTimer: NodeJS.Timeout | undefined
let pollInProgress = false

function bindingKey(binding: DerivedAccessBinding): string {
  return JSON.stringify([binding.docId, binding.uid, binding.principalSpaceId])
}

function freeze(record: BindingRecord): void {
  if (record.frozen) return
  record.frozen = true
  for (const participant of record.participants) participant.freeze()
}

function resume(record: BindingRecord, state: ActiveAccessState): void {
  record.state = state
  record.frozen = false
  for (const participant of record.participants) participant.resume(state)
}

function close(record: BindingRecord, code: 4401 | 4403, reason: string): void {
  record.generation++
  record.frozen = true
  bindings.delete(record.key)
  for (const participant of record.participants) participant.close(code, reason)
}

function stateForRegistration(record: BindingRecord, state: ActiveAccessState): ActiveAccessState {
  const previous = record.state
  if (state.permissionEpoch === previous.permissionEpoch &&
      previous.sourceConfirmed && state.sourceConfirmed &&
      state.sourceRevision !== null &&
      state.sourceRevision === previous.sourceRevision &&
      previous.proofExpiresAt !== null && state.proofExpiresAt !== null &&
      state.proofExpiresAt > previous.proofExpiresAt) {
    return { ...state, proofExpiresAt: previous.proofExpiresAt }
  }
  return state
}

function retainPreviousProof(record: BindingRecord, epochChanged: boolean, state: CurrentAccess | null): boolean {
  const old = record.state
  const now = performance.now()
  if (epochChanged && state && state.permissionEpoch !== old.permissionEpoch && state.role === 'none') return false
  if (old.sourceRevision !== null && old.proofExpiresAt !== null && now >= old.proofExpiresAt) return false
  return true
}

async function refresh(record: BindingRecord, epochChanged = false): Promise<void> {
  if (bindings.get(record.key) !== record) return
  const generation = ++record.generation
  record.refreshing = true
  freeze(record)

  let current: CurrentAccess | null = null
  try {
    current = await record.resolve()
  } catch {
    current = null
  }

  if (bindings.get(record.key) !== record || record.generation !== generation) return
  record.refreshing = false

  if (!current) {
    if (epochChanged || !retainPreviousProof(record, false, null)) {
      close(record, 4401, 'Authorization could not be confirmed')
    } else {
      resume(record, record.state)
    }
    return
  }

  if (current.role === 'none' && current.sourceConfirmed) {
    close(record, 4403, 'Forbidden')
    return
  }
  if (!current.sourceConfirmed) {
    if (!retainPreviousProof(record, epochChanged, current)) {
      close(record, 4401, 'Authorization could not be confirmed')
    } else {
      resume(record, record.state)
    }
    return
  }

  if (current.sourceRevision !== null &&
      (current.proofExpiresAt === null || current.proofExpiresAt <= performance.now())) {
    close(record, 4401, 'Authorization could not be confirmed')
    return
  }

  const permissionEpoch = current.permissionEpoch ?? record.state.permissionEpoch
  resume(record, { ...current, permissionEpoch })
}

export function registerActiveAccess(
  binding: ActiveAccessBinding,
  permissionEpoch: number,
  initial: CurrentAccess,
  resolve: ActiveAccessResolver,
  participant: ActiveAccessParticipant,
): () => void {
  const key = bindingKey(binding)
  const state: ActiveAccessState = { ...initial, permissionEpoch }
  let record = bindings.get(key)
  if (record) {
    record.binding = binding
    record.resolve = resolve
    record.participants.add(participant)
    const nextState = stateForRegistration(record, state)
    if (record.refreshing) {
      const sameEpochIndependent = state.permissionEpoch === record.state.permissionEpoch &&
        state.sourceConfirmed && state.sourceRevision === null
      const sameEpochSourceChange = state.permissionEpoch === record.state.permissionEpoch &&
        state.sourceConfirmed && state.sourceRevision !== null &&
        state.sourceRevision !== record.state.sourceRevision
      const newerEpoch = state.permissionEpoch > record.state.permissionEpoch
      if (sameEpochIndependent || sameEpochSourceChange || newerEpoch) {
        // A fresh independent/source-changed result or a newer Docs epoch
        // supersedes an older in-flight source result. Same-epoch/same-source
        // registration does not extend the shared Drive proof; let its existing
        // refresh decide.
        record.generation++
        record.refreshing = false
        resume(record, nextState)
      } else {
        participant.freeze()
      }
    } else {
      record.generation++
      resume(record, nextState)
    }
  } else {
    record = {
      key,
      binding,
      state,
      resolve,
      participants: new Set([participant]),
      generation: 0,
      frozen: false,
      refreshing: false,
      probing: false,
    }
    bindings.set(key, record)
  }

  return () => {
    const current = bindings.get(key)
    if (current !== record) return
    current.participants.delete(participant)
    if (current.participants.size === 0) {
      current.generation++
      bindings.delete(key)
    }
  }
}

/** Revalidate only active bindings matching a Drive source-change notice. */
export function invalidateActiveAccess(
  docId: string,
  principalSpaceId: string,
  uid?: string,
): void {
  for (const record of bindings.values()) {
    if (record.binding.docId !== docId || record.binding.principalSpaceId !== principalSpaceId) continue
    if (uid !== undefined && record.binding.uid !== uid) continue
    void refresh(record)
  }
}

/** Freeze one shared binding for a deadline renewal, never one RPC per connection. */
export function renewActiveAccess(binding: DerivedAccessBinding): boolean {
  const record = bindings.get(bindingKey(binding))
  if (!record || record.state.sourceRevision === null) return false
  if (record.refreshing) return true
  // A pending version/epoch probe cannot authorize an expired proof. Preserve
  // fail-closed delivery rather than start a competing read behind a blocked poll.
  if (record.probing) return false
  invalidateDriveDerivedAccess(binding.docId, binding.uid, binding.principalSpaceId)
  void refresh(record)
  return true
}

function mapVersions(
  batch: readonly ActiveAccessBinding[],
  versions: readonly DerivedAccessVersion[] | null,
): Map<string, DerivedAccessVersion> {
  const mapped = new Map<string, DerivedAccessVersion>()
  if (!versions || versions.length !== batch.length) return mapped
  for (let index = 0; index < batch.length; index++) {
    const version = versions[index]!
    const binding = batch[index]!
    if (version.docId !== binding.docId || version.uid !== binding.uid ||
        version.principalSpaceId !== binding.principalSpaceId || version.expiresAt <= performance.now()) continue
    mapped.set(bindingKey(binding), version)
  }
  return mapped
}

/** One 5-second round: unique authoritative DB epochs plus bounded source-version batches. */
export async function pollActiveAccess(): Promise<void> {
  if (pollInProgress || bindings.size === 0) return
  pollInProgress = true
  const snapshot = [...bindings.values()].filter(record => !record.refreshing)
  for (const record of snapshot) record.probing = true
  try {
    if (snapshot.length === 0) return

    const documentIds = [...new Set(snapshot.map(record => record.binding.docId))]
    const derivedBindings = snapshot.filter(record => record.state.sourceRevision !== null)
      .map(record => record.binding)
    const versionBatches: ActiveAccessBinding[][] = []
    for (let offset = 0; offset < derivedBindings.length; offset += MAX_VERSION_BATCH) {
      versionBatches.push(derivedBindings.slice(offset, offset + MAX_VERSION_BATCH))
    }
    const [epochResult, versionResults] = await Promise.all([
      docMetaRepo.getEpochsByDocIds(documentIds).then(rows => ({ rows, ok: true as const }))
        .catch(() => ({ rows: [], ok: false as const })),
      Promise.all(versionBatches.map(async batch => {
        try {
          const versions = await getDriveDerivedAccess().versions(batch)
          return mapVersions(batch, versions)
        } catch {
          return new Map<string, DerivedAccessVersion>()
        }
      })),
    ])

    const epochs = new Map(epochResult.rows.map(row => [row.doc_id, row.permission_epoch]))
    const versions = new Map<string, DerivedAccessVersion>()
    for (const result of versionResults) for (const [key, value] of result) versions.set(key, value)
    const now = performance.now()

    for (const record of snapshot) {
      if (bindings.get(record.key) !== record || record.refreshing) continue
      const epoch = epochResult.ok ? epochs.get(record.binding.docId) : undefined
      const epochChanged = epochResult.ok && (epoch === undefined || epoch !== record.state.permissionEpoch)
      const version = versions.get(record.key)
      const sourceChanged = version !== undefined && record.state.sourceRevision !== null &&
        version.sourceRevision !== record.state.sourceRevision
      const proofDue = record.state.sourceRevision !== null && record.state.proofExpiresAt !== null &&
        now + REVALIDATION_INTERVAL_MS >= record.state.proofExpiresAt
      if (sourceChanged || proofDue) {
        invalidateDriveDerivedAccess(record.binding.docId, record.binding.uid, record.binding.principalSpaceId)
      }
      if (epochChanged || sourceChanged || proofDue) void refresh(record, epochChanged)
    }
  } finally {
    for (const record of snapshot) record.probing = false
    pollInProgress = false
  }
}

export function startActiveAccessMonitor(): () => void {
  pollTimer = setInterval(() => { void pollActiveAccess() }, REVALIDATION_INTERVAL_MS)
  pollTimer.unref()
  return () => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = undefined
  }
}
