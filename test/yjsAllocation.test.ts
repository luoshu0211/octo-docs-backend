import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'

// Generated with unmodified yjs@13.6.31: map singletons, a multi-item array,
// nested values, undefined, binary content, Unicode, and floating-point values.
const upstream = {
  1: 'AQy5YAAoAQFtATABfigBAW0BMQF/KAEBbQEyAXgoAQFtATMBeSgBAW0BNAF9KigBAW0BNQF7QAkeuFHrhR8oAQFtATYBdwrkuK3mlofwn5mCKAEBbQE3AXYDAXZ9AQF0fQIFc3R5bGV2AQJiZ3cDcmVkKAEBbQE4AXUCfQF3A3R3byMBAW0BOQMBAgMIAQFhCH54eX0qe0AJHrhR64UfdwrkuK3mlofwn5mCdgMBdn0BAXR9AgVzdHlsZXYBAmJndwNyZWR1An0BdwN0d2+DuWARAwECAwA=',
  2: 'AAAE+cABAAEiAAcoCCMACACDGBVtMG0xbTJtM200bTVtNm03bThtOWFBEwEBAANBBwgBDAB+f3h5fSp7QAkeuFHrhR93CuS4reaWh/CfmYJ2AwF2fQEBdH0CBXN0eWxldgECYmd3A3JlZHUCfQF3A3R3bwMBAgN+eHl9KntACR64UeuFH3cK5Lit5paH8J+ZgnYDAXZ9AQF0fQIFc3R5bGV2AQJiZ3cDcmVkdQJ9AXcDdHdvAwECAwA=',
}

describe.each([1, 2] as const)('singleton decoder V%i compatibility', version => {
  it('roundtrips the exact upstream bytes and preserves mixed content', () => {
    const d = new Y.Doc()
    try {
      const bytes = Buffer.from(upstream[version], 'base64')
      const apply = version === 1 ? Y.applyUpdate : Y.applyUpdateV2
      const encode = version === 1 ? Y.encodeStateAsUpdate : Y.encodeStateAsUpdateV2
      apply(d, bytes)
      expect(Buffer.from(encode(d))).toEqual(bytes)
      expect(d.getMap('m').get('6')).toBe('中文🙂')
      expect(d.getMap('m').has('1')).toBe(true)
      expect(d.getMap('m').get('1')).toBeUndefined()
      expect(d.getArray('a').length).toBe(9)
      expect(d.getMap('m').get('9')).toEqual(new Uint8Array([1, 2, 3]))
    } finally { d.destroy() }
  })

  it('converges after concurrent changes, deletion and undo', () => {
    const a = new Y.Doc(); const b = new Y.Doc()
    const apply = version === 1 ? Y.applyUpdate : Y.applyUpdateV2
    const encode = version === 1 ? Y.encodeStateAsUpdate : Y.encodeStateAsUpdateV2
    const undo = new Y.UndoManager(a.getMap('m'))
    try {
      for (const d of [a, b]) apply(d, Buffer.from(upstream[version], 'base64'))
      undo.clear()
      a.getMap('m').set('0', { v: 'left' })
      b.getMap('m').set('7', { v: 'right' }); b.getMap('m').delete('2')
      apply(a, encode(b), 'remote'); apply(b, encode(a), 'remote')
      expect(a.getMap('m').toJSON()).toEqual(b.getMap('m').toJSON())
      expect(a.getMap('m').has('2')).toBe(false)
      undo.undo(); apply(b, encode(a))
      expect(a.getMap('m').get('0')).toBeNull()
      expect(a.getMap('m').toJSON()).toEqual(b.getMap('m').toJSON())
    } finally { undo.destroy(); a.destroy(); b.destroy() }
  })
})

it('bounds retained numeric-cell allocation in an isolated Node heap (CJS entrypoint)', () => {
  // Generate in a different process. V8 may retain a recently destroyed source
  // Doc through the synchronous transaction stack even after explicit GC.
  // A multi-MiB writeFileSync(1, bytes) can hit EAGAIN on a nonblocking Linux
  // child-process pipe. Exchange the fixture through a private regular file.
  const directory = mkdtempSync(join(tmpdir(), 'octo-yjs-allocation-'))
  const fixture = join(directory, 'numeric-v2.bin')
  try {
    execFileSync(process.execPath, ['--max-old-space-size=256', '-e', `
      const Y = require('yjs'); const n = 200000; const original = new Y.Doc();
      original.transact(() => { for (let i = 0; i < n; i++) original.getMap('sheet').set('default!' + i, {v:i,t:2}) });
      require('node:fs').writeFileSync(process.argv[1], Y.encodeStateAsUpdateV2(original)); original.destroy();
    `, fixture], { timeout: 20_000, stdio: ['ignore', 'ignore', 'pipe'] })
    const output = execFileSync(process.execPath, ['--max-old-space-size=512', '--expose-gc', '-e', `
      const Y = require('yjs'); const n = 200000;
      const bytes = require('node:fs').readFileSync(process.argv[1]);
      for(let i=0;i<3;i++) gc(); const before = process.memoryUsage().heapUsed;
      const doc = new Y.Doc(); Y.applyUpdateV2(doc, bytes);
      for(let i=0;i<3;i++) gc();
      process.stdout.write(JSON.stringify({cells:doc.getMap('sheet').size, perCell:(process.memoryUsage().heapUsed-before)/n}));
      doc.destroy();
    `, fixture], { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    const result = JSON.parse(output)
    expect(result.cells).toBe(200_000)
    // This 200k-cell / 512 MiB-heap fixture retains ~620 B/cell unpatched and
    // ~495-510 B patched. Exact singleton arrays save 128 B; allow GC variation.
    expect(result.perCell).toBeLessThan(560)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 25_000)
