import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OCTO-456 §4.3 search wire contract.
 *
 * The business handler (src/api/routes/docs.ts) emits camelCase `indexStatus`.
 * `/v2/cli/docs/_search` runs the response through the CLI adapter, which
 * snake-cases EVERY DTO key (`src/api/cliv2/adapter.ts`), so the documented
 * CLI wire field is `index_status` — consistent with its sibling `doc_id` /
 * `doc_type` / `updated_at` / `space_id`. This test pins the adapter output
 * against docs/openapi/v2.yaml so the spec can never drift from the wire.
 */
import { mapKeys } from '../src/api/cliv2/adapter.js'

const { load } = createRequire(import.meta.url)('js-yaml') as {
  load(text: string): {
    components: {
      schemas: {
        DocsSearchResponse: {
          properties: {
            data: {
              items: {
                properties: Record<string, { type?: string | string[]; enum?: string[]; description?: string }>
              }
            }
          }
        }
      }
    }
  }
}
const schemas = load(
  readFileSync(new URL('../docs/openapi/v2.yaml', import.meta.url), 'utf8'),
).components.schemas
const item = schemas.DocsSearchResponse.properties.data.items.properties

describe('DocsSearchResponse.index_status contract', () => {
  it('documents index_status with the reserved enum', () => {
    expect(item).toHaveProperty('index_status')
    expect(item.index_status!.enum).toEqual(['ready', 'processing', 'failed', 'unsupported'])
  })

  it('documents the snake_case CLI wire, not the handler camelCase field', () => {
    // The CLI adapter owns the naming: every key becomes snake_case.
    expect(item).not.toHaveProperty('indexStatus')
    expect(Object.keys(item).every((key) => key === key.toLowerCase())).toBe(true)
  })

  it('the CLI adapter turns the handler item into exactly the documented keys', () => {
    const runtimeItem = {
      docId: 'd_1',
      title: 'One',
      docType: 'doc',
      updatedAt: 1000,
      spaceId: 's_1',
      indexStatus: 'ready',
      highlight: '<em>One</em>',
    }
    const wire = mapKeys(runtimeItem, false, 'docs.search') as Record<string, unknown>
    expect(wire).toEqual({
      doc_id: 'd_1',
      title: 'One',
      doc_type: 'doc',
      updated_at: 1000,
      space_id: 's_1',
      index_status: 'ready',
      highlight: '<em>One</em>',
    })
    // Every emitted key is documented (no undocumented field leaks to the CLI).
    expect(Object.keys(wire).every((key) => Object.hasOwn(item, key))).toBe(true)
  })
})
