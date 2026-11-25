/**
 * Title whitespace normalization shared by every rename seam.
 *
 * The html service normalizes with Go's `strings.TrimSpace`, which uses
 * `unicode.IsSpace` and therefore also strips U+0085 (NEL), U+00A0 (NBSP),
 * U+1680, U+2000..U+200A, U+2028/2029, U+202F, U+205F and U+3000. JavaScript's
 * `String.prototype.trim` only strips ECMAScript WhiteSpace + LineTerminator and
 * leaves U+0085/U+00A0 alone, so a title with those characters would be trimmed
 * on the html side and then fail our strict response comparison (permanent 503).
 *
 * This is the EXACT Go `unicode.IsSpace` set (the Latin-1 entries plus the
 * Unicode White_Space code points Go lists). It intentionally excludes
 * zero-width characters such as U+200B and U+FEFF, matching Go.
 */
const TITLE_SPACE = '\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000'
const EDGE_WHITESPACE = new RegExp(`^[${TITLE_SPACE}]+|[${TITLE_SPACE}]+$`, 'g')

/** Trim leading/trailing whitespace with Go `strings.TrimSpace` semantics. */
export function trimTitleWhitespace(value: string): string {
  return value.replace(EDGE_WHITESPACE, '')
}

/** Count Unicode code points (runes), matching utf8mb4 VARCHAR(512). */
export function titleRuneLength(value: string): number {
  return [...value].length
}
