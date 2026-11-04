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
const DIRECT_AUTHORITY_SCOPE = 'ppt:direct'
const EXPIRED_SHARE_AUTHORITY_SCOPE = 'ppt:expired-share-direct'

export interface ActiveAccessState extends CurrentAccess { permissionEpoch: number }
export type ActiveAccessResolver = () => Promise<CurrentAccess>
export interface ActiveAccessRegistrationLease {
  readonly authorityScope: string
  /** True for a Drive-version change observed after this lease began. */
  readonly sourceRevisionInvalidated: boolean
  /** Latest Drive source revision observed while this lease was pending. */
  readonly sourceRevisionWatermark?: string
  invalidated: boolean
  release(): void
}

interface PendingRegistration {
  binding: DerivedAccessBinding
  authorityScope: string
  invalidated: boolean
  sourceRevisionAtRegistration?: string
  sourceRevisionWatermark?: string
}


export interface ActiveAccessParticipant {
  /** Synchronously stop all document-content delivery before a source check. */
  freeze(): void
  /** Resume delivery after an authoritative current-role result. */
  resume(state: ActiveAccessState): void
  /** Return false when a newer authority generation owns the connection. */
  close(code: 4401 | 4403, reason: string): boolean | void
}

export interface ActiveAccessBinding extends DerivedAccessBinding {
  documentName: string
}

interface ParticipantRecord {
  state: ActiveAccessState
  resolve: ActiveAccessResolver
  authorityScope: string
  generation: number
  frozen: boolean
  refreshing: boolean
  probePending: boolean
}

interface ActiveRefreshTarget {
  generation: number
  epochChanged: boolean
}

interface RefreshParticipant {
  participant: ActiveAccessParticipant
  entry: ParticipantRecord
  epochChanged: boolean
}

interface ActiveRefresh {
  sourceRevision: string | null
  permissionEpoch: number
  epochChangedTargetCount: number
  targets: Map<ActiveAccessParticipant, ActiveRefreshTarget>
}

interface BindingRecord {
  key: string
  binding: ActiveAccessBinding
  permissionEpoch: number
  sourceRevision?: string
  /** Latest version returned by either a Drive version probe or a confirmed proof. */
  observedSourceRevision?: string
  participants: Map<ActiveAccessParticipant, ParticipantRecord>
  participantsByScope: Map<string, Set<ActiveAccessParticipant>>
  refreshes: Map<string, ActiveRefresh>
  probing: boolean
}
const bindings = new Map<string, BindingRecord>()
const pendingRegistrations = new Set<PendingRegistration>()

function isSourceDependent(entry: ParticipantRecord): boolean {
  return entry.state.sourceRevision !== null ||
    entry.authorityScope === EXPIRED_SHARE_AUTHORITY_SCOPE
}

function refreshKey(authorityScope: string, sourceDependent: boolean): string {
  return `${authorityScope}\0${sourceDependent ? 'source' : 'independent'}`
}

/** Group only participants with the same resolver authority; distinct share tickets use distinct scopes. */
export function beginActiveAccessRegistration(
  binding: DerivedAccessBinding,
  authorityScope: string,
): ActiveAccessRegistrationLease {
  const record = bindings.get(bindingKey(binding))
  const sourceRevisionWatermark = record?.observedSourceRevision ?? record?.sourceRevision
  const pending: PendingRegistration = {
    binding,
    authorityScope,
    invalidated: false,
    ...(sourceRevisionWatermark === undefined ? {} : {
      sourceRevisionAtRegistration: sourceRevisionWatermark,
      sourceRevisionWatermark,
    }),
  }
  pendingRegistrations.add(pending)
  return {
    authorityScope,
    get invalidated() { return pending.invalidated },
    set invalidated(value: boolean) { pending.invalidated = value },
    get sourceRevisionInvalidated() {
      return pending.sourceRevisionAtRegistration !== pending.sourceRevisionWatermark
    },
    get sourceRevisionWatermark() { return pending.sourceRevisionWatermark },
    release() { pendingRegistrations.delete(pending) },
  }
}

let pollTimer: NodeJS.Timeout | undefined
let pollInProgress = false

function bindingKey(binding: DerivedAccessBinding): string {
  return JSON.stringify([binding.docId, binding.uid, binding.principalSpaceId])
}

function updateSourceRevisionWatermark(record: BindingRecord, sourceRevision: string): void {
  record.observedSourceRevision = sourceRevision
  for (const pending of pendingRegistrations) {
    if (bindingKey(pending.binding) === record.key) {
      pending.sourceRevisionWatermark = sourceRevision
    }
  }
}
function addParticipantToScope(
  record: BindingRecord,
  participant: ActiveAccessParticipant,
  authorityScope: string,
): void {
  let participants = record.participantsByScope.get(authorityScope)
  if (!participants) {
    participants = new Set()
    record.participantsByScope.set(authorityScope, participants)
  }
  participants.add(participant)
}

