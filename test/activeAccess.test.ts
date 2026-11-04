import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { beginActiveAccessRegistration, invalidateActiveAccess, pollActiveAccess, registerActiveAccess, type ActiveAccessParticipant } from '../src/permission/activeAccess.js'
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
): void {
  const binding = {
    docId: 'd1', uid, principalSpaceId,
    documentName: `octo:${principalSpaceId}:f1:doc:d1`,
  }
  const registration = beginActiveAccessRegistration(binding)
  disposers.push(registerActiveAccess(binding, 7, initial, resolve, sink, registration))
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
  const registration = beginActiveAccessRegistration(binding)
  disposers.push(registerActiveAccess(binding, 7, initial, resolve, sink, registration))
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

  it('discards an older in-flight denial when a newer independent registration supersedes the binding', async () => {
    const proof = access('reader', `sha256:${'c'.repeat(64)}`, performance.now() + 60_000)
    const pending = deferred<CurrentAccess>()
    const oldReader = deliveryParticipant()
    bindPrincipal('u_shared', 's1', proof, () => pending.promise, oldReader)
    invalidateActiveAccess('d1', 's1', 'u_shared')
    expect(oldReader.frozen).toBe(true)

    const independentWriter = deliveryParticipant()
    bindPrincipal('u_shared', 's1', access('writer'), async () => access('writer'), independentWriter)

    pending.resolve(access('none'))
    await vi.waitFor(() => {
      expect(oldReader.closure).toBeNull()
      expect(independentWriter.closure).toBeNull()
    })
    await vi.waitFor(() => {
      expect(oldReader.frozen).toBe(false)
      expect(independentWriter.frozen).toBe(false)
    })

    broadcastTo([oldReader, independentWriter], 'after the newer independent registration')
    expect(oldReader.received).toEqual(['after the newer independent registration'])
    expect(independentWriter.received).toEqual(['after the newer independent registration'])
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
})
