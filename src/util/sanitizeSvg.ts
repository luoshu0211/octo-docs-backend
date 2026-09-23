import createDOMPurify from 'dompurify'
import { JSDOM } from 'jsdom'

const window = new JSDOM('', { contentType: 'text/html' }).window
const purify = createDOMPurify(window)

const FORBIDDEN_TAGS = [
  'script',
  'foreignObject',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'style',
  'link',
  'meta',
]

const URL_ATTRS = new Set(['href', 'xlink:href', 'src'])
const SAFE_FRAGMENT = /^#[A-Za-z_][\w:.-]*$/
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i

// JSDOM expands each XML element into a heavyweight object. A shared 10 MiB image cap is unsafe
// for SVG: a flat document near that size can exhaust Node's heap before sanitation completes.
// These limits are enforced synchronously before either parser sees the input, and again after
// serialization. 1 MiB still covers normal authored vector assets while bounding parser memory.
export const MAX_SANITIZED_SVG_BYTES = 1024 * 1024
const MAX_SVG_ELEMENTS = 12_000
const MAX_SVG_DEPTH = 128
const MAX_SVG_ATTRIBUTES = 60_000
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const USE_TARGET_TAGS = new Set(['svg', 'symbol', 'g', 'switch', 'use', 'path', 'rect', 'circle',
  'ellipse', 'line', 'polyline', 'polygon', 'text', 'image', 'a'])

// Inline style is useful in SVG authoring tools, but it must not become a
// general-purpose CSS injection surface. These are presentation-only SVG/CSS
// properties; layout, resource loading, animation and custom properties are
// deliberately absent.
const SAFE_STYLE_PROPERTIES = new Set([
  'color',
  'display',
  'visibility',
  'opacity',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-opacity',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'paint-order',
  'vector-effect',
  'stop-color',
  'stop-opacity',
  'flood-color',
  'flood-opacity',
  'lighting-color',
  'color-interpolation',
  'color-interpolation-filters',
  'shape-rendering',
  'text-rendering',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'font-stretch',
  'letter-spacing',
  'word-spacing',
  'text-anchor',
  'dominant-baseline',
])

// Presentation attributes can contain CSS paint/resource syntax too (for
// example fill="url(https://...)"), so apply the same active-token check to
// them as to inline declarations.
const PRESENTATION_ATTRS = new Set([...SAFE_STYLE_PROPERTIES, 'filter', 'clip-path', 'mask',
  'marker', 'marker-start', 'marker-mid', 'marker-end'])

export class InvalidSvgError extends Error {
  readonly code = 'invalid_svg'

  constructor(message = 'invalid_svg') {
    super(message)
    this.name = 'InvalidSvgError'
  }
}

function hasUnsafeUrl(value: string): boolean {
  const trimmed = value.trim()
  return trimmed !== '' && !SAFE_FRAGMENT.test(trimmed) && !SAFE_DATA_IMAGE.test(trimmed)
}

/** Decode CSS escapes only for security-token detection. */
function cssSecurityText(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\([^\r\n\f0-9a-f])/gi, '$1')
    .replace(/\s+/g, '')
    .split('')
    .filter(char => {
      const code = char.charCodeAt(0)
      return code > 31 && code !== 127
    })
    .join('')
    .toLowerCase()
}

function hasActiveCss(value: string): boolean {
  const normalized = cssSecurityText(value)
  if (normalized.includes('expression(') || normalized.includes('@import')) return true
  if (!normalized.includes('url(')) return false

  // SVG gradients, masks, clips and filters use same-document url(#id) references. Preserve those
  // while rejecting every external/data/javascript URL (including CSS-escaped/comment-split url).
  const urls = [...normalized.matchAll(/url\(([^)]*)\)/g)]
  if (urls.length === 0) return true // malformed/obfuscated url( token: fail closed
  const withoutUrls = normalized.replace(/url\([^)]*\)/g, '')
  if (withoutUrls.includes('url(')) return true
  return urls.some((match) => {
    const target = match[1] ?? ''
    const unquoted = (target.startsWith('"') && target.endsWith('"')) ||
      (target.startsWith("'") && target.endsWith("'"))
      ? target.slice(1, -1)
      : target
    return !SAFE_FRAGMENT.test(unquoted)
  })
}

