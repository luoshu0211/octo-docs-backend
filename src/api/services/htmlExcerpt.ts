/**
 * HTML → first-screen text excerpt (pure function, zero IO, zero deps).
 *
 * Feeds the type-18 DocumentShareCard preview: a forwarded HTML doc needs a few
 * lines of plain text, NOT its markup. Keeping this a pure string→object function
 * is deliberate — it is the only part of the preview path that touches
 * attacker-authored bytes, so it must be trivially testable in isolation.
 *
 * ── Why hand-rolled index scanning instead of regex ──────────────────────────
 * The input is a document body: attacker-controllable, up to the fetch cap
 * (256KB, see htmlPreviewFetch.ts). A regex like /<script[\s\S]*?<\/script>/ on a
 * malformed run with no closing tag backtracks to end-of-string from every start
 * position — O(n²) polynomial ReDoS (CodeQL js/polynomial-redos), the same class
 * of bug docsNotify.ts's MENTION_TOKEN_RE bounds away with {1,128}/{0,256}.
 *
 * Here the spans are unbounded by nature (a <script> body can legitimately be
 * huge), so bounding a quantifier would silently mis-parse real documents.
 * Instead every scan below is a forward indexOf walk: strictly linear, and an
 * unterminated tag simply ends the walk. The one regex in this file (entity
 * decoding) has a fixed, closed alternation with no nested quantifier.
 *
 * We never return raw HTML to a client — only decoded plain text.
 *
 * ⚠️ "Plain text" is not "markup-free-looking": the output can legitimately
 * contain `<`, `>` and `&` — from decoded entities (`&lt;` → `<`) and from prose
 * that a browser also renders literally (`5 < 10`). CONSUMERS MUST RENDER
 * `heading`/`paragraphs` AS TEXT (textContent / a framework's text interpolation),
 * NEVER via innerHTML or an equivalent HTML sink. Extraction here is not, and
 * cannot be, a substitute for output encoding at the render site.
 */

/**
 * Hard cap on the input we will even look at. The fetch layer already truncates
 * at 256KB; this is the independent guarantee for a direct caller (and for the
 * unit tests), so no input size can turn the scan into a visible cost.
 */
const MAX_INPUT_CHARS = 512 * 1024

/** Hard cap on the returned heading. A real title never approaches this. */
const MAX_HEADING_CHARS = 200

/** Hard cap on each returned paragraph. */
const MAX_PARAGRAPH_CHARS = 300

/** How many text blocks the card shows. First screen only — three is the design. */
const MAX_PARAGRAPHS = 3

/**
 * Overall ceiling on the emitted payload (heading + paragraphs). The per-field
 * caps already bound this arithmetically (200 + 3*300); this is the belt-and-
 * braces total so a future bump to either cap cannot silently grow the card body.
 */
const MAX_TOTAL_CHARS = 1200

/**
 * Cap on the number of text blocks we will collect before giving up. We only
 * need MAX_PARAGRAPHS non-empty ones, but a document can open with thousands of
 * empty/whitespace blocks; bounding the scan keeps the walk short on pathological
 * markup instead of splitting the whole document.
 */
const MAX_BLOCKS_SCANNED = 5000

/**
 * Block separator stripTags injects where a BLOCK-LEVEL tag used to be. U+0000
 * cannot occur in real document text, so splitting on it separates blocks exactly
 * at element boundaries. A literal '\n' would NOT work: source HTML is full of
 * newlines INSIDE a paragraph, and splitting on those shreds one paragraph into
 * several.
 */
const BLOCK_SEP = '\u0000'