function removeParticipantFromScope(
  record: BindingRecord,
  participant: ActiveAccessParticipant,
  authorityScope: string,
): void {
  const participants = record.participantsByScope.get(authorityScope)
  if (!participants) return
  participants.delete(participant)
  if (participants.size === 0) record.participantsByScope.delete(authorityScope)
}
function moveParticipantScope(
  record: BindingRecord,
  participant: ActiveAccessParticipant,
  entry: ParticipantRecord,
  authorityScope: string,
): void {
  if (entry.authorityScope === authorityScope) return
  removeParticipantFromScope(record, participant, entry.authorityScope)
  entry.authorityScope = authorityScope
  addParticipantToScope(record, participant, authorityScope)
}


function freezeParticipant(participant: ActiveAccessParticipant, entry: ParticipantRecord): void {
  if (entry.frozen) return
  entry.frozen = true
  participant.freeze()
}

function resumeParticipant(
  participant: ActiveAccessParticipant,
  entry: ParticipantRecord,
  state: ActiveAccessState,
): void {
  entry.state = state
  entry.refreshing = false
  entry.frozen = false
  participant.resume(state)
}

function detachActiveRefresh(
  record: BindingRecord,
  participant: ActiveAccessParticipant,
  entry: ParticipantRecord,
): void {
  const key = refreshKey(entry.authorityScope, isSourceDependent(entry))
  const refresh = record.refreshes.get(key)
  if (!refresh) return
  const target = refresh.targets.get(participant)
  if (target?.epochChanged) refresh.epochChangedTargetCount--
  refresh.targets.delete(participant)
  if (refresh.targets.size === 0) record.refreshes.delete(key)
}

function closeParticipant(
  record: BindingRecord,
  participant: ActiveAccessParticipant,
  entry: ParticipantRecord,
  code: 4401 | 4403,
  reason: string,
): void {
  if (record.participants.get(participant) !== entry) return
  const accepted = participant.close(code, reason)
  if (accepted === false) {
    // The relay's auth generation moved while this result was in flight. Keep
    // monitoring the still-live participant; a later source/epoch probe will
    // reconcile it against the authority that won.
    entry.generation++
    entry.refreshing = false
    entry.frozen = false
    entry.probePending = false
    detachActiveRefresh(record, participant, entry)
    return
  }
  entry.generation++
  entry.refreshing = false
  entry.frozen = true
  detachActiveRefresh(record, participant, entry)
  removeParticipantFromScope(record, participant, entry.authorityScope)
  record.participants.delete(participant)
  if (record.participants.size === 0) bindings.delete(record.key)
}

function stateForRegistration(
  record: BindingRecord,
  authorityScope: string,
  state: ActiveAccessState,
): ActiveAccessState {
  if (!state.sourceConfirmed || state.sourceRevision === null || state.proofExpiresAt === null) {
    return state
  }

  let proofExpiresAt = state.proofExpiresAt
  for (const entry of record.participants.values()) {
    const previous = entry.state
    if (entry.authorityScope !== authorityScope || !isSourceDependent(entry) ||
        !previous.sourceConfirmed || previous.permissionEpoch !== state.permissionEpoch ||
        previous.sourceRevision !== state.sourceRevision || previous.proofExpiresAt === null) continue
    proofExpiresAt = Math.min(proofExpiresAt, previous.proofExpiresAt)
  }
  return proofExpiresAt === state.proofExpiresAt ? state : { ...state, proofExpiresAt }
}


function retainPreviousProof(entry: ParticipantRecord, epochChanged: boolean, state: CurrentAccess | null): boolean {
  const old = entry.state
  const now = performance.now()
  if (epochChanged && state && state.permissionEpoch !== old.permissionEpoch && state.role === 'none') return false
  if (old.sourceRevision !== null && old.proofExpiresAt !== null && now >= old.proofExpiresAt) return false
  return true
}

function startParticipantRefresh(
  record: BindingRecord,
  participant: ActiveAccessParticipant,
  entry: ParticipantRecord,
  epochChanged = false,
): void {
  if (bindings.get(record.key) !== record || record.participants.get(participant) !== entry) return
  detachActiveRefresh(record, participant, entry)
  const generation = ++entry.generation
  entry.refreshing = true
  freezeParticipant(participant, entry)
  void resolveParticipantRefresh(record, participant, entry, generation, epochChanged)
}

