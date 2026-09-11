/**
 * Canonical browser-facing URL for an ordinary document.
 *
 * Phase 1 removes Space from the locator: every caller (web, bot, CLI, plugin)
 * emits exactly `<web-origin>/d/<docId>`. The optional legacy `spaceId`
 * argument is intentionally ignored so existing integrations can upgrade
 * without continuing to mint `sp` links. This is type-agnostic: ordinary docs
 * AND PPT decks share the same bare `/d/:docId` link. On open, open-context
 * resolves the canonical home Space. PPT creation uses this same locator.
 */
export function buildDocShareUrl(webOrigin: string, docId: string, _spaceId?: string): string {
  const origin = webOrigin.trim().replace(/\/+$/, '')
  return `${origin}/d/${encodeURIComponent(docId)}`
}

/** PPT creation and sharing use the same canonical, docId-only locator. */
export function buildPptEditorUrl(webOrigin: string, docId: string, _spaceId?: string): string {
  return buildDocShareUrl(webOrigin, docId)
}
