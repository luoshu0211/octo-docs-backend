import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'

it('ships the recorded player and exactly the recorded build inputs', () => {
  const root = new URL('../', import.meta.url)
  const proof = JSON.parse(readFileSync(new URL('assets/ppt/provenance.json', root), 'utf8')) as { sha256: string; inputSha256: Record<string, string> }
  const digest = (path: string) => createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex')
  expect(digest('assets/ppt/player.html')).toBe(proof.sha256)
  for (const [path, expected] of Object.entries(proof.inputSha256)) expect(digest(path), path).toBe(expected)
})