async function resolveParticipantRefresh(
  record: BindingRecord,
  participant: ActiveAccessParticipant,
  entry: ParticipantRecord,
  generation: number,
  epochChanged: boolean,
): Promise<void> {
  let current: CurrentAccess | null = null
  try {
    current = await entry.resolve()
  } catch {
    current = null
  }

  if (bindings.get(record.key) !== record || record.participants.get(participant) !== entry ||
      entry.generation !== generation) return
  entry.refreshing = false

  if (!current) {
    if (entry.probePending) return
    if (entry.authorityScope === EXPIRED_SHARE_AUTHORITY_SCOPE ||
        epochChanged || !retainPreviousProof(entry, false, null)) {
      closeParticipant(record, participant, entry, 4401, 'Authorization could not be confirmed')
    } else {
      resumeParticipant(participant, entry, entry.state)
    }
    return
  }

  const permissionEpoch = current.permissionEpoch ?? entry.state.permissionEpoch
  if (permissionEpoch < record.permissionEpoch) {
    closeParticipant(record, participant, entry, 4401, 'Authorization could not be confirmed')
    return
  }
  if (permissionEpoch > record.permissionEpoch) {
    advanceEpoch(record, permissionEpoch, new Set([participant]))
  }

  if (current.role === 'none' && current.sourceConfirmed) {
    closeParticipant(record, participant, entry, 4403, 'Forbidden')
    return
  }
  if (!current.sourceConfirmed) {
    if (entry.probePending) return
    if (entry.authorityScope === EXPIRED_SHARE_AUTHORITY_SCOPE ||
        !retainPreviousProof(entry, epochChanged, current)) {
      closeParticipant(record, participant, entry, 4401, 'Authorization could not be confirmed')
    } else {
      resumeParticipant(participant, entry, entry.state)
    }
    return
  }

  if (current.sourceRevision !== null &&
      (current.proofExpiresAt === null || current.proofExpiresAt <= performance.now())) {
    closeParticipant(record, participant, entry, 4401, 'Authorization could not be confirmed')
    return
  }

  const state = { ...current, permissionEpoch }
  if (current.sourceRevision !== null) {
    if (!record.probing) record.sourceRevision = current.sourceRevision
    updateSourceRevisionWatermark(record, current.sourceRevision)
  }
  if (current.sourceRevision === null && entry.authorityScope === EXPIRED_SHARE_AUTHORITY_SCOPE) {
    moveParticipantScope(record, participant, entry, DIRECT_AUTHORITY_SCOPE)
  }
  if (entry.probePending) {
    entry.state = state
    entry.frozen = true
    return
  }
  resumeParticipant(participant, entry, state)
}

function joinActiveRefresh(
  record: BindingRecord,
  participant: ActiveAccessParticipant,
  entry: ParticipantRecord,
): boolean {
  const sourceDependent = isSourceDependent(entry)
  const refresh = record.refreshes.get(refreshKey(entry.authorityScope, sourceDependent))
  if (!refresh) return false
  if (refresh.permissionEpoch !== record.permissionEpoch ||
      refresh.sourceRevision !== entry.state.sourceRevision) return false
  // A current registration must not inherit a stale peer's epoch refresh.
  if (entry.state.permissionEpoch >= record.permissionEpoch &&
      refresh.epochChangedTargetCount > 0) return false
  if (refresh.targets.has(participant)) return true

  const generation = ++entry.generation
  entry.refreshing = true
  freezeParticipant(participant, entry)
  const targetEpochChanged = entry.state.permissionEpoch < refresh.permissionEpoch
  refresh.targets.set(participant, { generation, epochChanged: targetEpochChanged })
  if (targetEpochChanged) refresh.epochChangedTargetCount++
  return true
}