/**
 * Elements that START A NEW TEXT BLOCK. Everything NOT listed here is treated as
 * INLINE and is erased without injecting a separator.
 *
 * ── Why this list has to exist ───────────────────────────────────────────────
 * An earlier version injected BLOCK_SEP at EVERY tag. That shreds ordinary prose,
 * because real rich text is full of inline formatting:
 *
 *   `<p>Welcome to <b>Octo Docs</b>, the future of <a href="#">writing</a>.</p>`
 *
 * became THREE "paragraphs" (`Welcome to` / `Octo Docs` / `, the future of`) —
 * and since the card only shows MAX_PARAGRAPHS blocks, the fragments filled the
 * quota and the sentence's tail (`writing.`) was dropped entirely, along with
 * every following paragraph. A browser renders that markup as ONE line, because
 * `<b>`/`<a>` do not break the line box; so must we.
 *
 * (The heading path never showed this: firstElementText normalizes AFTER
 * stripping, and normalizeWhitespace folds BLOCK_SEP away as whitespace. The
 * paragraph path splits BEFORE normalizing, which is why only it was affected.)
 *
 * ── Membership rules ─────────────────────────────────────────────────────────
 * In  — anything that generates a line break in normal flow: flow containers,
 *       list/table/definition parts, sectioning elements, `pre`, `hr`, `form`
 *       parts. `title`/`head`/`html`/`body` are in as well: they are never inline
 *       text, and `title` in particular must not glue an SVG a11y label onto the
 *       prose that follows it.
 * Out — `b/i/em/strong/span/a/code/small/sub/sup/mark/u/s/…` and any element we
 *       do not know (custom elements, `<scriptish>`, SVG `<g>`/`<text>`). Unknown
 *       elements default to inline, which is exactly what a browser does with an
 *       unrecognised tag.
 *
 * `br` is here even though it is a VOID element — it is a line break, so it must
 * split, and there is no `</br>` to pair with. Nothing in this file pairs block
 * tags, so void elements need no special handling: each tag is judged on its own.
 * `img` is NOT here: it is inline, and `a <img> b` is one line.
 *
 * `text` is SVG's, not HTML's (HTML has no such element, so there is no clash).
 * Two `<text>` runs are separately positioned boxes, not one word — SVG's inline
 * unit is `<tspan>`, which is correctly absent from this list.
 */
const BLOCK_LEVEL: ReadonlySet<string> = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'br', 'caption', 'dd',
  'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr',
  'html', 'legend', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary',
  'table', 'tbody', 'td', 'text', 'tfoot', 'th', 'thead', 'title', 'tr', 'ul',
])

/**
 * Dropped elements, split by HOW THE HTML PARSER TERMINATES THEM. The split is
 * load-bearing — do NOT merge these two lists into one "dropped" list.
 *
 * ── RAW_TEXT_DROPPED: terminated by the FIRST matching close tag ─────────────
 * These are raw text / escapable raw text elements (HTML §13.2.5): once the
 * parser enters them it stops recognising tags entirely and only looks for the
 * matching end tag. A `<script>` written INSIDE a `<script>` body is just
 * characters — it does NOT open a nested element — so "stop at the first
 * `</script>`" is not an approximation, it is exactly what a browser does.
 * Depth-counting these would be WRONG: it would swallow the real document text
 * that follows.
 *
 * script/style  — code/styling, obviously not text.
 * noscript      — with the scripting flag ENABLED (what every preview consumer
 *                 runs), noscript is parsed as raw text too, so it likewise does
 *                 not nest. Verified against a real parser: for
 *                 `<noscript>O<noscript>I</noscript>NS_LEAK</noscript>` the DOM
 *                 contains ONE noscript whose content is the literal text
 *                 `O<noscript>I`, and `NS_LEAK` is VISIBLE body text. Depth
 *                 matching here would eat visible prose.
 *                 (We still drop the raw-text part itself: it is the "请开启
 *                 JavaScript…" boilerplate, pure noise as a first paragraph.)
 *
 * ── NESTABLE_DROPPED: terminated by DEPTH matching ───────────────────────────
 * template      — a NORMAL element: its children are parsed as markup into an
 *                 inert DocumentFragment, so `<template>` DOES nest. Stopping at
 *                 the first `</template>` lets an inner one close the outer early
 *                 and leaks the remainder as prose (measured). A browser renders
 *                 NONE of it — template content is never displayed — so the whole
 *                 depth-matched span must go.
 *
 * ── Deliberately NOT dropped ─────────────────────────────────────────────────
 * object/canvas — their fallback content IS genuinely rendered when the resource
 *                 fails to load or the tag is unsupported. Dropping it can erase
 *                 text a real reader sees. Do NOT add these.
 * svg/math      — foreign subtrees are NOT dropped either: SVG `<text>` (and
 *                 anything inside `<foreignObject>`) is visible prose. Only the
 *                 `<title>` inside them is special-cased, and only as a HEADING
 *                 candidate — see FOREIGN_ROOTS.
 * iframe        — TODO(evaluate): modern browsers ignore iframe fallback content,
 *                 so it is arguably droppable. Not added this round: it is not a
 *                 common preview-pollution source, and every addition to these
 *                 lists needs its own visibility argument (see object/canvas).
 */
