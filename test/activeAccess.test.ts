import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  beginActiveAccessRegistration,
  invalidateActiveAccess,
  pollActiveAccess,
  registerActiveAccess,
  renewActiveAccess,
  type ActiveAccessParticipant,
} from '../src/permission/activeAccess.js'
import * as derivedAccessClient from '../src/drive/derivedAccessClient.js'
import { getDriveDerivedAccess, setDriveDerivedAccess, type DriveDerivedAccess } from '../src/drive/derivedAccessClient.js'
import type { CurrentAccess } from '../src/permission/resolveRole.js'

const activeAccessMocks = vi.hoisted(() => ({
  getEpochsByDocIds: vi.fn(async (_docIds: readonly string[]) => [{
    doc_id: 'd1',
    document_name: 'octo:s1:f1:doc:d1',
    permission_epoch: 7,
    status: 1,
  }]),
}))

vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getEpochsByDocIds: activeAccessMocks.getEpochsByDocIds },
}))

const originalDriveAccess = getDriveDerivedAccess()
const fakeDriveAccess: DriveDerivedAccess = {
  derivedAccess: async () => null,
  versions: async () => null,
}
const disposers: Array<() => void> = []

function access(
  role: CurrentAccess['role'],
  sourceRevision: string | null = null,
  proofExpiresAt: number | null = null,
  sourceConfirmed = true,
): CurrentAccess {
  return { role, permissionEpoch: 7, sourceRevision, proofExpiresAt, sourceConfirmed }
}

type ParticipantSpies = { freeze: Mock; resume: Mock; close: Mock }

type DeliveryParticipant = ActiveAccessParticipant & {
  readonly received: string[]
  readonly frozen: boolean
  readonly closure: { code: 4401 | 4403; reason: string } | null
  receiveBroadcast(message: string): void
}

function deliveryParticipant(): DeliveryParticipant {
  const received: string[] = []
  let frozen = false
  let closure: DeliveryParticipant['closure'] = null
  return {
    received,
    get frozen() { return frozen },
    get closure() { return closure },
    receiveBroadcast(message) {
      if (!frozen && !closure) received.push(message)
    },
    freeze() { frozen = true },
    resume(state) {
      if (closure || state.role === 'none') return
      frozen = false
    },
    close(code, reason) {
      frozen = true
      closure = { code, reason }
    },
  }
}