function assertSvgComplexity(source: string): void {
  let elements = 0
  let attributes = 0
  let depth = 0
  let maxDepth = 0
  const tagRe = /<\s*(\/?)\s*([A-Za-z][\w:.-]*)([^<>]*?)(\/?)\s*>/g
  for (const match of source.matchAll(tagRe)) {
    if (match[1]) {
      depth = Math.max(0, depth - 1)
      continue
    }
    elements += 1
    // Count lexical name=value pairs conservatively. False positives only reject an unusually
    // complex asset before parsing; false negatives remain bounded by byte/element/depth limits.
    attributes += [...(match[3] ?? '').matchAll(/(?:^|\s)[^\s=/>]+\s*=/g)].length
    if (!match[4]) {
      depth += 1
      maxDepth = Math.max(maxDepth, depth)
    }
    if (elements > MAX_SVG_ELEMENTS || attributes > MAX_SVG_ATTRIBUTES || maxDepth > MAX_SVG_DEPTH) {
      throw new InvalidSvgError('svg_too_complex')
    }
  }
  if (elements === 0) throw new InvalidSvgError()
}

function sanitizeInlineStyle(raw: string): string | null {
  // Reject active constructs before parsing. This also catches escaped spellings
  // such as u\\72l(...) which a naive substring check would miss.
  if (hasActiveCss(raw)) return null

  const parsed = window.document.createElement('div').style
  parsed.cssText = raw
  const safe: string[] = []
  for (let i = 0; i < parsed.length; i += 1) {
    const property = parsed.item(i).toLowerCase()
    const value = parsed.getPropertyValue(property).trim()
    if (!SAFE_STYLE_PROPERTIES.has(property) || !value || hasActiveCss(value)) continue
    const priority = parsed.getPropertyPriority(property) === 'important' ? ' !important' : ''
    safe.push(`${property}: ${value}${priority}`)
  }
  return safe.length > 0 ? `${safe.join('; ')};` : null
}

/** URL fragments percent-decode valid byte sequences, preserving literal malformed percent signs. */
function decodeFragmentId(fragment: string): string {
  const encoded = Buffer.from(fragment, 'utf8')
  const decoded: number[] = []
  for (let i = 0; i < encoded.length; i += 1) {
    const hex = encoded.subarray(i + 1, i + 3).toString('latin1')
    if (encoded[i] === 0x25 && /^[0-9a-f]{2}$/i.test(hex)) {
      decoded.push(Number.parseInt(hex, 16))
      i += 2
    } else {
      decoded.push(encoded[i]!)
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(decoded))
  } catch {
    // Browsers may apply legacy encodings to invalid UTF-8 fragments. Reject the ambiguity.
    throw new InvalidSvgError()
  }
}

/** Keep native use semantics, but validate and bound the browser's expanded tree. */
function validateUseReferences(root: Element): void {
  const elements = [root, ...Array.from(root.querySelectorAll('*'))]
  const ids = new Map<string, Element | null>()
  for (const el of elements) {
    const id = el.getAttribute('id')
    if (id) ids.set(id, ids.has(id) ? null : el)
  }
  const targets = new Map<Element, Element>()
  for (const el of elements) {
    if (el.localName !== 'use') continue
    // SVG2 href wins over legacy xlink:href. Emit one unambiguous reference.
    const href = (el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? '').trim()
    if (!href.startsWith('#') || href.length < 2 || /\s/u.test(href)) throw new InvalidSvgError()
    const id = decodeFragmentId(href.slice(1))
    const target = ids.get(id)
    if (!target || target.namespaceURI !== SVG_NAMESPACE || !USE_TARGET_TAGS.has(target.localName)) {
      throw new InvalidSvgError()
    }
    // Canonical UTF-8 ensures the browser resolves exactly the ID whose expansion we measured.
    el.setAttribute('href', '#' + encodeURIComponent(id))
    el.removeAttributeNS('http://www.w3.org/1999/xlink', 'href')
    targets.set(el, target)
  }
  if (targets.size === 0) return

  type Cost = { nodes: number; attributes: number; depth: number; bytes: number }
  const memo = new Map<Element, Cost>()
  const visiting = new Set<Element>()
  function measure(el: Element): Cost {
    if (visiting.has(el) || visiting.size >= MAX_SVG_DEPTH) throw new InvalidSvgError('svg_too_complex')
    const saved = memo.get(el)
    if (saved) return saved
    visiting.add(el)
    // Count attribute values and direct text at every expanded instance. Node counts alone let a
    // tiny use graph multiply one long path/text/image into unbounded browser rendering work.
    const ownBytes = Array.from(el.attributes).reduce((sum, attr) =>
      sum + Buffer.byteLength(attr.name) + Buffer.byteLength(attr.value), 0) +
      Array.from(el.childNodes).reduce((sum, child) =>
        sum + (child.nodeType === 3 || child.nodeType === 4 ? Buffer.byteLength(child.nodeValue ?? '') : 0), 0)
    const cost = { nodes: 1, attributes: el.attributes.length, depth: 1, bytes: ownBytes }
    const descendants = Array.from(el.children)
    const target = targets.get(el)
    if (target) descendants.push(target)
    for (const child of descendants) {
      const next = measure(child)
      cost.nodes += next.nodes
      cost.attributes += next.attributes
      cost.bytes += next.bytes
      cost.depth = Math.max(cost.depth, next.depth + 1)
      if (cost.nodes > MAX_SVG_ELEMENTS || cost.attributes > MAX_SVG_ATTRIBUTES ||
        cost.depth > MAX_SVG_DEPTH || cost.bytes > MAX_SANITIZED_SVG_BYTES) {
        throw new InvalidSvgError('svg_too_complex')
      }
    }
    visiting.delete(el)
    memo.set(el, cost)
    return cost
  }
  measure(root)
}