function startActiveRefresh(
  record: BindingRecord,
  authorityScope: string,
  sourceDependent: boolean,
  epochChanged = false,
  force = false,
  preferred?: ActiveAccessParticipant,
  targetEntries?: readonly RefreshParticipant[],
): void {
  if (bindings.get(record.key) !== record) return
  const candidates = targetEntries ?? [...(record.participantsByScope.get(authorityScope) ?? [])]
    .map(participant => [participant, record.participants.get(participant)!] as const)
    .filter(([, entry]) => isSourceDependent(entry) === sourceDependent)
    .map(([participant, entry]) => ({ participant, entry, epochChanged }))
  const uniqueCandidates = new Map<ActiveAccessParticipant, RefreshParticipant>()
  for (const target of candidates) {
    const previous = uniqueCandidates.get(target.participant)
    uniqueCandidates.set(target.participant, {
      ...target,
      epochChanged: target.epochChanged || previous?.epochChanged === true,
    })
  }
  let entries = [...uniqueCandidates.values()].filter(({ participant, entry }) =>
    record.participants.get(participant) === entry &&
    entry.authorityScope === authorityScope &&
    isSourceDependent(entry) === sourceDependent)
  if (entries.length === 0) return

  const key = refreshKey(authorityScope, sourceDependent)
  const existing = record.refreshes.get(key)
  if (existing && !force && existing.permissionEpoch === record.permissionEpoch) {
    const canJoin = entries.every(({ participant, entry }) =>
      existing.targets.has(participant) ||
      (entry.state.permissionEpoch === existing.permissionEpoch &&
       entry.state.sourceRevision === existing.sourceRevision))
    if (canJoin) {
      for (const { participant, entry } of entries) {
        if (existing.targets.has(participant)) continue
        const generation = ++entry.generation
        entry.refreshing = true
        freezeParticipant(participant, entry)
        const targetEpochChanged = entry.state.permissionEpoch < existing.permissionEpoch
        existing.targets.set(participant, { generation, epochChanged: targetEpochChanged })
        if (targetEpochChanged) existing.epochChangedTargetCount++
      }
      return
    }
  }

  const union = new Map<ActiveAccessParticipant, RefreshParticipant>()
  if (force && existing) {
    for (const [participant, target] of existing.targets) {
      const entry = record.participants.get(participant)
      if (!entry || entry.generation !== target.generation || !entry.refreshing ||
          entry.authorityScope !== authorityScope || isSourceDependent(entry) !== sourceDependent) continue
      union.set(participant, { participant, entry, epochChanged: target.epochChanged })
    }
  }
  for (const target of entries) {
    const prior = union.get(target.participant)
    union.set(target.participant, {
      ...target,
      epochChanged: target.epochChanged || prior?.epochChanged === true,
    })
  }
  entries = [...union.values()]

  const selected = preferred
    ? entries.find(({ participant }) => participant === preferred)
    : undefined
  // Without an explicit participant, use the latest registration's shared-scope resolver.
  const representative = selected ?? entries[entries.length - 1]!
  const refresh: ActiveRefresh = {
    sourceRevision: representative.entry.state.sourceRevision,
    permissionEpoch: record.permissionEpoch,
    epochChangedTargetCount: entries.filter(target => target.epochChanged).length,
    targets: new Map(),
  }
  record.refreshes.set(key, refresh)
  for (const { participant, entry, epochChanged: targetEpochChanged } of entries) {
    const generation = ++entry.generation
    entry.refreshing = true
    freezeParticipant(participant, entry)
    refresh.targets.set(participant, { generation, epochChanged: targetEpochChanged })
  }
  void resolveActiveRefresh(record, key, representative.entry.resolve, refresh)
}

function startSourceRefresh(
  record: BindingRecord,
  authorityScope: string,
  epochChanged = false,
  force = false,
  preferred?: ActiveAccessParticipant,
  targetEntries?: readonly RefreshParticipant[],
): void {
  startActiveRefresh(record, authorityScope, true, epochChanged, force, preferred, targetEntries)
}

function startIndependentRefresh(
  record: BindingRecord,
  authorityScope: string,
  epochChanged = false,
  force = false,
  preferred?: ActiveAccessParticipant,
  targetEntries?: readonly RefreshParticipant[],
): void {
  startActiveRefresh(record, authorityScope, false, epochChanged, force, preferred, targetEntries)
}

async function resolveActiveRefresh(
  record: BindingRecord,
  key: string,
  resolve: ActiveAccessResolver,
  refresh: ActiveRefresh,
): Promise<void> {
  let current: CurrentAccess | null = null
  try {
    current = await resolve()
  } catch {
    current = null
  }

  if (bindings.get(record.key) !== record || record.refreshes.get(key) !== refresh) return
  record.refreshes.delete(key)

  const targets = [...refresh.targets].filter(([participant, target]) => {
    const entry = record.participants.get(participant)
    return entry !== undefined && entry.generation === target.generation
  })
  if (targets.length === 0) return

  if (!current) {
    for (const [participant, target] of targets) {
      const entry = record.participants.get(participant)!
      entry.refreshing = false
      if (entry.probePending) continue
      if (entry.authorityScope === EXPIRED_SHARE_AUTHORITY_SCOPE ||
          target.epochChanged || !retainPreviousProof(entry, false, null)) {
        closeParticipant(record, participant, entry, 4401, 'Authorization could not be confirmed')
      } else {
        resumeParticipant(participant, entry, entry.state)
      }
    }
    return
  }

  const permissionEpoch = current.permissionEpoch ?? refresh.permissionEpoch
  if (permissionEpoch < record.permissionEpoch) {
    for (const [participant] of targets) {
      const entry = record.participants.get(participant)
      if (entry) closeParticipant(record, participant, entry, 4401, 'Authorization could not be confirmed')
    }
    return
  }
  if (permissionEpoch > record.permissionEpoch) {
    advanceEpoch(record, permissionEpoch, new Set(targets.map(([participant]) => participant)))
  }

  if (current.role === 'none' && current.sourceConfirmed) {
    for (const [participant] of targets) {
      const entry = record.participants.get(participant)
      if (entry) closeParticipant(record, participant, entry, 4403, 'Forbidden')
    }
    return
  }
  if (!current.sourceConfirmed) {
    for (const [participant, target] of targets) {
      const entry = record.participants.get(participant)
      if (!entry) continue
      entry.refreshing = false
      if (entry.probePending) continue
      if (entry.authorityScope === EXPIRED_SHARE_AUTHORITY_SCOPE ||
          !retainPreviousProof(entry, target.epochChanged, current)) {
        closeParticipant(record, participant, entry, 4401, 'Authorization could not be confirmed')
      } else {
        resumeParticipant(participant, entry, entry.state)
      }
    }
    return
  }
  if (current.sourceRevision !== null &&
      (current.proofExpiresAt === null || current.proofExpiresAt <= performance.now())) {
    for (const [participant] of targets) {
      const entry = record.participants.get(participant)
      if (entry) closeParticipant(record, participant, entry, 4401, 'Authorization could not be confirmed')
    }
    return
  }

  const state = { ...current, permissionEpoch }
  if (current.sourceRevision !== null) {
    if (!record.probing) record.sourceRevision = current.sourceRevision
    updateSourceRevisionWatermark(record, current.sourceRevision)
  }
  for (const [participant] of targets) {
    const entry = record.participants.get(participant)
    if (!entry) continue
    if (current.sourceRevision === null && entry.authorityScope === EXPIRED_SHARE_AUTHORITY_SCOPE) {
      moveParticipantScope(record, participant, entry, DIRECT_AUTHORITY_SCOPE)
    }
    if (entry.probePending) {
      entry.state = state
      entry.refreshing = false
      entry.frozen = true
      continue
    }
    resumeParticipant(participant, entry, state)
  }
}