const RAW_TEXT_DROPPED = ['script', 'style', 'noscript'] as const
const NESTABLE_DROPPED = ['template'] as const
const DROPPED_ELEMENTS = [...RAW_TEXT_DROPPED, ...NESTABLE_DROPPED] as const

/**
 * Foreign-content roots. A `<title>` inside one of these is NOT the document
 * title — in SVG/MathML it is an accessibility label (tooltip). A real parser
 * reports `document.title === ''` for `<svg><title>X</title></svg>`, so putting X
 * in the card's title slot invents a heading the document never had.
 *
 * These subtrees are NOT dropped — only `<title>` inside them is skipped when
 * choosing the heading.
 */
const FOREIGN_ROOTS = ['svg', 'math'] as const

/** The heading elements we accept, in document order of preference is N/A — first wins. */
const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const

export interface HtmlExcerpt {
  heading?: string
  paragraphs: string[]
}

/**
 * Basic named/numeric entities. A closed alternation with no nested quantifier —
 * cannot backtrack. Deliberately NOT a general `&#\d+;` decoder: this output is
 * plain text for a card, and decoding arbitrary numeric references would let a
 * document reconstruct markup-looking text we never intended to emit.
 */
const ENTITY_RE = /&(amp|lt|gt|quot|apos|#39|nbsp);/g

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  // NBSP decodes to a PLAIN space, not U+00A0: the value is going into a card
  // label, where a stray non-breaking space shows up as an invisible oddity in
  // trimming/normalization downstream.
  nbsp: ' ',
}

/** Decode the small fixed entity set. Unknown entities are left verbatim. */
export function decodeEntities(input: string): string {
  return input.replace(ENTITY_RE, (all, name: string) => ENTITY_MAP[name] ?? all)
}

/** Collapse all whitespace runs to single spaces and trim. */
function normalizeWhitespace(input: string): string {
  let out = ''
  let pendingSpace = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    // \u00a0 is NBSP; treat it as whitespace so an entity-decoded document does
    // not emit a "paragraph" made entirely of non-breaking spaces.
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\u00a0' || ch === BLOCK_SEP) {
      if (out !== '') pendingSpace = true
      continue
    }
    if (pendingSpace) {
      out += ' '
      pendingSpace = false
    }
    out += ch
  }
  return out
}

/**
 * Remove `<!-- ... -->` spans. Linear indexOf walk; an unterminated comment
 * swallows the rest of the document (which is exactly what a browser does).
 */
function stripComments(input: string): string {
  if (!input.includes('<!--')) return input
  let out = ''
  let cursor = 0
  for (;;) {
    const open = input.indexOf('<!--', cursor)
    if (open === -1) {
      out += input.slice(cursor)
      return out
    }
    out += input.slice(cursor, open)
    const close = input.indexOf('-->', open + 4)
    if (close === -1) return out
    cursor = close + 3
  }
}

/**
 * Find the index just past the `>` that closes the tag starting at `lt`, or -1
 * when the tag is never closed. Quote-aware so a `>` inside an attribute value
 * does not end the tag early.
 */
