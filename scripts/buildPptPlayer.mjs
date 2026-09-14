import process from 'node:process'
// Build the immutable offline player from the same pinned engine as the editor.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { pptCodePlugin, withCodeNotice } from './ppt-code-plugin.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(process.argv[2] || '../bento')
const pin = 'cc038183dbf79a33bee7fe49d0aa1c23f7224874'
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim() !== pin ||
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: source, encoding: 'utf8' }).trim()) throw new Error(`Expected clean Bento ${pin}`)
const dep = name => pathToFileURL(resolve(source, 'slides/node_modules', name)).href
const { build } = await import(dep('vite/dist/node/index.js'))
const { viteSingleFile } = await import(dep('vite-plugin-singlefile/dist/esm/index.js'))
const output = resolve(root, 'assets/ppt')
await build({ configFile: false, root: resolve(root, 'runtime/ppt-player'), base: './',
  define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(resolve(source, 'slides/package.json'))).version) },
  resolve: { alias: { 'bento-slides': resolve(source, 'slides/src'), 'bento-kernel': resolve(source, 'kernel/src') } },
  plugins: [pptCodePlugin(source), viteSingleFile()], build: { outDir: output, emptyOutDir: false, assetsInlineLimit: 100000000, chunkSizeWarningLimit: 8192 },
})
mkdirSync(output, { recursive: true })
writeFileSync(resolve(output, 'player.html'), withCodeNotice(readFileSync(resolve(output, 'index.html'), 'utf8')))
copyFileSync(resolve(source, 'LICENSE'), resolve(output, 'LICENSE'))
copyFileSync(resolve(source, 'THIRD_PARTY_NOTICES.md'), resolve(output, 'THIRD_PARTY_NOTICES.md'))
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(resolve(dir, entry.name)) : [resolve(dir, entry.name)])
const inputs = [...files(resolve(root, 'runtime/ppt-player')), resolve(root, 'scripts/buildPptPlayer.mjs'), resolve(root, 'scripts/ppt-code-plugin.mjs'), resolve(root, 'src/ppt/offlineHost.ts')].sort()
const inputSha256 = Object.fromEntries(inputs.map(file => [file.slice(root.length + 1), createHash('sha256').update(readFileSync(file)).digest('hex')]))
writeFileSync(resolve(output, 'provenance.json'), JSON.stringify({ source: 'nyblnet/bento', commit: pin, inputSha256,
  sha256: createHash('sha256').update(readFileSync(resolve(output, 'player.html'))).digest('hex') }, null, 2) + '\n')
