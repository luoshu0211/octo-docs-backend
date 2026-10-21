// Yjs map entries have a single value. V8's [].push(value) reserves space for
// more values; [value] keeps an exact singleton without changing the wire format.
// Pinned and fail-closed: review this patch deliberately on every Yjs upgrade.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const root = dirname(require.resolve('yjs/package.json'))
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (version !== '13.6.31') throw new Error(`Review ContentAny allocation patch for Yjs ${version}`)

// Validate all entrypoints before writing any, and support repeated npm installs.
const changes = ['src/structs/ContentAny.js', 'dist/yjs.mjs', 'dist/yjs.cjs'].map(file => {
  const path = join(root, file)
  const original = readFileSync(path, 'utf8')
  const semi = file.startsWith('dist/') ? ';' : ''
  const before = `const readContentAny = decoder => {\n  const len = decoder.readLen()${semi}\n  const cs = []${semi}`
  const after = `const readContentAny = decoder => {\n  const len = decoder.readLen()${semi}\n  if (len === 1) return new ContentAny([decoder.readAny()])${semi}\n  const cs = []${semi}`
  if (original.includes(after) && original.split(after).length === 2) return { path, original, patched: original }
  if (original.split(before).length !== 2) throw new Error(`Unexpected Yjs decoder in ${file}`)
  return { path, original, patched: original.replace(before, after) }
})
for (const { path, original, patched } of changes) if (patched !== original) writeFileSync(path, patched)
