/**
 * Decision card `display` helper (docs access approve/deny → octo-server).
 *
 * The approval-card display is now IDENTITY-BY-ID: docs-backend returns the
 * authoritative `decider_uid` / `decider_space_id` / `decided_at` on the decision
 * result and octo-server resolves the operator's name and Space label itself when
 * it renders the card. docs-backend therefore no longer queries octo user/Space
 * profiles for card display, and no longer depends on OCTO_SERVER_TOKEN for it.
 *
 * The only `display` field docs still sends is `title`, kept for compatibility
 * with octo-server's registry result card. It is bounded to the same rune cap the
 * response contract enforces so a pathological title can never blow the decoder.
 *
 * Kept in its own module so the formatting stays unit-testable without importing
 * the whole callback route (env/repos/etc.).
 */
const MAX_DISPLAY_RUNES = 500

/** Truncate to the display rune cap without splitting a surrogate pair. */
export function truncateDisplay(value: string): string {
  return [...value].slice(0, MAX_DISPLAY_RUNES).join('')
}

/**
 * Assemble the compatibility `display` map for a decision. Title only — the
 * decider identity and time travel as first-class `decider_*` / `decided_at`
 * fields on the result, not as pre-resolved display copy.
 */
export function buildDecisionDisplay(title: string): Record<string, string> {
  return { title: truncateDisplay(title || '文档访问申请') }
}
