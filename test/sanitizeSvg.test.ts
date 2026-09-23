import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { sanitizeSvg, InvalidSvgError, MAX_SANITIZED_SVG_BYTES } from '../src/util/sanitizeSvg.js'

const clean = (svg: string) => sanitizeSvg(Buffer.from(svg)).toString('utf8')

describe('sanitizeSvg', () => {
  it('preserves ordinary vector content', () => {
    const out = clean('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Logo</title><path d="M0 0h10v10z" fill="#123456"/></svg>')
    expect(out).toContain('<svg')
    expect(out).toContain('<path')
    expect(out).toContain('<title>Logo</title>')
    expect(out).toContain('fill="#123456"')
  })

  it('preserves safe presentation declarations from authoring-tool inline styles', () => {
    const out = clean(`<svg xmlns="http://www.w3.org/2000/svg" style="fill:#f4f1de">
      <rect width="10" height="10" style="fill:#e07a5f;stroke:#3d405b;stroke-width:2;opacity:.75;vector-effect:non-scaling-stroke"/>
      <text style="font-family:sans-serif;font-size:12px;font-weight:700;text-anchor:middle;letter-spacing:1px">A</text>
    </svg>`)

    expect(out).toMatch(/style="[^"]*fill: rgb\(244, 241, 222\)/)
    expect(out).toMatch(/style="[^"]*fill: rgb\(224, 122, 95\)/)
    expect(out).toMatch(/style="[^"]*stroke: rgb\(61, 64, 91\)/)
    expect(out).toMatch(/style="[^"]*stroke-width: 2/)
    expect(out).toMatch(/style="[^"]*opacity: 0\.75/)
    expect(out).toMatch(/style="[^"]*vector-effect: non-scaling-stroke/)
    expect(out).toMatch(/style="[^"]*font-family: sans-serif/)
    expect(out).toMatch(/style="[^"]*text-anchor: middle/)
  })

  it('removes scripts, events, foreignObject, stylesheets, and external URLs', () => {
    const out = clean(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(1)</script><style>@import url(https://evil.test/x)</style>
      <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
      <image href="https://evil.test/pixel.png"/>
      <a href="javascript:alert(1)"><path fill="url(https://evil.test/paint)"/></a>
    </svg>`)
    expect(out).not.toMatch(/script|foreignObject|onload|javascript:|https:\/\/evil|@import/i)
    expect(out).not.toContain('<use')
    expect(out).not.toContain('fill="url(')
  })

  it('preserves same-document gradient/filter references while stripping external CSS URLs', () => {
    const out = clean(`<svg xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g"><stop stop-color="red"/></linearGradient><filter id="f"><feGaussianBlur stdDeviation="1"/></filter></defs>
      <rect id="attrs" fill="url(#g)" filter="url('#f')"/>
      <rect class="style-local" style="fill:url(#g);stroke:url('#g')"/>
      <rect id="external" fill="url(https://evil.test/paint)" style="filter:u\\72l(https://evil.test/filter)"/>
    </svg>`)
    const dom = new JSDOM(out, { contentType: 'image/svg+xml' }).window.document
    expect(dom.getElementById('attrs')?.getAttribute('fill')).toBe('url(#g)')
    expect(dom.getElementById('attrs')?.getAttribute('filter')).toBe("url('#f')")
    const localStyle = dom.querySelector('.style-local')?.getAttribute('style')
    expect(localStyle).toMatch(/fill: url\(["']?#g["']?\)/)
    expect(localStyle).toMatch(/stroke: url\(["']?#g["']?\)/)
    expect(dom.getElementById('external')?.hasAttribute('fill')).toBe(false)
    expect(dom.getElementById('external')?.hasAttribute('style')).toBe(false)
    expect(out).not.toContain('evil.test')
  })

  it('keeps safe declarations while deleting disallowed CSS, and drops active CSS wholesale', () => {
    const out = clean(`<svg xmlns="http://www.w3.org/2000/svg">
      <path id="safe" style="fill:#e07a5f;stroke:#3d405b;position:fixed;background-image:none;--x:red"/>
      <path id="url" style="fill:red;stroke:url(https://evil.test/p)"/>
      <path id="escaped-url" style="fill:u\\72l(https://evil.test/p)"/>
      <path id="expression" style="opacity:1;fill:expre\\73 sion(alert(1))"/>
      <path id="import" style="@import 'https://evil.test/x';fill:blue"/>
    </svg>`)

    const dom = new JSDOM(out, { contentType: 'image/svg+xml' }).window.document
    const safe = dom.getElementById('safe')?.getAttribute('style') ?? ''
    expect(safe).toContain('fill: rgb(224, 122, 95)')
    expect(safe).toContain('stroke: rgb(61, 64, 91)')
    expect(safe).not.toMatch(/position|background|--x/)
    for (const id of ['url', 'escaped-url', 'expression', 'import']) {
      expect(dom.getElementById(id)?.hasAttribute('style')).toBe(false)
    }
    expect(out).not.toMatch(/url\s*\(|expression\s*\(|@import|evil\.test/i)
  })

  it('rejects oversized, overly complex, deeply nested, and invalid UTF-8 SVG before parsing', () => {
    const oversized = Buffer.alloc(MAX_SANITIZED_SVG_BYTES + 1, 0x20)
    expect(() => sanitizeSvg(oversized)).toThrow(/svg_too_large/)

    const manyElements = `<svg xmlns="http://www.w3.org/2000/svg">${'<g/>'.repeat(12_001)}</svg>`
    expect(() => clean(manyElements)).toThrow(/svg_too_complex/)

    const deep = `<svg xmlns="http://www.w3.org/2000/svg">${'<g>'.repeat(129)}${'</g>'.repeat(129)}</svg>`
    expect(() => clean(deep)).toThrow(/svg_too_complex/)

    expect(() => sanitizeSvg(Buffer.from([0xff, 0xfe, 0xfd]))).toThrow(InvalidSvgError)
  })

  it('rejects doctype/entity payloads and non-SVG documents', () => {
    expect(() => clean('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>')).toThrow(InvalidSvgError)
    expect(() => clean('<html><body>x</body></html>')).toThrow(InvalidSvgError)
  })

  it('preserves local use geometry, transforms, paint and symbol viewports', () => {
    const out = clean(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">
      <defs><path id="petal" d="M0 0h10v10z"/><symbol id="badge" viewBox="0 0 10 10"><use href="#petal"/></symbol></defs>
      <use xlink:href="#petal" x="10" y="20" transform="rotate(30)" fill="red"/>
      <use href="#badge" x="40" y="30" width="50" height="50"/>
    </svg>`)
    const doc = new JSDOM(out, { contentType: 'image/svg+xml' }).window.document
    expect(doc.querySelectorAll('use')).toHaveLength(3)
    const petal = doc.documentElement.children[1]!
    expect(petal.getAttribute('href')).toBe('#petal')
    expect(petal.getAttribute('transform')).toBe('rotate(30)')
    expect(petal.getAttribute('fill')).toBe('red')
    expect(petal.getAttribute('x')).toBe('10')
    expect(doc.getElementById('badge')?.getAttribute('viewBox')).toBe('0 0 10 10')
    expect(doc.documentElement.children[2]?.getAttribute('width')).toBe('50')
  })

  it.each(['https://evil.test/s.svg#p', '//evil.test/x', 'data:image/svg+xml;base64,PHN2Zy8+', 'javascript:alert(1)', '#missing'])('rejects unsupported use references instead of storing a partial image: %s', href => {
    expect(() => clean(`<svg xmlns="http://www.w3.org/2000/svg"><use href="${href}"/></svg>`)).toThrow(InvalidSvgError)
  })

  it('rejects ambiguous targets and reference cycles', () => {
    for (const body of [
      '<path id="p"/><rect id="p"/><use href="#p"/>',
      '<use id="a" href="#a"/>',
      '<use id="a" href="#b"/><use id="b" href="#a"/>',
      '<g id="a"><g><use href="#a"/></g></g>',
      '<defs><linearGradient id="paint"/></defs><use href="#paint"/>',
    ]) expect(() => clean(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`)).toThrow(InvalidSvgError)
  })

  it('bounds expanded reference graphs, not only serialized size', () => {
    const defs = ['<g id="n0"><rect width="1" height="1"/></g>']
    for (let i = 1; i < 16; i++) defs.push(`<g id="n${i}"><use href="#n${i - 1}"/><use href="#n${i - 1}"/></g>`)
    expect(() => clean(`<svg xmlns="http://www.w3.org/2000/svg"><defs>${defs.join('')}</defs><use href="#n15"/></svg>`)).toThrow(/svg_too_complex/)
  })

  it.each([
    ['a%b', '#a%b'], ['a%20b', '#a%2520b'], ['图标', '#%E5%9B%BE%E6%A0%87'],
    ['a+b', '#a+b'], ['a&b', '#a&amp;b'], ['a%图', '#a%%E5%9B%BE'],
  ])('retains browser-compatible local fragment IDs: %s', (id, href) => {
    const escapedId = id.replaceAll('&', '&amp;')
    const out = clean(`<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="${escapedId}" d="M0 0h10v10z"/></defs><use href="${href}"/></svg>`)
    expect(new JSDOM(out, { contentType: 'image/svg+xml' }).window.document.querySelectorAll('use')).toHaveLength(1)
  })

  it('rejects ambiguous invalid UTF-8 and preserves BOM characters in fragment IDs', () => {
    expect(() => clean('<svg xmlns="http://www.w3.org/2000/svg"><path id="�"/><path id="ÿ"/><use href="#%FF"/></svg>')).toThrow(InvalidSvgError)
    expect(() => clean('<svg xmlns="http://www.w3.org/2000/svg"><path id="p"/><use href="#%EF%BB%BFp"/></svg>')).toThrow(InvalidSvgError)
    expect(() => clean('<svg xmlns="http://www.w3.org/2000/svg"><path id="&#xFEFF;p"/><use href="#%EF%BB%BFp"/></svg>')).toThrow(InvalidSvgError)
    expect(clean('<svg xmlns="http://www.w3.org/2000/svg"><path id="a&#xFEFF;p"/><use href="#a%EF%BB%BFp"/></svg>')).toContain('href="#a%EF%BB%BFp"')
    expect(clean('<svg xmlns="http://www.w3.org/2000/svg"><path id="a%b"/><use href="#a%b"/></svg>')).toContain('href="#a%25b"')
  })

  it('preserves references to SVG switch elements', () => {
    expect(clean('<svg xmlns="http://www.w3.org/2000/svg"><defs><switch id="p"><rect width="10" height="10"/></switch></defs><use href="#p"/></svg>')).toContain('<use href="#p"')
  })

  it.each([
    `<path id="p" d="M0 0${'l1 1l-1 -1'.repeat(30000)}"/>`,
    `<text id="p">${'文'.repeat(100000)}</text>`,
  ])('bounds repeated long attribute values and text', target => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${target}</defs>${'<use href="#p"/>'.repeat(5000)}</svg>`
    expect(Buffer.byteLength(source)).toBeLessThan(MAX_SANITIZED_SVG_BYTES)
    expect(() => clean(source)).toThrow(/svg_too_complex/)
  })

  it('bounds long acyclic use chains', () => {
    const chain = Array.from({ length: 130 }, (_, i) => `<use id="n${i}" href="#n${i + 1}"/>`).join('')
    expect(() => clean(`<svg xmlns="http://www.w3.org/2000/svg">${chain}<path id="n130"/></svg>`)).toThrow(/svg_too_complex/)
  })

  it('retains href precedence and strips active content from referenced groups', () => {
    const out = clean(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <g id="safe" onload="alert(1)"><script>alert(1)</script><rect width="10" height="10"/></g>
      <use href="#safe" xlink:href="https://evil.test/x" onclick="alert(1)"/>
    </svg>`)
    expect(out).toContain('<use href="#safe"')
    expect(out).not.toMatch(/script|onclick|onload|evil.test/)
  })
})