function endOfTag(input: string, lt: number): number {
  let quote = ''
  for (let i = lt + 1; i < input.length; i++) {
    const ch = input[i]!
    if (quote !== '') {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '>') return i + 1
  }
  return -1
}

/**
 * True when the tag opening at `lt` is `<name` (or `</name`) as a whole token —
 * i.e. followed by a delimiter, so `<script>` matches but `<scriptish>` does not.
 */
function tagNameAt(input: string, lt: number, name: string, closing: boolean): boolean {
  const start = lt + (closing ? 2 : 1)
  if (input.length < start + name.length) return false
  if (input.slice(start, start + name.length).toLowerCase() !== name) return false
  const next = input[start + name.length]
  return next === undefined || next === '>' || next === '/' || next === ' ' || next === '\t' || next === '\n' || next === '\r' || next === '\f'
}

/**
 * Index just past the first `</name>` at or after `from`, or -1. Raw-text
 * semantics: no nesting is possible, the first matching end tag wins.
 * An end tag with no `>` closes at end-of-input (a browser has nothing left).
 */
function endOfRawTextElement(input: string, from: number, name: string): number {
  let scan = from
  while (scan < input.length) {
    const nextLt = input.indexOf('</', scan)
    if (nextLt === -1) return -1
    if (tagNameAt(input, nextLt, name, true)) {
      const afterClose = endOfTag(input, nextLt)
      return afterClose === -1 ? input.length : afterClose
    }
    scan = nextLt + 2
  }
  return -1
}

/**
 * Index just past the `</name>` that closes the element opened before `from`,
 * counting nesting depth, or -1 when it never closes.
 *
 * Raw-text elements encountered inside are skipped wholesale, because their
 * contents are characters, not markup: in
 * `<template><script>"</template>"</script>REAL</template>` the `</template>`
 * inside the script is script source, and the element really ends at the second
 * one. Verified against a real parser (nothing there renders). Still a strictly
 * linear forward walk — every branch advances the cursor.
 */
function endOfNestableElement(input: string, from: number, name: string): number {
  let depth = 1
  let cursor = from
  while (cursor < input.length) {
    const lt = input.indexOf('<', cursor)
    if (lt === -1) return -1

    const raw = RAW_TEXT_DROPPED.find((n) => tagNameAt(input, lt, n, false))
    if (raw) {
      const afterOpen = endOfTag(input, lt)
      if (afterOpen === -1) return -1
      const end = endOfRawTextElement(input, afterOpen, raw)
      cursor = end === -1 ? input.length : end
      continue
    }

    if (tagNameAt(input, lt, name, true)) {
      depth--
      const afterClose = endOfTag(input, lt)
      if (depth === 0) return afterClose === -1 ? input.length : afterClose
      cursor = afterClose === -1 ? input.length : afterClose
      continue
    }

    if (tagNameAt(input, lt, name, false)) {
      const afterOpen = endOfTag(input, lt)
      if (afterOpen === -1) return -1
      // `<template/>` is not self-closing in HTML (only foreign content honours
      // that), so an open tag always increases depth.
      depth++
      cursor = afterOpen
      continue
    }

    cursor = lt + 1
  }
  return -1
}

/**
 * Drop `<script>`/`<style>`/`<noscript>`/`<template>` elements, content and all.
 * An element with no closing tag drops everything after it — same fail-safe
 * direction as a browser, and the conservative choice for an excerpt (better to
 * lose text than to emit JS source as if it were prose).
 *
 * Termination differs per element class; see DROPPED_ELEMENTS above.
 */
