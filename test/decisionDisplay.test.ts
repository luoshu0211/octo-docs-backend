import { describe, it, expect } from 'vitest'

// Pin the card display zone so the expected strings are fixed literals and the
// assertions hold in any process/CI timezone — the zone bug this guards against
// is invisible when the expectation is built from the same local zone as input.
import { vi } from 'vitest'
vi.mock('../src/config/env.js', () => ({
  config: { cardDisplayTimeZone: 'Asia/Shanghai' },
}))

const { buildDecisionDisplay, truncateDisplay } = await import(
  '../src/api/services/decisionDisplay.js'
)
const { formatCardTimestamp, formatCardTimestampFromSeconds } = await import(
  '../src/util/cardTime.js'
)

// 2026-07-24 15:35 Asia/Shanghai == 07:35 UTC.
const AT_UTC = '2026-07-24T07:35:00.000Z'
const AT_SECONDS = Math.floor(new Date(AT_UTC).getTime() / 1000)
const AT_DISPLAY = '2026-07-24 15:35'

describe('formatCardTimestamp (explicit zone)', () => {
  it('renders a fixed literal in the configured zone, independent of process TZ', () => {
    expect(formatCardTimestamp(new Date(AT_UTC))).toBe(AT_DISPLAY)
  })

  it('formats unix SECONDS (the callback acted_at unit)', () => {
    expect(formatCardTimestampFromSeconds(AT_SECONDS)).toBe(AT_DISPLAY)
  })

  it('renders midnight as 00:mm rather than 24:mm', () => {
    // 2026-07-24 00:05 Asia/Shanghai == 2026-07-23 16:05 UTC
    expect(formatCardTimestamp(new Date('2026-07-23T16:05:00.000Z'))).toBe('2026-07-24 00:05')
  })

  it('returns empty for missing / non-positive / non-finite / invalid input', () => {
    expect(formatCardTimestampFromSeconds(0)).toBe('')
    expect(formatCardTimestampFromSeconds(-1)).toBe('')
    expect(formatCardTimestampFromSeconds(Number.NaN)).toBe('')
    expect(formatCardTimestamp(new Date('nope'))).toBe('')
  })
})

// The approval-card display is now identity-BY-ID: docs returns the decider IDs +
// time as first-class result fields and octo-server resolves names itself. The
// only `display` field docs still sends is the (bounded) title — it queries no
// user/Space profile. These tests pin that title-only shape; there is deliberately
// no operator-name resolution to assert anymore.
describe('buildDecisionDisplay (title only)', () => {
  it('returns just the title', () => {
    expect(buildDecisionDisplay('季度目标')).toEqual({ title: '季度目标' })
  })

  it('falls back to a generic title when empty', () => {
    expect(buildDecisionDisplay('')).toEqual({ title: '文档访问申请' })
  })

  it('never resolves or emits operator_name / decided_at', () => {
    const display = buildDecisionDisplay('季度目标')
    expect(display).not.toHaveProperty('operator_name')
    expect(display).not.toHaveProperty('operator_space_name')
    expect(display).not.toHaveProperty('decided_at')
  })

  it('caps the title at 500 runes without splitting unicode', () => {
    const display = buildDecisionDisplay('文'.repeat(600))
    expect([...display.title!]).toHaveLength(500)
    expect([...truncateDisplay('😀'.repeat(600))]).toHaveLength(500)
  })
})
