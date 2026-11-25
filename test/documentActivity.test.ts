import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { messageYjsSyncStep2, messageYjsUpdate } from 'y-protocols/sync'
import {
  captureDocumentBodyEdits,
  confirmDocumentBodyEdits,
  markDocumentSyncFrame,
  snapshotIncludesDocumentEdit,
  trackDocumentBodyEdits,
  waitForDocumentEditEvidence,
} from '../src/collab/documentActivity.js'
import { COLLAB_FIELD } from '../src/schema/index.js'
import type { PendingDocumentEdit } from '../src/drive/documentActivity.js'
import { driveInternalUrl } from '../src/drive/internalUrl.js'

function editor(id: string, space = 'space-a', readOnly = false, frame = messageYjsUpdate) {
  const origin = {
    source: 'connection',
    connection: {
      readOnly,
      context: { user: { id }, principal_space_id: space, kind: 'document' },
    },
  }
  markDocumentSyncFrame(origin.connection, frame)
  return origin
}

function append(doc: Y.Doc, text: string, origin: unknown) {
  doc.transact(() => {
    const fragment = doc.getXmlFragment(COLLAB_FIELD)
    const paragraph = new Y.XmlText()
    paragraph.insert(0, text)
    fragment.push([paragraph])
  }, origin)
}

describe('document edit activity', () => {
  it('collects each authenticated editor in a save and ignores non-body and replicated writes', () => {
    const doc = new Y.Doc()
    try {
      append(doc, 'restored initial body', { source: 'local' })
      trackDocumentBodyEdits(doc)
      doc.transact(() => doc.getMap('metadata').set('title', 'renamed'), editor('alice'))
      append(doc, 'replica update', { source: 'redis' })
      append(doc, 'read-only update', editor('reader', 'space-a', true))
      expect(captureDocumentBodyEdits(doc)).toEqual([])

      append(doc, 'first edit', editor('alice'))
      append(doc, 'second edit', editor('alice'))
      doc.transact(() => {
        const first = doc.getXmlFragment(COLLAB_FIELD).get(0) as Y.XmlText
        first.delete(0, 2)
      }, editor('bob', 'space-b'))
      const captured = captureDocumentBodyEdits(doc)
      expect(captured.map(edit => [edit.actorUid, edit.principalSpaceId])).toEqual([
        ['alice', 'space-a'],
        ['bob', 'space-b'],
      ])
      expect(captureDocumentBodyEdits(doc).map(edit => edit.eventId)).toEqual(captured.map(edit => edit.eventId))
      confirmDocumentBodyEdits(doc, captured)
      expect(captureDocumentBodyEdits(doc)).toEqual([])
    } finally {
      doc.destroy()
    }
  })

  it('carries the original editor across replicas and ignores an authenticated cache SyncStep2', async () => {
    const author = new Y.Doc()
    const peer = new Y.Doc()
    try {
      const staged: PendingDocumentEdit[] = []
      trackDocumentBodyEdits(author, async edit => { staged.push(edit) })
      trackDocumentBodyEdits(peer)
      append(author, 'Alice changed the body', editor('alice'))
      await waitForDocumentEditEvidence(author)
      expect(staged.map(edit => edit.actorUid)).toEqual(['alice'])
      expect(snapshotIncludesDocumentEdit(Y.snapshot(peer), null, staged[0]!.proof)).toBe(false)
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(author), editor('bob', 'space-a', false, messageYjsSyncStep2))
      expect(captureDocumentBodyEdits(peer)).toEqual([])
      expect(snapshotIncludesDocumentEdit(Y.snapshot(peer), null, staged[0]!.proof)).toBe(true)
    } finally {
      author.destroy()
      peer.destroy()
    }
  })

  it('attributes a trusted direct API edit and requires its deletion to be in the saved state', () => {
    const doc = new Y.Doc()
    const old = new Y.Doc()
    try {
      append(doc, 'Delete me', { source: 'local' })
      Y.applyUpdate(old, Y.encodeStateAsUpdate(doc))
      trackDocumentBodyEdits(doc)
      const origin = { source: 'local', context: { documentEditActor: { actorUid: 'api-actor', principalSpaceId: 'space-api' } } }
      doc.transact(() => {
        const text = doc.getXmlFragment(COLLAB_FIELD).get(0) as Y.XmlText
        text.delete(0, text.length)
      }, origin)
      const [edit] = captureDocumentBodyEdits(doc)
      expect(edit?.actorUid).toBe('api-actor')
      expect(edit?.proof.clocks).toEqual([])
      expect(snapshotIncludesDocumentEdit(Y.snapshot(old), null, edit!.proof)).toBe(false)
      expect(snapshotIncludesDocumentEdit(Y.snapshot(doc), null, edit!.proof)).toBe(true)
      expect(snapshotIncludesDocumentEdit(Y.snapshot(doc), 'other-generation', edit!.proof)).toBe(false)
    } finally {
      doc.destroy()
      old.destroy()
    }
  })

  it('retains the Drive proxy path including with a trailing slash', () => {
    expect(driveInternalUrl('https://gateway.example/drive/', '/internal/v1/docs/document-edits'))
      .toBe('https://gateway.example/drive/internal/v1/docs/document-edits')
  })

  it('retains edits that arrive after snapshot capture even for the same author', () => {
    const doc = new Y.Doc()
    try {
      trackDocumentBodyEdits(doc)
      append(doc, 'first edit', editor('alice'))
      const firstSave = captureDocumentBodyEdits(doc)
      append(doc, 'second edit while SQL is in flight', editor('alice'))
      confirmDocumentBodyEdits(doc, firstSave)
      const secondSave = captureDocumentBodyEdits(doc)
      expect(secondSave).toHaveLength(1)
      expect(secondSave[0]?.eventId).not.toBe(firstSave[0]?.eventId)
      confirmDocumentBodyEdits(doc, secondSave)
      expect(captureDocumentBodyEdits(doc)).toEqual([])
    } finally {
      doc.destroy()
    }
  })
})