function stripDroppedElements(input: string): string {
  let out = ''
  let cursor = 0
  while (cursor < input.length) {
    const lt = input.indexOf('<', cursor)
    if (lt === -1) {
      out += input.slice(cursor)
      break
    }
    const dropped = DROPPED_ELEMENTS.find((name) => tagNameAt(input, lt, name, false))
    if (!dropped) {
      // Copy through this '<' and keep scanning; tag stripping happens later.
      out += input.slice(cursor, lt + 1)
      cursor = lt + 1
      continue
    }
    out += input.slice(cursor, lt)
    const afterOpen = endOfTag(input, lt)
    if (afterOpen === -1) return out // unterminated open tag: nothing usable follows
    const nestable = (NESTABLE_DROPPED as readonly string[]).includes(dropped)
    const closed = nestable
      ? endOfNestableElement(input, afterOpen, dropped)
      : endOfRawTextElement(input, afterOpen, dropped)
    if (closed === -1) return out // unterminated element: drop the remainder
    cursor = closed
  }
  return out
}

/** True for A-Z / a-z, the only characters that can begin an HTML tag name. */
function isAsciiAlpha(ch: string | undefined): boolean {
  if (ch === undefined) return false
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
}

/**
 * True when the `<` at `lt` actually OPENS A TAG, matching the tokenizer's data
 * state: `<` is markup only when followed by an ASCII letter, `/`+letter, `!` or
 * `?`. Anything else (`a < b`, `1<2`) is literal text.
 *
 * Load-bearing for the scan below, which advances tag-by-tag: without this a
 * bare `<` in prose would consume up to the next `>` and could step OVER a real
 * `<svg>`, losing a range we need.
 */
function startsTag(input: string, lt: number): boolean {
  const next = input[lt + 1]
  if (next === undefined) return false
  if (next === '/') return isAsciiAlpha(input[lt + 2])
  if (next === '!' || next === '?') return true
  return isAsciiAlpha(next)
}

/**
 * Lowercased tag name of the tag opening at `lt` (close tags included), or null
 * when this is not a named tag — `<!DOCTYPE>`, `<!--`-style bogus comments and
 * `<?…?>` processing instructions have no name.
 *
 * Only the name is read; attributes are the caller's problem (endOfTag).
 */