interface RefreshGroup {
  authorityScope: string
  sourceDependent: boolean
  targets: RefreshParticipant[]
}

function groupParticipantTargets(
  record: BindingRecord,
  include: (participant: ActiveAccessParticipant, entry: ParticipantRecord) => boolean,
): RefreshGroup[] {
  const groups = new Map<string, RefreshGroup>()
  for (const [participant, entry] of record.participants) {
    if (!include(participant, entry)) continue
    const sourceDependent = isSourceDependent(entry)
    const key = refreshKey(entry.authorityScope, sourceDependent)
    let group = groups.get(key)
    if (!group) {
      group = { authorityScope: entry.authorityScope, sourceDependent, targets: [] }
      groups.set(key, group)
    }
    group.targets.push({ participant, entry, epochChanged: false })
  }
  return [...groups.values()]
}

function epochRefreshGroups(
  record: BindingRecord,
  permissionEpoch: number,
  excluded: ReadonlySet<ActiveAccessParticipant> = new Set(),
): RefreshGroup[] {
  if (permissionEpoch <= record.permissionEpoch) return []
  record.permissionEpoch = permissionEpoch
  return groupParticipantTargets(record, (participant, entry) =>
    !excluded.has(participant) && entry.state.permissionEpoch < permissionEpoch)
    .map(group => ({
      ...group,
      targets: group.targets.map(target => ({ ...target, epochChanged: true })),
    }))
}

function advanceEpoch(
  record: BindingRecord,
  permissionEpoch: number,
  excluded: ReadonlySet<ActiveAccessParticipant> = new Set(),
): void {
  const groups = epochRefreshGroups(record, permissionEpoch, excluded)
  if (record.probing) {
    // The current poll owns the combined epoch/source decision. Hold every
    // source-dependent participant frozen so an in-flight recheck cannot
    // reopen it before the source-version result arrives.
    for (const [participant, entry] of record.participants) {
      if (!isSourceDependent(entry)) continue
      entry.probePending = true
      freezeParticipant(participant, entry)
    }
    for (const group of groups) {
      if (group.sourceDependent) continue
      startActiveRefresh(
        record, group.authorityScope, false, true, true, undefined, group.targets,
      )
    }
    return
  }
  for (const group of groups) {
    startActiveRefresh(
      record, group.authorityScope, group.sourceDependent, true, true, undefined, group.targets,
    )
  }
}

function resumeInitialRegistration(
  record: BindingRecord,
  participant: ActiveAccessParticipant,
  entry: ParticipantRecord,
  state: ActiveAccessState,
  invalidated: boolean,
): void {
  if (invalidated) {
    entry.state = state
    const target: RefreshParticipant[] = [{ participant, entry, epochChanged: false }]
    if (isSourceDependent(entry)) {
      if (!joinActiveRefresh(record, participant, entry)) {
        startSourceRefresh(record, entry.authorityScope, false, true, participant, target)
      }
    } else if (!joinActiveRefresh(record, participant, entry)) {
      startIndependentRefresh(record, entry.authorityScope, false, true, participant, target)
    }
    return
  }

  if (state.sourceRevision !== null) {
    if (joinActiveRefresh(record, participant, entry)) return
    resumeParticipant(participant, entry, state)
    return
  }

  resumeParticipant(participant, entry, state)
}