/**
 * Sanitize an uploaded SVG before it reaches object storage.
 *
 * SVG is active XML: scripts, event handlers, foreignObject, CSS and external
 * resource references can turn an inline image into stored XSS or a tracking /
 * SSRF primitive. DOMPurify performs the structural allow-list pass; the second
 * pass permits only presentation declarations in inline style and removes all
 * active CSS/resource references. Stylesheet elements remain forbidden.
 */
export function sanitizeSvg(input: Buffer): Buffer {
  if (input.length === 0 || input.length > MAX_SANITIZED_SVG_BYTES) {
    throw new InvalidSvgError(input.length > MAX_SANITIZED_SVG_BYTES ? 'svg_too_large' : 'invalid_svg')
  }
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(input)
  } catch {
    throw new InvalidSvgError()
  }
  if (!source.trim() || /<!DOCTYPE|<!ENTITY/i.test(source)) {
    throw new InvalidSvgError()
  }
  assertSvgComplexity(source)

  const clean = purify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: FORBIDDEN_TAGS,
    ADD_TAGS: ['use'],
    ADD_ATTR: ['style'],
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    RETURN_DOM: false,
  })

  let dom: JSDOM
  try {
    dom = new JSDOM(clean, { contentType: 'image/svg+xml' })
  } catch {
    throw new InvalidSvgError()
  }
  const root = dom.window.document.documentElement
  if (root.localName.toLowerCase() !== 'svg' || root.namespaceURI !== SVG_NAMESPACE) {
    throw new InvalidSvgError()
  }

  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name)
        continue
      }
      if (name === 'style') {
        const safeStyle = sanitizeInlineStyle(attr.value)
        if (safeStyle) el.setAttribute(attr.name, safeStyle)
        else el.removeAttribute(attr.name)
        continue
      }
      // use references get stricter target/graph validation below, including
      // Unicode and percent-encoded IDs that are valid local SVG fragments.
      if (el.localName === 'use' && (name === 'href' || name === 'xlink:href')) continue
      if (URL_ATTRS.has(name) && hasUnsafeUrl(attr.value)) {
        el.removeAttribute(attr.name)
        continue
      }
      if (PRESENTATION_ATTRS.has(name) && hasActiveCss(attr.value)) {
        el.removeAttribute(attr.name)
      }
    }
  }

  validateUseReferences(root)
  const serialized = root.outerHTML
  const outputBytes = Buffer.byteLength(serialized, 'utf8')
  if (!serialized || outputBytes > MAX_SANITIZED_SVG_BYTES || outputBytes > input.length * 4 + 4096) {
    throw new InvalidSvgError(outputBytes > MAX_SANITIZED_SVG_BYTES ? 'svg_too_large' : 'invalid_svg')
  }
  return Buffer.from(serialized, 'utf8')
}