function tagNameOf(input: string, lt: number): string | null {
  let start = lt + 1
  if (input[start] === '/') start++
  if (!isAsciiAlpha(input[start])) return null
  let end = start
  while (end < input.length) {
    const ch = input[end]!
    if (ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') break
    end++
  }
  return input.slice(start, end).toLowerCase()
}

/** Index of the next `<` that begins a tag at or after `from`, or -1. */
function nextTagStart(input: string, from: number): number {
  let cursor = from
  while (cursor < input.length) {
    const lt = input.indexOf('<', cursor)
    if (lt === -1) return -1
    if (startsTag(input, lt)) return lt
    cursor = lt + 1
  }
  return -1
}

/**
 * SVG's HTML integration point. Its children are parsed in the HTML namespace,
 * so a `<title>` inside one IS the document title and the foreign ranges below
 * must have a hole punched in them for its content.
 */
const FOREIGN_ESCAPE = 'foreignobject'

/** Elements that switch namespace, innermost last. */
const NAMESPACE_TAGS = [...FOREIGN_ROOTS, FOREIGN_ESCAPE] as const

/**
 * Ranges in which a `<title>` is FOREIGN (an SVG/MathML a11y label), as
 * [start, end) index pairs over `input`. Used ONLY to reject `<title>` heading
 * candidates; text in these ranges still reaches paragraphs (SVG `<text>` is
 * visible prose).
 *
 * One linear pass over a stack of the only elements that change namespace:
 *
 *  - `<svg>`/`<math>`   push FOREIGN. They nest legitimately, so this cannot be
 *                       a "first close tag wins" scan.
 *  - `<foreignObject>`  pushes HTML — its content LEAVES foreign content. This
 *                       is why a real parser reports `document.title === 'X'`
 *                       for `<svg><foreignObject><title>X` but `''` for
 *                       `<svg><title>X`. A `<svg>` nested back inside a
 *                       foreignObject re-enters foreign content, so this has to
 *                       be a stack, not a boolean.
 *
 * We are foreign iff the INNERMOST such element is a foreign root. The stack is
 * heap-allocated rather than recursive on purpose: nesting depth is
 * attacker-controlled (256KB of `<svg><foreignObject>` is thousands of levels),
 * and recursion would turn that into a stack overflow.
 *
 * Scanning goes tag-by-tag through nextTagStart/endOfTag — the SAME quote-aware
 * `endOfTag` the rest of the file uses — so a literal `<svg>` in an ATTRIBUTE
 * VALUE (`<div data-x="<svg>">`) cannot open a phantom range that swallows the
 * real `<title>` after it. `<script>` bodies and comments are already gone by
 * this point (stripComments/stripDroppedElements), so they need no handling.
 *
 * Foreign content honours XML self-closing (`<svg/>`, `<foreignObject/>`), which
 * opens nothing. An unterminated `<svg>` encloses the rest of the document,
 * exactly as a parser would treat it.
 */
function foreignRanges(input: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const open: string[] = []
  // O(1) membership: how many of each namespace element are currently open. A
  // closing tag whose name has a zero count matches nothing on the stack, so it
  // is rejected WITHOUT walking `open` — the difference between linear and
  // quadratic on an adversarial `</math>` flood against a deep `<svg>` stack.
  // Kept in lockstep with `open`: every push/pop updates exactly one counter.
  const openCount = new Map<string, number>()
  const isForeign = (): boolean => open.length > 0 && open[open.length - 1] !== FOREIGN_ESCAPE
  let spanStart = -1
  let cursor = 0

  while (cursor < input.length) {
    const lt = nextTagStart(input, cursor)
    if (lt === -1) break
    const afterTag = endOfTag(input, lt)
    // Unterminated tag: a parser has no usable markup left, and neither have we.
    if (afterTag === -1) break

    const wasForeign = isForeign()
    const closing = input[lt + 1] === '/'
    const name = NAMESPACE_TAGS.find((n) => tagNameAt(input, lt, n, closing))

    if (name !== undefined) {
      if (closing) {
        // A stray close tag that matches nothing open is ignored (as a real
        // parser ignores it) — and the count check makes that the O(1) common
        // case, so no unmatched close ever walks the stack. When it DOES match,
        // unwind to the nearest matching open element; each element is pushed
        // once and unwound-over at most once, so this stays amortized linear.
        if ((openCount.get(name) ?? 0) > 0) {
          for (let i = open.length - 1; i >= 0; i--) {
            if (open[i] === name) {
              for (let j = i; j < open.length; j++) {
                const n = open[j]!
                openCount.set(n, openCount.get(n)! - 1)
              }
              open.length = i
              break
            }
          }
        }
      } else if (input[afterTag - 2] !== '/') {
        open.push(name)
        openCount.set(name, (openCount.get(name) ?? 0) + 1)
      }
    }

    const nowForeign = isForeign()
    // Boundaries are always cut at `lt`, never inside a tag. This range's only
    // consumer tests the index of a `<title` open tag, which can only ever fall
    // on a tag start, so cutting at the `<` of the tag that switched namespace
    // is exact.
    if (!wasForeign && nowForeign) spanStart = lt
    else if (wasForeign && !nowForeign) {
      ranges.push([spanStart, lt])
      spanStart = -1
    }
    cursor = afterTag
  }

  if (isForeign() && spanStart !== -1) ranges.push([spanStart, input.length])
  return ranges
}

/**
 * True when `idx` falls inside one of the foreign `ranges`.
 *
 * `foreignRanges` emits ranges sorted by start and non-overlapping (you must
 * leave a foreign span before another can open), so at most ONE range can
 * contain `idx`: the last one whose start is <= idx. A binary search finds that
 * candidate in O(log n) instead of testing every range. This matters because
 * the callers below invoke `inRanges` once per tag candidate — a full linear
 * scan here turns k foreign ranges × k candidates into O(k²) on adversarial
 * `<svg><title>t</title></svg>` repetition.
 */
function inRanges(idx: number, ranges: Array<[number, number]>): boolean {
  let lo = 0
  let hi = ranges.length - 1
  let cand = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (ranges[mid]![0] <= idx) {
      cand = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return cand !== -1 && idx < ranges[cand]![1]
}

/** Index of the first `<name` open tag outside every range in `skip`, or -1. */
function indexOfTagOutside(input: string, name: string, skip: Array<[number, number]>): number {
  let cursor = 0
  while (cursor < input.length) {
    const lt = input.indexOf('<', cursor)
    if (lt === -1) return -1
    if (tagNameAt(input, lt, name, false) && !inRanges(lt, skip)) return lt
    cursor = lt + 1
  }
  return -1
}

/**
 * Text content of the first `<tag>…</tag>`, or null. Used for <title> and the
 * heading elements — both of which carry only inline text in practice, so we take
 * the raw span and strip any residual tags from it.
 *
 * `skip` suppresses candidates inside foreign (svg/math) subtrees.
 */
function firstElementText(input: string, name: string, skip: Array<[number, number]> = []): string | null {
  let cursor = 0
  while (cursor < input.length) {
    const lt = input.indexOf('<', cursor)
    if (lt === -1) return null
    if (!tagNameAt(input, lt, name, false) || inRanges(lt, skip)) {
      cursor = lt + 1
      continue
    }
    const afterOpen = endOfTag(input, lt)
    if (afterOpen === -1) return null
    const closeLt = (() => {
      let scan = afterOpen
      while (scan < input.length) {
        const nextLt = input.indexOf('</', scan)
        if (nextLt === -1) return -1
        if (tagNameAt(input, nextLt, name, true)) return nextLt
        scan = nextLt + 2
      }
      return -1
    })()
    // An unterminated heading still has usable text: take the rest of the input.
    const raw = input.slice(afterOpen, closeLt === -1 ? input.length : closeLt)
    const text = normalizeWhitespace(decodeEntities(stripTags(raw)))
    if (text !== '') return text
    // Empty heading — keep looking for the next one of the same name.
    cursor = closeLt === -1 ? input.length : closeLt + 2
  }
  return null
}

/**
 * Erase tags, injecting BLOCK_SEP only at BLOCK-LEVEL boundaries so the remaining
 * text splits into blocks the way a browser lays them out. Inline tags vanish
 * with no separator: `x<b>y</b>z` is one run of text, because that is one line on
 * screen. See BLOCK_LEVEL for why per-tag separators were wrong.
 *
 * Tag starts come from nextTagStart, the SAME data-state rule foreignRanges uses:
 * a `<` is markup only when followed by a letter, `/`+letter, `!` or `?`. Without
 * it, prose like `Threshold: 5 < 10 percent.` had its `<` treated as a tag start
 * and everything up to the next `>` (or, with no `>` at all, the whole remainder
 * of the document) was eaten. A browser renders that `<` as text; so do we.
 *
 * Linear; an unterminated final tag is dropped.
 */
function stripTags(input: string): string {
  let out = ''
  let cursor = 0
  while (cursor < input.length) {
    const lt = nextTagStart(input, cursor)
    if (lt === -1) {
      out += input.slice(cursor)
      break
    }
    out += input.slice(cursor, lt)
    const afterTag = endOfTag(input, lt)
    // No closing '>' anywhere: the rest of the document is one malformed tag.
    if (afterTag === -1) break
    const name = tagNameOf(input, lt)
    // A nameless construct (DOCTYPE / bogus comment / PI) is never inline text,
    // so it separates blocks rather than gluing its neighbours together.
    if (name === null || BLOCK_LEVEL.has(name)) out += BLOCK_SEP
    cursor = afterTag
  }
  return out
}

/** Cut to `max` characters on a whole-character boundary, then trim. */
function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).trimEnd()
}

