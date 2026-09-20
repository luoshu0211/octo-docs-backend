// Adapt the pinned MIT Bento gallery into standalone, reusable hosted layouts.
// Usage: node scripts/buildPptGallery.mjs /path/to/pinned/bento
/* global process, structuredClone, console */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { createHash } from 'node:crypto'
import { galleryTextLines } from './pptGalleryText.mjs'

const source = resolve(process.argv[2])
const pinned = 'cc038183dbf79a33bee7fe49d0aa1c23f7224874'
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim() !== pinned) throw new Error('Gallery source must match the pinned engine')
const path = 'scripts/build-example-decks.mjs'
const original = readFileSync(join(source, path), 'utf8')
if (original !== execFileSync('git', ['show', `${pinned}:${path}`], { cwd: source, encoding: 'utf8' })) throw new Error('Modified gallery generator')
// Only execute the trusted, pinned authoring functions, not its HTML build/output.
const code = original.slice(original.indexOf('// the deck-embedded faces'), original.indexOf('// ——— splice + write'))
const raw = runInNewContext(code + '\n({signal:deckSignal(),terra:deckTerra(),orbital:deckOrbital(),picnic:deckPicnic()})', { root: source, readFileSync, join })
const names = {
  signal: ['海报封面 · Cover', '观点宣言 · Statement', '人物列表 · People', '全幅图文 · Photo', '数据图表 · Data', '章节强调 · Section', '结束页 · Closing'],
  terra: ['产品封面 · Cover', '品牌故事 · Story', '产品陈列 · Collection', '材质构成 · Materials', '结束页 · Closing'],
  orbital: ['科技封面 · Cover', '核心主张 · Thesis', '全幅图文 · Photo', '系统架构 · System', '增长数据 · Growth', '结束页 · Closing'],
  picnic: ['创意封面 · Cover', '知识卡片 · Cards', '步骤流程 · Steps', '图片故事 · Photo', '数据图表 · Data', '结束页 · Closing'],
}
for (const [id, deck] of Object.entries(raw)) {
  // Correct native demo copy without changing slide order, gradients or motion.
  // Apply before cloning layouts so both collections retain identical content.
  const replaceCopy = (holder, field, before, after) => {
    if (typeof holder?.[field] !== 'string' || holder[field].split(before).length !== 2) {
      throw new Error(`Pinned gallery copy drift: ${id} ${field}`)
    }
    holder[field] = holder[field].replace(before, after)
  }
  if (id === 'terra') {
    replaceCopy(deck.slides.find(s => s.id === 'ter-cover'), 'notes',
      'The three “vessels” morph into the collection grid on slide 3.',
      'Jump directly from this cover to slide 3 to morph the three “vessels” into the collection swatches; sequential playback visits the brand story first.')
    replaceCopy(deck.slides.find(s => s.id === 'ter-collection'), 'notes',
      'the three cover vessels MORPH down into the little glaze swatches beside each price. Same ids, new role.',
      'the three cover vessels share ids with the little glaze swatches beside each price. Jump directly from the cover to see them morph. Sequential playback arrives from the brand story, which has no matching vessels.')
  }
  if (id === 'orbital') {
    const model = deck.slides.find(s => s.id === 'orb-state-model')
    replaceCopy(model?.elements.find(el => el.html === '02a · MODEL — CLICK ANYWHERE DIM TO GO BACK'),
      'html', '02a · MODEL', '02b · MODEL')
  }
  deck.docId = `template_${id}`
  deck.modified = '1970-01-01T00:00:00.000Z'
  deck.collab = { room: 'template-room-placeholder', key: 'template-key-placeholder', on: false }
  // Preserve the complete native experience: media, fonts, motion and state branches.
  // Author references only for the known gallery palette, never infer them on user decks.
  deck.theme.palette = {
    signal: {},
    terra: { accent2: '#D9C9B4' },
    orbital: { bg2: '#0B0E1E', accent2: '#7A5CFF', accent3: '#FF4FA3' },
    picnic: { bg2: '#FFF9EC', accent2: '#4DC9F0', accent3: '#7BE382' },
  }[id]
  const palette = { bg1: deck.theme.background, tx1: deck.theme.color, accent1: deck.theme.accent, ...deck.theme.palette }
  const bind = (holder, path, value) => {
    const slot = Object.keys(palette).find(key => palette[key] === value)
    if (slot) (holder.themeRefs ??= {})[path] = slot
  }
  for (const slide of deck.slides) {
    bind(slide, 'background', slide.background)
    for (const el of slide.elements) {
      for (const field of ['color', 'fill', 'stroke']) bind(el, field, el[field])
      if (el.shadow) bind(el, 'shadow.color', el.shadow.color)
      for (const field of ['fillGradient', 'textGradient']) el[field]?.stops?.forEach((stop, i) => bind(el, `${field}.stops.${i}.color`, stop.color))
      // Media bytes belong in the shared asset table so a family copy does not
      // duplicate a clip in every slide/op. The player resolves the same bytes.
      if (typeof el.src === 'string' && el.src.startsWith('data:')) {
        const asset = `gallery-${createHash('sha256').update(el.src).digest('hex').slice(0, 20)}`
        ;(deck.assets ??= {})[asset] = el.src
        el.src = `asset:${asset}`
      }
    }
  }
  const mainSlides = deck.slides.filter(slide => !slide.stateOf)
  if (mainSlides.length !== names[id].length) throw new Error(`Gallery page count drift: ${id}`)
  mainSlides.forEach((slide, index) => { slide.name = names[id][index] })
  const layoutIds = new Map(deck.slides.map(slide => [slide.id, `layout-${id}-${slide.id}`]))
  deck.layouts = structuredClone(deck.slides).map(slide => {
    const layout = { ...slide, id: layoutIds.get(slide.id) }
    if (slide.stateOf) layout.stateOf = layoutIds.get(slide.stateOf)
    for (const el of layout.elements) if (el.link && layoutIds.has(el.link)) el.link = layoutIds.get(el.link)
    return layout
  })
  deck.templateCredits = {
    source: `https://github.com/nyblnet/bento/tree/${pinned}`,
    license: readFileSync(join(source, 'LICENSE'), 'utf8'),
    photos: readFileSync(join(source, 'scripts/gallery-photos/SOURCES.md'), 'utf8'),
    fonts: Object.fromEntries(['fraunces', 'instrumentsans', 'spacemono'].map(font => [font, readFileSync(`docs/ppt-gallery/OFL-${font}.txt`, 'utf8')])),
    adaptation: 'Octo: reusable page families with remapped state/link identities. Original embedded fonts, media, motion and interactions preserved. All demo brands and data are fictional.',
  }
}
// Keep each family independently reviewable without changing its deck payload.
const target = resolve('src/ppt/gallery')
mkdirSync(target, { recursive: true })
for (const [id, deck] of Object.entries(raw)) {
  writeFileSync(join(target, `${id}.json`), JSON.stringify(deck, null, 2) + '\n')
}
mkdirSync('docs/ppt-gallery', { recursive: true })
writeFileSync('docs/ppt-gallery/LICENSE-BENTO.txt', readFileSync(join(source, 'LICENSE')))
writeFileSync('docs/ppt-gallery/PHOTO-SOURCES.md', readFileSync(join(source, 'scripts/gallery-photos/SOURCES.md')))
console.log(JSON.stringify({ source: pinned, decks: Object.fromEntries(Object.entries(raw).map(([id,d]) => [id, { pages: d.slides.length, bytes: JSON.stringify(d).length, sha256: createHash('sha256').update(readFileSync(join(target, `${id}.json`))).digest('hex') }])) }))
// Build small cover previews from the same editable elements, never a separately drawn mock.
if (process.argv[3]) {
  const dest = resolve(process.argv[3]); mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'LICENSE-BENTO.txt'), readFileSync(join(source, 'LICENSE')))
  writeFileSync(join(dest, 'PHOTO-SOURCES.md'), readFileSync(join(source, 'scripts/gallery-photos/SOURCES.md')))
  for (const font of ['fraunces', 'instrumentsans', 'spacemono']) writeFileSync(join(dest, `OFL-${font}.txt`), readFileSync(`docs/ppt-gallery/OFL-${font}.txt`))
  const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  for (const [id, deck] of Object.entries(raw)) {
    const slide = deck.slides[0]
    const nodes = slide.elements.map((el, index) => {
      const transform = `opacity="${el.opacity ?? 1}" transform="rotate(${el.rotation ?? 0} ${el.x + el.w / 2} ${el.y + el.h / 2})"`
      if (el.type === 'image') return `<image x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" href="${esc(el.src.startsWith('asset:') ? deck.assets[el.src.slice(6)] : el.src)}" preserveAspectRatio="xMidYMid slice" ${transform}/>`
      if (el.type === 'shape') {
        let fill = esc(el.fill), defs = ''
        if (el.fillGradient) {
          const gradient = `g-${index}`
          defs = `<defs><linearGradient id="${gradient}" x2="1" y2="1">${el.fillGradient.stops.map(stop => `<stop offset="${stop.at}" stop-color="${esc(stop.color)}"/>`).join('')}</linearGradient></defs>`
          fill = `url(#${gradient})`
        }
        const attrs = `fill="${fill}" stroke="${esc(el.stroke)}" stroke-width="${el.strokeWidth}" ${transform}`
        if (el.shape === 'ellipse') return defs + `<ellipse cx="${el.x + el.w / 2}" cy="${el.y + el.h / 2}" rx="${el.w / 2}" ry="${el.h / 2}" ${attrs}/>`
        if (el.shape === 'triangle') return defs + `<polygon points="${el.x + el.w / 2},${el.y} ${el.x + el.w},${el.y + el.h} ${el.x},${el.y + el.h}" ${attrs}/>`
        return defs + `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" rx="${el.radius ?? 0}" ${attrs}/>`
      }
      if (el.type !== 'text') return ''
      const lines = galleryTextLines(el.html)
      const x = el.x + (el.align === 'center' ? el.w / 2 : el.align === 'right' ? el.w : 0)
      return `<text font-family="${esc(el.fontFamily)}" font-size="${el.fontSize}" font-weight="${el.fontWeight}" fill="${esc(el.color)}" text-anchor="${el.align === 'center' ? 'middle' : el.align === 'right' ? 'end' : 'start'}" letter-spacing="${el.letterSpacing ?? 0}" ${transform}>${lines.map((line,i) => `<tspan x="${x}" y="${el.y + el.fontSize * .85 + i * el.fontSize * (el.lineHeight ?? 1.3)}">${esc(line)}</tspan>`).join('')}</text>`
    }).join('')
    const fontCss = (deck.fonts ?? []).map(font => `@font-face{font-family:${JSON.stringify(font.family)};src:url(${JSON.stringify(deck.assets[font.asset])});font-weight:${font.weight ?? 'normal'}}`).join('')
    writeFileSync(join(dest, `${id}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><!-- Bento gallery, MIT; photo and OFL font credits alongside this file. --><style>${esc(fontCss)}</style><rect width="1280" height="720" fill="${esc(slide.background)}"/>${nodes}</svg>\n`)
  }
}