export function registerActiveAccess(
  binding: ActiveAccessBinding,
  permissionEpoch: number,
  initial: CurrentAccess,
  resolve: ActiveAccessResolver,
  participant: ActiveAccessParticipant,
  registration: ActiveAccessRegistrationLease,
): () => void {
  const authorityScope = registration.authorityScope
  const key = bindingKey(binding)
  const state: ActiveAccessState = { ...initial, permissionEpoch }
  let record = bindings.get(key)
  const sourceRevisionWatermark = registration.sourceRevisionWatermark
  const sourceProofBehindWatermark = state.sourceRevision !== null &&
    sourceRevisionWatermark !== undefined && state.sourceRevision !== sourceRevisionWatermark &&
    (registration.sourceRevisionInvalidated || !record || record.sourceRevision === state.sourceRevision)
  if (sourceProofBehindWatermark) registration.invalidated = true
  const invalidated = registration.invalidated
  registration.release()
  let entry: ParticipantRecord
  if (!record) {
    entry = {
      state,
      resolve,
      authorityScope,
      generation: 0,
      frozen: false,
      refreshing: false,
      probePending: false,
    }
    record = {
      key,
      binding,
      permissionEpoch,
      sourceRevision: sourceRevisionWatermark ?? state.sourceRevision ?? undefined,
      observedSourceRevision: sourceRevisionWatermark ?? state.sourceRevision ?? undefined,
      participants: new Map([[participant, entry]]),
      participantsByScope: new Map([[authorityScope, new Set([participant])]]),
      refreshes: new Map(),
      probing: false,
    }
    bindings.set(key, record)
    resumeInitialRegistration(record, participant, entry, state, invalidated)
  } else {
    record.binding = binding
    if (record.sourceRevision === undefined && state.sourceRevision !== null) {
      record.sourceRevision = sourceRevisionWatermark ?? state.sourceRevision
    }
    if (record.observedSourceRevision === undefined) {
      record.observedSourceRevision = sourceRevisionWatermark ?? state.sourceRevision ?? undefined
    }
    const current = record.participants.get(participant)
    const isNew = current === undefined
    if (!current) {
      entry = {
        state,
        resolve,
        authorityScope,
        generation: 0,
        frozen: false,
        refreshing: false,
        probePending: false,
      }
      record.participants.set(participant, entry)
      addParticipantToScope(record, participant, authorityScope)
    } else {
      entry = current
      detachActiveRefresh(record, participant, entry)
      entry.generation++
      entry.refreshing = false
      entry.frozen = false
      entry.probePending = false
      entry.resolve = resolve
      if (entry.authorityScope !== authorityScope) {
        removeParticipantFromScope(record, participant, entry.authorityScope)
        entry.authorityScope = authorityScope
        addParticipantToScope(record, participant, authorityScope)
      }
    }

    if (permissionEpoch < record.permissionEpoch) {
      if (isNew) entry.state = state
      entry.refreshing = false
      freezeParticipant(participant, entry)
      startParticipantRefresh(record, participant, entry, true)
    } else {
      const advancingEpoch = permissionEpoch > record.permissionEpoch
      const accepted = advancingEpoch ? state : stateForRegistration(record, authorityScope, state)
      entry.state = accepted
      const sourceRevisionMismatch = accepted.sourceRevision !== null && (
        (record.sourceRevision !== undefined && accepted.sourceRevision !== record.sourceRevision) ||
        (record.observedSourceRevision !== undefined &&
          accepted.sourceRevision !== record.observedSourceRevision)
      )
      if (sourceRevisionMismatch) {
        invalidateDriveDerivedAccess(record.binding.docId, record.binding.uid, record.binding.principalSpaceId)
        if (!record.probing && !invalidated && accepted.sourceRevision !== null) {
          record.sourceRevision = accepted.sourceRevision
          updateSourceRevisionWatermark(record, accepted.sourceRevision)
          if (!advancingEpoch) {
            const staleScopes = groupParticipantTargets(record, (candidate, candidateEntry) =>
              candidate !== participant && isSourceDependent(candidateEntry) &&
              candidateEntry.state.sourceRevision !== accepted.sourceRevision)
            for (const group of staleScopes) {
              startSourceRefresh(record, group.authorityScope, false, true, undefined, group.targets)
            }
          }
        }
      }
      if (advancingEpoch) advanceEpoch(record, permissionEpoch, new Set([participant]))
      const scopeRefresh = record.refreshes.get(refreshKey(entry.authorityScope, isSourceDependent(entry)))
      if (record.probing && isSourceDependent(entry)) {
        entry.probePending = true
        freezeParticipant(participant, entry)
      } else if (sourceRevisionMismatch && advancingEpoch) {
        startSourceRefresh(record, entry.authorityScope, true, true, participant,
          [{ participant, entry, epochChanged: true }])
      } else if (sourceRevisionMismatch && invalidated) {
        startSourceRefresh(record, entry.authorityScope, advancingEpoch, true, participant,
          [{ participant, entry, epochChanged: advancingEpoch }])
      } else if (!invalidated && accepted.permissionEpoch === record.permissionEpoch &&
          scopeRefresh?.epochChangedTargetCount) {
        resumeParticipant(participant, entry, accepted)
      } else if (!isNew && scopeRefresh && !sourceRevisionMismatch) {
        if (isSourceDependent(entry)) {
          startSourceRefresh(record, entry.authorityScope, advancingEpoch, true, participant,
            [{ participant, entry, epochChanged: advancingEpoch }])
        } else {
          startIndependentRefresh(record, entry.authorityScope, advancingEpoch, true, participant,
            [{ participant, entry, epochChanged: advancingEpoch }])
        }
      } else {
        resumeInitialRegistration(record, participant, entry, accepted, invalidated)
      }
    }
  }

  if (record.probing && isSourceDependent(entry)) {
    entry.probePending = true
    freezeParticipant(participant, entry)
  }

  const registeredRecord = record
  return () => {
    const current = bindings.get(key)
    if (current !== registeredRecord) return
    const currentEntry = current.participants.get(participant)
    if (!currentEntry) return
    currentEntry.generation++
    detachActiveRefresh(current, participant, currentEntry)
    removeParticipantFromScope(current, participant, currentEntry.authorityScope)
    current.participants.delete(participant)
    if (current.participants.size === 0) bindings.delete(key)
  }
}