function broadcastTo(participants: readonly DeliveryParticipant[], message: string): void {
  for (const participant of participants) participant.receiveBroadcast(message)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function bindPrincipal(
  uid: string,
  principalSpaceId: string,
  initial: CurrentAccess,
  resolve: () => Promise<CurrentAccess>,
  sink: ActiveAccessParticipant,
  authorityScope = 'shared-test-authority',
): void {
  const binding = {
    docId: 'd1', uid, principalSpaceId,
    documentName: `octo:${principalSpaceId}:f1:doc:d1`,
  }
  const registration = beginActiveAccessRegistration(binding, authorityScope)
  disposers.push(registerActiveAccess(binding, initial.permissionEpoch ?? 7, initial, resolve, sink, registration))
}

function participant(): ActiveAccessParticipant & ParticipantSpies {
  return { freeze: vi.fn(), resume: vi.fn(), close: vi.fn() }
}

function bind(
  uid: string,
  initial: CurrentAccess,
  resolve: () => Promise<CurrentAccess>,
  sink: ActiveAccessParticipant,
): void {
  const binding = {
    docId: 'd1', uid, principalSpaceId: 's1', documentName: 'octo:s1:f1:doc:d1',
  }
  const registration = beginActiveAccessRegistration(binding, `connection:${uid}`)
  disposers.push(registerActiveAccess(binding, initial.permissionEpoch ?? 7, initial, resolve, sink, registration))
}

beforeEach(() => {
  activeAccessMocks.getEpochsByDocIds.mockClear()
  setDriveDerivedAccess(fakeDriveAccess)
})

afterEach(() => {
  while (disposers.length) disposers.pop()!()
  setDriveDerivedAccess(originalDriveAccess)
})

describe('active derived-access bindings', () => {
  it('keeps notice-frozen participants blocked when a same-binding tab joins before a confirmed revocation', async () => {
    const proof = access('reader', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', performance.now() + 60_000)
    const pending = deferred<CurrentAccess>()
    const tabA = deliveryParticipant()
    const tabB = deliveryParticipant()
    bindPrincipal('u_shared', 's1', proof, () => pending.promise, tabA)

    invalidateActiveAccess('d1', 's1', 'u_shared')
    expect(tabA.frozen).toBe(true)
    broadcastTo([tabA], 'during notice revalidation')
    expect(tabA.received).toEqual([])

    bindPrincipal('u_shared', 's1', proof, async () => proof, tabB)
    broadcastTo([tabA, tabB], 'after late tab registration')
    expect(tabA.received).toEqual([])
    expect(tabB.received).toEqual([])

    pending.resolve(access('none'))
    await vi.waitFor(() => {
      expect(tabA.closure).toEqual({ code: 4403, reason: 'Forbidden' })
      expect(tabB.closure).toEqual({ code: 4403, reason: 'Forbidden' })
    })
    broadcastTo([tabA, tabB], 'after confirmed revocation')
    expect(tabA.received).toEqual([])
    expect(tabB.received).toEqual([])
  })

  it('shares one valid source recheck across ordinary same-binding tabs without freezing other UIDs or Spaces', async () => {
    const proof = access('reader', 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', performance.now() + 60_000)
    const pending = deferred<CurrentAccess>()
    let sharedChecks = 0
    const resolveShared = () => {
      sharedChecks++
      return pending.promise
    }
    const tabA = deliveryParticipant()
    const tabB = deliveryParticipant()
    const otherUid = deliveryParticipant()
    const otherSpace = deliveryParticipant()
    bindPrincipal('u_shared', 's1', proof, resolveShared, tabA)
    bindPrincipal('u_shared', 's1', proof, resolveShared, tabB)
    bindPrincipal('u_other', 's1', proof, async () => proof, otherUid)
    bindPrincipal('u_shared', 's2', proof, async () => proof, otherSpace)
    const participants = [tabA, tabB, otherUid, otherSpace]

    broadcastTo(participants, 'initial reader broadcast')
    expect(participants.map(({ received }) => received)).toEqual([
      ['initial reader broadcast'],
      ['initial reader broadcast'],
      ['initial reader broadcast'],
      ['initial reader broadcast'],
    ])

    invalidateActiveAccess('d1', 's1', 'u_shared')
    expect(sharedChecks).toBe(1)
    expect(tabA.frozen).toBe(true)
    expect(tabB.frozen).toBe(true)
    expect(otherUid.frozen).toBe(false)
    expect(otherSpace.frozen).toBe(false)
    broadcastTo(participants, 'while the matching principal is rechecked')
    expect(participants.map(({ received }) => received)).toEqual([
      ['initial reader broadcast'],
      ['initial reader broadcast'],
      ['initial reader broadcast', 'while the matching principal is rechecked'],
      ['initial reader broadcast', 'while the matching principal is rechecked'],
    ])

    pending.resolve(access('reader', proof.sourceRevision, performance.now() + 60_000))
    await vi.waitFor(() => {
      expect(tabA.frozen).toBe(false)
      expect(tabB.frozen).toBe(false)
    })
    broadcastTo(participants, 'reader broadcast after valid recheck')
    expect(participants.map(({ received }) => received)).toEqual([
      ['initial reader broadcast', 'reader broadcast after valid recheck'],
      ['initial reader broadcast', 'reader broadcast after valid recheck'],
      ['initial reader broadcast', 'while the matching principal is rechecked', 'reader broadcast after valid recheck'],
      ['initial reader broadcast', 'while the matching principal is rechecked', 'reader broadcast after valid recheck'],
    ])
  })

  it('keeps an independent writer active when the authoritative epoch query fails', async () => {
    activeAccessMocks.getEpochsByDocIds.mockRejectedValue(new Error('database unavailable'))
    const resolve = vi.fn(async () => { throw new Error('unexpected role refresh') })
    const sink = participant()
    bind('u_writer', access('writer'), resolve, sink)

    await pollActiveAccess()

    expect(resolve).not.toHaveBeenCalled()
    expect(sink.freeze).not.toHaveBeenCalled()
    expect(sink.close).not.toHaveBeenCalled()
  })

  it('revalidates only the matching active principal on a source notice without querying Docs epochs', async () => {
    const revoked = vi.fn(async () => access('none'))
    const unaffected = vi.fn(async () => access('reader', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', performance.now() + 10_000))
    const selected = participant()
    const other = participant()
    bind('u_selected', access('reader', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', performance.now() + 10_000), revoked, selected)
    bind('u_other', access('reader', 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', performance.now() + 10_000), unaffected, other)

    invalidateActiveAccess('d1', 's1', 'u_selected')

    expect(selected.freeze).toHaveBeenCalledTimes(1)
    expect(other.freeze).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(selected.close).toHaveBeenCalledWith(4403, 'Forbidden'))
    expect(unaffected).not.toHaveBeenCalled()
    expect(activeAccessMocks.getEpochsByDocIds).not.toHaveBeenCalled()
  })

  it('keeps each participant’s authority separate when a Drive reader and independent writer share a binding', async () => {
    const proof = access('reader', `sha256:${'c'.repeat(64)}`, performance.now() + 60_000)
    const pending = deferred<CurrentAccess>()
    const driveReader = deliveryParticipant()
    bindPrincipal('u_shared', 's1', proof, () => pending.promise, driveReader)
    invalidateActiveAccess('d1', 's1', 'u_shared')
    expect(driveReader.frozen).toBe(true)

    const independentWriter = deliveryParticipant()
    bindPrincipal('u_shared', 's1', access('writer'), async () => access('writer'), independentWriter)

    pending.resolve(access('none'))
    await vi.waitFor(() => expect(driveReader.closure).toEqual({
      code: 4403, reason: 'Forbidden',
    }))
    expect(independentWriter.frozen).toBe(false)
    expect(independentWriter.closure).toBeNull()

    broadcastTo([driveReader, independentWriter], 'after the Drive reader is revoked')
    expect(driveReader.received).toEqual([])
    expect(independentWriter.received).toEqual(['after the Drive reader is revoked'])
  })

  it('does not mix source rechecks across connection-specific share proof expiries', async () => {
    const proof = access('reader', `sha256:${'b'.repeat(64)}`, performance.now() + 60_000)
    const expiringShare = deliveryParticipant()
    const refreshedShare = deliveryParticipant()
    bindPrincipal('u_scoped_share', 's1', proof, async () => access('none'), expiringShare, 'share:100')
    bindPrincipal('u_scoped_share', 's1', proof, async () => access('writer'), refreshedShare, 'share:200')

    invalidateActiveAccess('d1', 's1', 'u_scoped_share')
    await vi.waitFor(() => expect(expiringShare.closure?.code).toBe(4403))
    expect(refreshedShare.frozen).toBe(false)
    expect(refreshedShare.closure).toBeNull()

    broadcastTo([expiringShare, refreshedShare], 'after one share proof expires')
    expect(expiringShare.received).toEqual([])
    expect(refreshedShare.received).toEqual(['after one share proof expires'])
  })

  it('does not let an older source recheck override a refreshed connection registration', async () => {
    const revision = `sha256:${'e'.repeat(64)}`
    const proof = access('reader', revision, performance.now() + 60_000)
    const staleRecheck = deferred<CurrentAccess>()
    const renewed = access('reader', revision, performance.now() + 60_000)
    const refreshedResolver = vi.fn(async () => renewed)
    const tabA = participant()
    const tabB = participant()
    const authorityScope = 'same-ticket'
    bindPrincipal('u_registration_race', 's1', proof, () => staleRecheck.promise, tabA, authorityScope)
    invalidateActiveAccess('d1', 's1', 'u_registration_race')
    bindPrincipal('u_registration_race', 's1', proof, async () => proof, tabB, authorityScope)

    bindPrincipal('u_registration_race', 's1', renewed, refreshedResolver, tabA, authorityScope)
    await vi.waitFor(() => {
      expect(refreshedResolver).toHaveBeenCalledTimes(1)
      expect(tabA.resume).toHaveBeenCalledTimes(2)
      expect(tabB.resume).toHaveBeenCalledTimes(1)
    })
    expect(tabA.freeze).toHaveBeenCalledTimes(2)

    staleRecheck.resolve(access('writer'))
    await staleRecheck.promise
    expect(tabA.resume).toHaveBeenLastCalledWith(expect.objectContaining({
      role: 'reader', sourceRevision: revision,
    }))
    expect(tabB.resume).toHaveBeenLastCalledWith(expect.objectContaining({
      role: 'reader', sourceRevision: revision,
    }))
  })

  it('does not let a late lower-epoch registration replace the reader source used by the batch probe', async () => {
    const revision = `sha256:${'f'.repeat(64)}`
    const versions = vi.fn(async (batch: readonly { docId: string; uid: string; principalSpaceId: string }[]) =>
      batch.map(binding => ({
        ...binding,
        sourceRevision: revision,
        validForMs: 60_000,
        expiresAt: performance.now() + 60_000,
      })))
    setDriveDerivedAccess({ derivedAccess: async () => null, versions })

    const readerState = { ...access('reader', revision, performance.now() + 60_000), permissionEpoch: 7 }
    const reader = deliveryParticipant()
    bindPrincipal('u_late_epoch', 's1', readerState, async () => readerState, reader)

    const staleWriterState = { ...access('writer'), permissionEpoch: 6 }
    const staleWriter = deliveryParticipant()
    bindPrincipal('u_late_epoch', 's1', staleWriterState, async () => staleWriterState, staleWriter)
    await vi.waitFor(() => expect(staleWriter.closure?.code).toBe(4401))

    await pollActiveAccess()
    expect(versions).toHaveBeenCalledTimes(1)
    expect(versions.mock.calls[0]?.[0]).toEqual([{
      docId: 'd1', uid: 'u_late_epoch', principalSpaceId: 's1',
    }])
    expect(reader.frozen).toBe(false)
    expect(reader.closure).toBeNull()
  })

  it('does not keep an older Drive proof alive across a same-epoch independent registration', async () => {
    let now = 10_000
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const renewal = deferred<CurrentAccess>()
    try {
      const oldProof = access('reader', `sha256:${'d'.repeat(64)}`, 11_000)
      const pending = deferred<CurrentAccess>()
      const oldReader = deliveryParticipant()
      bindPrincipal('u_shared', 's1', oldProof, () => pending.promise, oldReader)
      invalidateActiveAccess('d1', 's1', 'u_shared')
      expect(oldReader.frozen).toBe(true)

      const independentWriter = deliveryParticipant()
      bindPrincipal('u_shared', 's1', access('writer'), () => renewal.promise, independentWriter)

      pending.resolve(access('reader', oldProof.sourceRevision, 11_000))
      await vi.waitFor(() => expect(independentWriter.frozen).toBe(false))

      now = 12_000
      await pollActiveAccess()
      broadcastTo([oldReader, independentWriter], 'after the old Drive proof deadline')
      expect(independentWriter.received).toEqual(['after the old Drive proof deadline'])
      expect(independentWriter.frozen).toBe(false)
      expect(independentWriter.closure).toBeNull()
    } finally {
      renewal.resolve(access('writer'))
      clock.mockRestore()
    }
  })

  it('does not extend a Drive proof deadline from a same-epoch same-source registration', async () => {
    let now = 10_000
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const renewal = deferred<CurrentAccess>()
    try {
      const revision = `sha256:${'e'.repeat(64)}`
      const oldProof = access('reader', revision, 11_000)
      const oldReader = deliveryParticipant()
      bindPrincipal('u_same_source', 's1', oldProof,
        async () => access('reader', revision, 22_000), oldReader)
      const newReader = deliveryParticipant()
      bindPrincipal('u_same_source', 's1', access('reader', revision, 20_000),
        () => renewal.promise, newReader)

      now = 12_000
      await pollActiveAccess()
      expect(newReader.frozen).toBe(true)
      broadcastTo([oldReader, newReader], 'before the shared proof renewal')
      expect(newReader.received).toEqual([])

      renewal.resolve(access('reader', revision, 22_000))
      await vi.waitFor(() => expect(newReader.frozen).toBe(false))
      broadcastTo([oldReader, newReader], 'after the shared proof renewal')
      expect(newReader.received).toEqual(['after the shared proof renewal'])
    } finally {
      renewal.resolve(access('reader', `sha256:${'e'.repeat(64)}`, 22_000))
      clock.mockRestore()
    }
  })

  it('renews an expired participant in its own scope during another scope refresh', async () => {
    const binding = { docId: 'd1', uid: 'u_scope_refresh', principalSpaceId: 's1' }
    const revisionA = `sha256:${'1'.repeat(64)}`
    const revisionB = `sha256:${'2'.repeat(64)}`
    const pendingA = deferred<CurrentAccess>()
    const pendingB = deferred<CurrentAccess>()
    const checkA = vi.fn(() => pendingA.promise)
    const checkB = vi.fn(() => pendingB.promise)
    const participantA = deliveryParticipant()
    const participantB = deliveryParticipant()
    bindPrincipal(binding.uid, 's1', access('reader', revisionA, performance.now() + 60_000),
      checkA, participantA, 'share:one')
    bindPrincipal(binding.uid, 's1', access('reader', revisionB, performance.now() + 60_000),
      checkB, participantB, 'share:two')

    expect(renewActiveAccess(binding, participantA)).toBe(true)
    expect(participantA.frozen).toBe(true)
    expect(participantB.frozen).toBe(false)
    expect(renewActiveAccess(binding, participantB)).toBe(true)
    expect(participantB.frozen).toBe(true)
    expect(checkA).toHaveBeenCalledTimes(1)
    expect(checkB).toHaveBeenCalledTimes(1)

    pendingB.resolve(access('none'))
    await vi.waitFor(() => expect(participantB.closure?.code).toBe(4403))
    pendingA.resolve(access('reader', revisionA, performance.now() + 60_000))
    await vi.waitFor(() => expect(participantA.frozen).toBe(false))
  })

  it('probes unaffected authority scopes while one scope recheck is pending', async () => {
    activeAccessMocks.getEpochsByDocIds.mockResolvedValueOnce([{
      doc_id: 'd1',
      document_name: 'octo:s1:f1:doc:d1',
      permission_epoch: 8,
      status: 1,
    }])
    const revision = `sha256:${'3'.repeat(64)}`
    const sourceCheck = deferred<CurrentAccess>()
    const sourceReader = deliveryParticipant()
    const independentWriter = deliveryParticipant()
    const independentCheck = vi.fn(async () => ({ ...access('writer'), permissionEpoch: 8 }))
    bindPrincipal('u_scope_probe', 's1', access('reader', revision, performance.now() + 60_000),
      () => sourceCheck.promise, sourceReader, 'drive:reader')
    invalidateActiveAccess('d1', 's1', 'u_scope_probe')
    bindPrincipal('u_scope_probe', 's1', access('writer'), independentCheck,
      independentWriter, 'share:writer')
    expect(sourceReader.frozen).toBe(true)

    await pollActiveAccess()

    expect(independentCheck).toHaveBeenCalledTimes(1)
    expect(independentWriter.frozen).toBe(false)
    expect(independentWriter.closure).toBeNull()
    sourceCheck.resolve({ ...access('reader', revision, performance.now() + 60_000), permissionEpoch: 8 })
    await vi.waitFor(() => expect(sourceReader.frozen).toBe(false))
  })

  it('invalidates a changed Drive source before rechecking a simultaneous Docs epoch', async () => {
    const order: string[] = []
    const invalidate = vi.spyOn(derivedAccessClient, 'invalidateDriveDerivedAccess')
      .mockImplementation(() => { order.push('invalidate') })
    activeAccessMocks.getEpochsByDocIds.mockResolvedValueOnce([{
      doc_id: 'd1',
      document_name: 'octo:s1:f1:doc:d1',
      permission_epoch: 8,
      status: 1,
    }])
    const oldRevision = `sha256:${'4'.repeat(64)}`
    const newRevision = `sha256:${'5'.repeat(64)}`
    setDriveDerivedAccess({
      derivedAccess: async () => null,
      versions: async bindings => bindings.map(binding => ({
        ...binding,
        sourceRevision: newRevision,
        validForMs: 60_000,
        expiresAt: performance.now() + 60_000,
      })),
    })
    const reader = deliveryParticipant()
    bindPrincipal('u_epoch_source_order', 's1',
      { ...access('reader', oldRevision, performance.now() + 60_000), permissionEpoch: 7 },
      async () => {
        order.push('resolve')
        return { ...access('none'), permissionEpoch: 8 }
      }, reader, 'drive:reader')

    try {
      await pollActiveAccess()
      expect(order.slice(0, 2)).toEqual(['invalidate', 'resolve'])
      await vi.waitFor(() => expect(reader.closure?.code).toBe(4403))
    } finally {
      invalidate.mockRestore()
    }
  })
  it('invalidates a changed source before an epoch refresh triggered by a newer registration', async () => {
    const order: string[] = []
    const invalidate = vi.spyOn(derivedAccessClient, 'invalidateDriveDerivedAccess')
      .mockImplementation(() => { order.push('invalidate') })
    const oldRevision = `sha256:${'9'.repeat(64)}`
    const newRevision = `sha256:${'a'.repeat(64)}`
    const oldReader = deliveryParticipant()
    const currentReader = deliveryParticipant()
    try {
      bindPrincipal('u_registration_source_order', 's1',
        { ...access('reader', oldRevision, performance.now() + 60_000), permissionEpoch: 7 },
        async () => {
          order.push('old-resolve')
          return { ...access('reader', oldRevision, performance.now() + 60_000), permissionEpoch: 8 }
        }, oldReader, 'drive:reader')
      bindPrincipal('u_registration_source_order', 's1',
        { ...access('reader', newRevision, performance.now() + 60_000), permissionEpoch: 8 },
        async () => {
          order.push('new-resolve')
          return { ...access('reader', newRevision, performance.now() + 60_000), permissionEpoch: 8 }
        }, currentReader, 'drive:reader')

      expect(order.slice(0, 3)).toEqual(['invalidate', 'old-resolve', 'new-resolve'])
      await vi.waitFor(() => {
        expect(oldReader.frozen).toBe(false)
        expect(currentReader.frozen).toBe(false)
      })
      expect(oldReader.closure).toBeNull()
      expect(currentReader.closure).toBeNull()
    } finally {
      invalidate.mockRestore()
    }
  })

  it('does not freeze a just-confirmed epoch participant with a stale peer refresh', async () => {
    const oldReader = participant()
    const confirmedReader = participant()
    const revision = `sha256:${'6'.repeat(64)}`
    const currentState = { ...access('reader', revision, performance.now() + 60_000), permissionEpoch: 8 }
    const newResolver = vi.fn(async () => { throw new Error('confirmed participant must not recheck') })
    bindPrincipal('u_confirmed_epoch', 's1',
      { ...currentState, permissionEpoch: 7 },
      async () => { throw new Error('stale peer cannot confirm authority') },
      oldReader, 'direct')

    bindPrincipal('u_confirmed_epoch', 's1',
      currentState, newResolver, confirmedReader, 'direct')

    await vi.waitFor(() => expect(oldReader.close).toHaveBeenCalledWith(
      4401, 'Authorization could not be confirmed',
    ))
    expect(newResolver).not.toHaveBeenCalled()
    expect(confirmedReader.freeze).not.toHaveBeenCalled()
    expect(confirmedReader.close).not.toHaveBeenCalled()
    expect(confirmedReader.resume).toHaveBeenCalledTimes(1)
  })
  it('defers a late source reader until simultaneous epoch and source invalidation are resolved', async () => {
    const oldRevision = `sha256:${'d'.repeat(64)}`
    const currentRevision = `sha256:${'e'.repeat(64)}`
    const versionsStarted = deferred<void>()
    const versionResult = deferred<string>()
    const oldRecheck = deferred<CurrentAccess>()
    const lateRecheck = deferred<CurrentAccess>()
    activeAccessMocks.getEpochsByDocIds.mockResolvedValueOnce([{
      doc_id: 'd1',
      document_name: 'octo:s1:f1:doc:d1',
      permission_epoch: 8,
      status: 1,
    }])
    setDriveDerivedAccess({
      derivedAccess: async () => null,
      versions: async bindings => {
        versionsStarted.resolve()
        const sourceRevision = await versionResult.promise
        return bindings.map(binding => ({
          ...binding,
          sourceRevision,
          validForMs: 60_000,
          expiresAt: performance.now() + 60_000,
        }))
      },
    })
    const oldReader = deliveryParticipant()
    const oldResolver = vi.fn(() => oldRecheck.promise)
    bindPrincipal('u_late_epoch_source', 's1',
      { ...access('reader', oldRevision, performance.now() + 60_000), permissionEpoch: 7 },
      oldResolver, oldReader, 'share:old')

    const poll = pollActiveAccess()
    const currentState = {
      ...access('reader', currentRevision, performance.now() + 60_000),
      permissionEpoch: 8,
    }
    const lateReader = deliveryParticipant()
    const lateResolver = vi.fn(() => lateRecheck.promise)
    try {
      await versionsStarted.promise
      bindPrincipal('u_late_epoch_source', 's1',
        { ...access('reader', oldRevision, performance.now() + 60_000), permissionEpoch: 8 },
        lateResolver, lateReader, 'share:new')
      expect(oldReader.frozen).toBe(true)
      expect(lateReader.frozen).toBe(true)
      expect(oldResolver).not.toHaveBeenCalled()
      expect(lateResolver).not.toHaveBeenCalled()

      versionResult.resolve(currentRevision)
      await vi.waitFor(() => {
        expect(oldResolver).toHaveBeenCalledTimes(1)
        expect(lateResolver).toHaveBeenCalledTimes(1)
      })
      broadcastTo([oldReader, lateReader], 'blocked until the combined source check completes')
      expect(oldReader.received).toEqual([])
      expect(lateReader.received).toEqual([])

      oldRecheck.resolve(currentState)
      lateRecheck.resolve(currentState)
      await poll
      await vi.waitFor(() => {
        expect(oldReader.frozen).toBe(false)
        expect(lateReader.frozen).toBe(false)
      })
      broadcastTo([oldReader, lateReader], 'after combined epoch and source confirmation')
      expect(oldReader.received).toEqual(['after combined epoch and source confirmation'])
      expect(lateReader.received).toEqual(['after combined epoch and source confirmation'])
    } finally {
      versionResult.resolve(currentRevision)
      oldRecheck.resolve(currentState)
      lateRecheck.resolve(currentState)
      await poll
    }
  })
  it('revalidates a late current-epoch reader when the in-flight source probe sees a newer revision', async () => {
    const oldRevision = `sha256:${'7'.repeat(64)}`
    const currentRevision = `sha256:${'8'.repeat(64)}`
    const versionsStarted = deferred<void>()
    const versionResult = deferred<string>()
    const lateRecheck = deferred<CurrentAccess>()
    setDriveDerivedAccess({
      derivedAccess: async () => null,
      versions: async bindings => {
        versionsStarted.resolve()
        const sourceRevision = await versionResult.promise
        return bindings.map(binding => ({
          ...binding,
          sourceRevision,
          validForMs: 60_000,
          expiresAt: performance.now() + 60_000,
        }))
      },
    })
    activeAccessMocks.getEpochsByDocIds.mockResolvedValueOnce([{
      doc_id: 'd1',
      document_name: 'octo:s1:f1:doc:d1',
      permission_epoch: 8,
      status: 1,
    }])
    const oldReader = deliveryParticipant()
    bindPrincipal('u_late_source_epoch', 's1',
      { ...access('reader', oldRevision, performance.now() + 60_000), permissionEpoch: 7 },
      async () => ({ ...access('reader', currentRevision), permissionEpoch: 8 }),
      oldReader, 'share:old')

    const poll = pollActiveAccess()
    await versionsStarted.promise
    const lateReader = deliveryParticipant()
    const lateResolver = vi.fn(() => lateRecheck.promise)
    bindPrincipal('u_late_source_epoch', 's1',
      { ...access('reader', oldRevision, performance.now() + 60_000), permissionEpoch: 8 },
      lateResolver, lateReader, 'share:new')
    expect(lateReader.frozen).toBe(true)

    versionResult.resolve(currentRevision)
    await vi.waitFor(() => expect(lateResolver).toHaveBeenCalledTimes(1))
    expect(lateReader.frozen).toBe(true)
    broadcastTo([lateReader], 'must stay blocked until its own source proof is checked')
    expect(lateReader.received).toEqual([])

    lateRecheck.resolve({
      ...access('reader', currentRevision, performance.now() + 60_000),
      permissionEpoch: 8,
    })
    await poll
    await vi.waitFor(() => expect(lateReader.frozen).toBe(false))
    broadcastTo([lateReader], 'after current source proof')
    expect(lateReader.received).toEqual(['after current source proof'])
  })
  it('keeps a late source registration frozen when the in-flight round had no version batch', async () => {
    const oldRevision = `sha256:${'b'.repeat(64)}`
    const currentRevision = `sha256:${'c'.repeat(64)}`
    const epochResult = deferred<Array<{
      doc_id: string
      document_name: string
      permission_epoch: number
      status: number
    }>>()
    activeAccessMocks.getEpochsByDocIds.mockReturnValueOnce(epochResult.promise)
    let versionCalls = 0
    setDriveDerivedAccess({
      derivedAccess: async () => null,
      versions: async bindings => {
        versionCalls++
        return bindings.map(binding => ({
          ...binding,
          sourceRevision: currentRevision,
          validForMs: 60_000,
          expiresAt: performance.now() + 60_000,
        }))
      },
    })
    const existingIndependent = deliveryParticipant()
    bindPrincipal('u_late_source_no_batch', 's1', access('writer'),
      async () => access('writer'), existingIndependent, 'share:independent')

    const poll = pollActiveAccess()
    const lateReader = deliveryParticipant()
    const lateCheck = deferred<CurrentAccess>()
    const lateResolver = vi.fn(() => lateCheck.promise)
    bindPrincipal('u_late_source_no_batch', 's1',
      access('reader', oldRevision, performance.now() + 60_000),
      lateResolver, lateReader, 'share:source')
    expect(lateReader.frozen).toBe(true)
    epochResult.resolve([{
      doc_id: 'd1',
      document_name: 'octo:s1:f1:doc:d1',
      permission_epoch: 7,
      status: 1,
    }])
    await poll

    expect(versionCalls).toBe(0)
    expect(lateResolver).toHaveBeenCalledTimes(1)
    expect(lateReader.frozen).toBe(true)
    lateCheck.resolve(access('reader', currentRevision, performance.now() + 60_000))
    await vi.waitFor(() => expect(lateReader.frozen).toBe(false))
  })
  it('invalidates a pre-poll lease when the version probe outruns removal of its old binding', async () => {
    const oldRevision = `sha256:${'9'.repeat(64)}`
    const currentRevision = `sha256:${'a'.repeat(64)}`
    const versionsStarted = deferred<void>()
    const versionResult = deferred<string>()
    const oldRecheck = deferred<CurrentAccess>()
    const lateRecheck = deferred<CurrentAccess>()
    setDriveDerivedAccess({
      derivedAccess: async () => null,
      versions: async bindings => {
        versionsStarted.resolve()
        const sourceRevision = await versionResult.promise
        return bindings.map(binding => ({
          ...binding,
          sourceRevision,
          validForMs: 60_000,
          expiresAt: performance.now() + 60_000,
        }))
      },
    })
    const binding = {
      docId: 'd1', uid: 'u_pending_source_watermark', principalSpaceId: 's1',
      documentName: 'octo:s1:f1:doc:d1',
    }
    const oldReader = deliveryParticipant()
    const oldResolver = vi.fn(() => oldRecheck.promise)
    bindPrincipal(binding.uid, 's1',
      access('reader', oldRevision, performance.now() + 60_000),
      oldResolver, oldReader, 'drive:reader')
    const pendingLease = beginActiveAccessRegistration(binding, 'drive:reader')
    const poll = pollActiveAccess()
    try {
      await versionsStarted.promise
      versionResult.resolve(currentRevision)
      await poll
      await vi.waitFor(() => expect(oldResolver).toHaveBeenCalledTimes(1))
      expect(pendingLease.sourceRevisionInvalidated).toBe(true)
      expect(pendingLease.sourceRevisionWatermark).toBe(currentRevision)

      oldRecheck.resolve(access('none', currentRevision))
      await vi.waitFor(() => expect(oldReader.closure?.code).toBe(4403))

      const lateReader = deliveryParticipant()
      const lateResolver = vi.fn(() => lateRecheck.promise)
      disposers.push(registerActiveAccess(binding, 7,
        access('reader', oldRevision, performance.now() + 60_000),
        lateResolver, lateReader, pendingLease))
      expect(pendingLease.invalidated).toBe(true)
      await vi.waitFor(() => expect(lateResolver).toHaveBeenCalledTimes(1))
      expect(lateReader.frozen).toBe(true)
      broadcastTo([lateReader], 'stale pre-poll proof must remain blocked')
      expect(lateReader.received).toEqual([])

      lateRecheck.resolve(access('reader', currentRevision, performance.now() + 60_000))
      await vi.waitFor(() => expect(lateReader.frozen).toBe(false))
      broadcastTo([lateReader], 'after current source proof')
      expect(lateReader.received).toEqual(['after current source proof'])
    } finally {
      versionResult.resolve(currentRevision)
      oldRecheck.resolve(access('none', currentRevision))
      lateRecheck.resolve(access('reader', currentRevision, performance.now() + 60_000))
      await poll
    }
  })

  it('uses the observed version when registering during the old participant close callback', async () => {
    const oldRevision = `sha256:${'b'.repeat(64)}`
    const currentRevision = `sha256:${'c'.repeat(64)}`
    const versionsStarted = deferred<void>()
    const versionResult = deferred<string>()
    const oldRecheck = deferred<CurrentAccess>()
    const lateRecheck = deferred<CurrentAccess>()
    setDriveDerivedAccess({
      derivedAccess: async () => null,
      versions: async bindings => {
        versionsStarted.resolve()
        const sourceRevision = await versionResult.promise
        return bindings.map(binding => ({
          ...binding,
          sourceRevision,
          validForMs: 60_000,
          expiresAt: performance.now() + 60_000,
        }))
      },
    })
    const binding = {
      docId: 'd1', uid: 'u_close_source_watermark', principalSpaceId: 's1',
      documentName: 'octo:s1:f1:doc:d1',
    }
    const oldReader = deliveryParticipant()
    const lateReader = deliveryParticipant()
    const lateResolver = vi.fn(() => lateRecheck.promise)
    const closeOldReader = oldReader.close.bind(oldReader)
    vi.spyOn(oldReader, 'close').mockImplementation((code, reason) => {
      closeOldReader(code, reason)
      const lease = beginActiveAccessRegistration(binding, 'drive:reader')
      expect(lease.sourceRevisionWatermark).toBe(currentRevision)
      const dispose = registerActiveAccess(binding, 7,
        access('reader', oldRevision, performance.now() + 60_000),
        lateResolver, lateReader, lease)
      expect(lease.invalidated).toBe(true)
      disposers.push(dispose)
    })
    bindPrincipal(binding.uid, 's1',
      access('reader', oldRevision, performance.now() + 60_000),
      () => oldRecheck.promise, oldReader, 'drive:reader')

    const poll = pollActiveAccess()
    try {
      await versionsStarted.promise
      versionResult.resolve(currentRevision)
      await poll
      oldRecheck.resolve(access('none', currentRevision))
      await vi.waitFor(() => {
        expect(oldReader.closure?.code).toBe(4403)
        expect(lateResolver).toHaveBeenCalledTimes(1)
      })
      expect(lateReader.frozen).toBe(true)
      broadcastTo([lateReader], 'old record revision must not authorize the new reader')
      expect(lateReader.received).toEqual([])

      lateRecheck.resolve(access('reader', currentRevision, performance.now() + 60_000))
      await vi.waitFor(() => expect(lateReader.frozen).toBe(false))
      broadcastTo([lateReader], 'after current source proof')
      expect(lateReader.received).toEqual(['after current source proof'])
    } finally {
      versionResult.resolve(currentRevision)
      oldRecheck.resolve(access('none', currentRevision))
      lateRecheck.resolve(access('reader', currentRevision, performance.now() + 60_000))
      await poll
    }
  })
})
