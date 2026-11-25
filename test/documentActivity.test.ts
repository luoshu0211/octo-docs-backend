import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  captureDocumentBodyEdits,
  confirmDocumentBodyEdits,
  hasPendingDocumentBodyEdits,
  trackDocumentBodyEdits,
} from '../src/collab/documentActivity.js'
import { COLLAB_FIELD } from '../src/schema/index.js'

function editor(id: string, space = 'space-a', readOnly = false) {
  return {
    source: 'connection',
    connection: {
      readOnly,
      context: { user: { id }, principal_space_id: space, kind: 'document' },
    },
  }
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
      expect(hasPendingDocumentBodyEdits(doc)).toBe(false)
    } finally {
      doc.destroy()
    }
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