/** Revalidate source-dependent participants while preserving independent grants. */
export function invalidateActiveAccess(
  docId: string,
  principalSpaceId: string,
  uid?: string,
): void {
  for (const pending of pendingRegistrations) {
    if (pending.binding.docId !== docId || pending.binding.principalSpaceId !== principalSpaceId) continue
    if (uid !== undefined && pending.binding.uid !== uid) continue
    pending.invalidated = true
  }
  for (const record of bindings.values()) {
    if (record.binding.docId !== docId || record.binding.principalSpaceId !== principalSpaceId) continue
    if (uid !== undefined && record.binding.uid !== uid) continue
    const groups = groupParticipantTargets(record, (_participant, entry) => isSourceDependent(entry))
    for (const group of groups) {
      if (group.sourceDependent) {
        startSourceRefresh(record, group.authorityScope, false, true, undefined, group.targets)
      }
    }
  }
}

/** Keep the binding on direct-authority invalidations while a share ticket expires. */
export function prepareActiveAccessShareExpiry(
  binding: DerivedAccessBinding,
  participant: ActiveAccessParticipant,
): void {
  const record = bindings.get(bindingKey(binding))
  const entry = record?.participants.get(participant)
  if (!record || !entry) return
  detachActiveRefresh(record, participant, entry)
  entry.generation++
  entry.refreshing = false
  entry.frozen = false
  entry.probePending = false
  moveParticipantScope(record, participant, entry, EXPIRED_SHARE_AUTHORITY_SCOPE)
}

/** Freeze the expired participant while its own authority scope is revalidated. */
export function renewActiveAccess(
  binding: DerivedAccessBinding,
  participant: ActiveAccessParticipant,
): boolean {
  const record = bindings.get(bindingKey(binding))
  const entry = record?.participants.get(participant)
  if (!record || !entry || entry.state.sourceRevision === null) return false
  if (entry.refreshing) return true
  // A pending version/epoch probe cannot authorize an expired proof. Preserve
  // fail-closed delivery rather than start a competing read behind a blocked poll.
  if (record.probing) return false
  invalidateDriveDerivedAccess(binding.docId, binding.uid, binding.principalSpaceId)
  const targets = [...(record.participantsByScope.get(entry.authorityScope) ?? [])]
    .map(candidate => [candidate, record.participants.get(candidate)!] as const)
    .filter(([, candidate]) => isSourceDependent(candidate))
    .map(([candidate, candidateEntry]) => ({
      participant: candidate,
      entry: candidateEntry,
      epochChanged: false,
    }))
  startSourceRefresh(record, entry.authorityScope, false, true, participant, targets)
  return true
}