/**
 * Extract a first-screen excerpt from an HTML document.
 *
 * heading  — the `<title>` text, else the first non-empty `<h1>`…`<h6>`,
 *            whichever appears FIRST in the source (a document with both a title
 *            and an earlier h1 in a fragment should surface what the reader sees).
 * paragraphs — the first 3 non-empty text blocks, excluding the block that was
 *            already used as the heading.
 *
 * TODO(STV-001): in some edge shapes an accessibility label or a `<title>` can
 * still surface as a PARAGRAPH — when another element wins the heading race, the
 * losing candidate's text is no longer the `heading` string, so the
 * "skip the block already used as the heading" filter above does not exclude it.
 * Cosmetic only (the text is genuinely present in the document and is escaped
 * like any other paragraph); deliberately NOT fixed here because it would mean
 * reopening the heading/block extraction logic in a security-fix change.
 *
 * Never throws: any unexpected input shape degrades to `{ paragraphs: [] }`.
 */
export function extractHtmlExcerpt(html: unknown): HtmlExcerpt {
  if (typeof html !== 'string' || html === '') return { paragraphs: [] }
  const bounded = html.length > MAX_INPUT_CHARS ? html.slice(0, MAX_INPUT_CHARS) : html

  const cleaned = stripDroppedElements(stripComments(bounded))

  // ── heading: <title> vs first <h1>-<h6>, earlier one wins ──────────────────
  // A <title> inside <svg>/<math> is an a11y label, not the document title —
  // excluded as a candidate. The subtree itself stays: SVG <text> is real prose.
  const foreign = foreignRanges(cleaned)
  const titleIdx = indexOfTagOutside(cleaned, 'title', foreign)
  let headingTag: string | null = null
  let headingIdx = titleIdx
  if (titleIdx !== -1) headingTag = 'title'
  for (const tag of HEADING_TAGS) {
    const idx = indexOfTag(cleaned, tag)
    if (idx === -1) continue
    if (headingIdx === -1 || idx < headingIdx) {
      headingIdx = idx
      headingTag = tag
    }
  }
  let heading = headingTag ? firstElementText(cleaned, headingTag, headingTag === 'title' ? foreign : []) : null
  // The chosen element may be empty (e.g. `<title></title>`) while a later
  // heading has text — fall back rather than dropping the heading entirely.
  if (heading === null && headingTag !== null) {
    for (const tag of ['title', ...HEADING_TAGS]) {
      if (tag === headingTag) continue
      const text = firstElementText(cleaned, tag, tag === 'title' ? foreign : [])
      if (text !== null) {
        heading = text
        break
      }
    }
  }
  if (heading !== null) heading = clamp(heading, MAX_HEADING_CHARS)

  // ── paragraphs: the first non-empty text blocks ────────────────────────────
  const blocks = stripTags(cleaned).split(BLOCK_SEP)
  const paragraphs: string[] = []
  let budget = MAX_TOTAL_CHARS - (heading ? heading.length : 0)
  const scanned = Math.min(blocks.length, MAX_BLOCKS_SCANNED)
  for (let i = 0; i < scanned && paragraphs.length < MAX_PARAGRAPHS; i++) {
    const text = normalizeWhitespace(decodeEntities(blocks[i]!))
    if (text === '') continue
    // Skip the block we already surfaced as the heading — showing it twice on the
    // card reads as a bug.
    if (heading !== null && text === heading) continue
    if (budget <= 0) break
    const clamped = clamp(text, Math.min(MAX_PARAGRAPH_CHARS, budget))
    if (clamped === '') break
    paragraphs.push(clamped)
    budget -= clamped.length
  }

  return heading !== null && heading !== '' ? { heading, paragraphs } : { paragraphs }
}

/** Index of the first `<name` open tag, or -1. Linear scan. */
function indexOfTag(input: string, name: string): number {
  let cursor = 0
  while (cursor < input.length) {
    const lt = input.indexOf('<', cursor)
    if (lt === -1) return -1
    if (tagNameAt(input, lt, name, false)) return lt
    cursor = lt + 1
  }
  return -1
}
