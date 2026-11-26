/**
 * docs → octo-docs-html internal client for §4.4 复制.
 *
 * Copies an HTML document's LATEST PUBLISHED content into a target slug that
 * docs-backend minted. The html service performs no registration: docs-backend
 * owns the doc_meta row and writes it right after this call, so a copy is one
 * content round trip plus one local insert.
 *
 * Failure model mirrors htmlTitleRepublish: never throws, always returns a
 * reason. A copy that cannot be completed must not leave a half-configured
 * document, so the caller writes nothing on any failure.
 */
import { config } from '../../config/env.js'

export interface HtmlDuplicateInput {
  sourceSlug: string
  targetSlug: string
  title: string
  spaceId: string
  ownerUid: string
}

export type HtmlDuplicateResult =
  | { ok: true; slug: string; version: number; size: number }
  | { ok: false; reason: 'config_missing' | 'upstream' | 'not_found' | 'conflict'; status?: number }

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

let warned = false
function warnMissingConfigOnce(): void {
  if (warned) return
  warned = true
  // eslint-disable-next-line no-console
  console.warn(
    '[octo-docs] html copy is not configured (OCTO_DOCS_HTML_INTERNAL_URL / _TOKEN empty); ' +
      'copying an html document will fail closed with 503 copy_unavailable.',
  )
}

export async function duplicateHtmlDoc(input: HtmlDuplicateInput): Promise<HtmlDuplicateResult> {
  const base = config.htmlInternal.url.trim()
  const token = config.htmlInternal.token.trim()
  if (base === '' || token === '') {
    warnMissingConfigOnce()
    return { ok: false, reason: 'config_missing' }
  }
  const url = joinUrl(base, '/internal/html/duplicate')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), config.htmlInternal.timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': token,
      },
      body: JSON.stringify({
        source_slug: input.sourceSlug,
        target_slug: input.targetSlug,
        title: input.title,
        space_id: input.spaceId,
        owner_uid: input.ownerUid,
      }),
      signal: ac.signal,
      redirect: 'manual',
    })
    if (res.status !== 201) {
      return {
        ok: false,
        reason: res.status === 404 ? 'not_found' : res.status === 409 ? 'conflict' : 'upstream',
        status: res.status,
      }
    }
    const body = (await res.json().catch(() => null)) as
      | { slug?: unknown; version?: unknown; size?: unknown }
      | null
    if (!body || typeof body.slug !== 'string' || typeof body.version !== 'number') {
      return { ok: false, reason: 'upstream', status: res.status }
    }
    return {
      ok: true,
      slug: body.slug,
      version: body.version,
      size: typeof body.size === 'number' ? body.size : 0,
    }
  } catch {
    return { ok: false, reason: 'upstream' }
  } finally {
    clearTimeout(timer)
  }
}