function mapVersions(
  batch: readonly DerivedAccessBinding[],
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
  const snapshot = [...bindings.values()].map(record => ({
    record,
    participants: [...record.participants.entries()]
      .filter(([, entry]) => !entry.refreshing)
      .map(([participant, entry]) => ({ participant, entry, generation: entry.generation })),
  })).filter(item => item.participants.length > 0)
  for (const { record } of snapshot) record.probing = true
  try {
    if (snapshot.length === 0) return

    const documentIds = [...new Set(snapshot.map(({ record }) => record.binding.docId))]
    const derivedBindings = snapshot.filter(({ participants }) =>
      participants.some(({ entry }) => isSourceDependent(entry)))
      .map(({ record }) => ({
        docId: record.binding.docId,
        uid: record.binding.uid,
        principalSpaceId: record.binding.principalSpaceId,
      }))
    const versionBatches: DerivedAccessBinding[][] = []
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

    for (const { record, participants: initialParticipants } of snapshot) {
      if (bindings.get(record.key) !== record) continue
      const epoch = epochResult.ok ? epochs.get(record.binding.docId) : undefined
      const version = versions.get(bindingKey(record.binding))
      const priorSourceRevision = record.observedSourceRevision ?? record.sourceRevision
      const sourceVersionChanged = version !== undefined &&
        priorSourceRevision !== undefined && priorSourceRevision !== version.sourceRevision
      if (version !== undefined) updateSourceRevisionWatermark(record, version.sourceRevision)
      const sourceGroups = new Map<string, RefreshGroup>()
      const independentGroups = new Map<string, RefreshGroup>()
      let sourceProofChanged = sourceVersionChanged
      const candidates = new Map<ActiveAccessParticipant, {
        participant: ActiveAccessParticipant
        entry: ParticipantRecord
        generation: number
      }>()
      for (const target of initialParticipants) candidates.set(target.participant, target)
      for (const [participant, entry] of record.participants) {
        const sourceVersionStale = version !== undefined &&
          isSourceDependent(entry) && entry.state.sourceRevision !== version.sourceRevision
        if (entry.probePending || sourceVersionStale) {
          candidates.set(participant, { participant, entry, generation: entry.generation })
        }
      }

      const addTarget = (
        groups: Map<string, RefreshGroup>,
        participant: ActiveAccessParticipant,
        entry: ParticipantRecord,
        changedEpoch: boolean,
      ) => {
        const sourceDependent = isSourceDependent(entry)
        const key = refreshKey(entry.authorityScope, sourceDependent)
        let group = groups.get(key)
        if (!group) {
          group = { authorityScope: entry.authorityScope, sourceDependent, targets: [] }
          groups.set(key, group)
        }
        group.targets.push({ participant, entry, epochChanged: changedEpoch })
        entry.probePending = false
      }

      for (const { participant, entry, generation } of candidates.values()) {
        const probePending = entry.probePending
        const sourceChanged = isSourceDependent(entry) && (
          (version !== undefined && version.sourceRevision !== entry.state.sourceRevision) ||
          (record.sourceRevision !== undefined && record.sourceRevision !== entry.state.sourceRevision)
        )
        if (record.participants.get(participant) !== entry ||
            (!probePending && !sourceChanged && entry.generation !== generation) ||
            (entry.refreshing && !probePending && !sourceChanged)) continue
        const epochChanged = record.permissionEpoch > entry.state.permissionEpoch ||
          (epochResult.ok && (epoch === undefined || epoch !== entry.state.permissionEpoch))
        const hasSource = entry.state.sourceRevision !== null
        const proofDue = hasSource && entry.state.proofExpiresAt !== null &&
          now + REVALIDATION_INTERVAL_MS >= entry.state.proofExpiresAt
        if (sourceChanged || proofDue ||
            (probePending && isSourceDependent(entry) && version === undefined && !epochChanged)) {
          sourceProofChanged = true
        }
        if (epochChanged) {
          if (isSourceDependent(entry) && version === undefined) sourceProofChanged = true
          addTarget(isSourceDependent(entry) ? sourceGroups : independentGroups,
            participant, entry, true)
        } else if (sourceChanged || proofDue) {
          addTarget(sourceGroups, participant, entry, false)
        } else if (probePending && isSourceDependent(entry) && version === undefined) {
          addTarget(sourceGroups, participant, entry, false)
        } else if (probePending) {
          entry.probePending = false
          if (!entry.refreshing) resumeParticipant(participant, entry, entry.state)
        }
      }
      if (sourceProofChanged) {
        invalidateDriveDerivedAccess(record.binding.docId, record.binding.uid, record.binding.principalSpaceId)
      }
      const epochGroups = epochResult.ok && epoch !== undefined && epoch > record.permissionEpoch
        ? epochRefreshGroups(record, epoch)
        : []
      for (const group of epochGroups) {
        const groups = group.sourceDependent ? sourceGroups : independentGroups
        const key = refreshKey(group.authorityScope, group.sourceDependent)
        const existing = groups.get(key)
        if (existing) existing.targets.push(...group.targets)
        else groups.set(key, group)
      }
      for (const group of sourceGroups.values()) {
        startSourceRefresh(record, group.authorityScope,
          group.targets.some(target => target.epochChanged), true, undefined, group.targets)
      }
      for (const group of independentGroups.values()) {
        startIndependentRefresh(record, group.authorityScope,
          group.targets.some(target => target.epochChanged), true, undefined, group.targets)
      }
    }
  } finally {
    for (const { record } of snapshot) record.probing = false
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
