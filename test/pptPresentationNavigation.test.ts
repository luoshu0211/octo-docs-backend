import { describe, expect, it } from 'vitest'
import { adjacentPresentationSlide, presentationPosition } from '../runtime/ppt-player/vendor/presentationNavigation'

describe('presentation navigation and numbering', () => {
  it('preserves nested families and returns to the immediate parent', () => {
    const slides = [{ id: 'root' }, { id: 'child', stateOf: 'root' }, { id: 'nested', stateOf: 'child' }, { id: 'next' }]
    expect(presentationPosition(slides, 2)).toEqual({ current: 1, total: 2 })
    expect(adjacentPresentationSlide(slides, 0, 1)).toBe(3)
    expect(adjacentPresentationSlide(slides, 2, -1)).toBe(1)
    expect(adjacentPresentationSlide(slides, 2, 1)).toBe(3)
  })
  it('anchors non-adjacent children to their main page', () => {
    const slides = [{ id: 'a' }, { id: 'b' }, { id: 'c', stateOf: 'a' }, { id: 'd' }]
    expect(presentationPosition(slides, 2)).toEqual({ current: 1, total: 3 })
    expect(adjacentPresentationSlide(slides, 2, -1)).toBe(0)
    expect(adjacentPresentationSlide(slides, 2, 1)).toBe(1)
    expect(adjacentPresentationSlide(slides, 1, 1)).toBe(3)
  })

  it('treats an orphan as a standalone page, including at the start of a deck', () => {
    const slides = [{ id: 'orphan', stateOf: 'missing' }, { id: 'main' }]
    expect(presentationPosition(slides, 0)).toEqual({ current: 1, total: 2 })
    expect(adjacentPresentationSlide(slides, 0, -1)).toBeUndefined()
    expect(adjacentPresentationSlide(slides, 0, 1)).toBe(1)
    expect(adjacentPresentationSlide(slides, 1, -1)).toBe(0)
  })

  it('does not loop or lose pages for cyclic or self references', () => {
    const slides = [{ id: 'a', stateOf: 'b' }, { id: 'b', stateOf: 'a' }, { id: 'c', stateOf: 'c' }]
    for (let i = 0; i < slides.length; i++) expect(presentationPosition(slides, i)).toEqual({ current: i + 1, total: 3 })
    expect(adjacentPresentationSlide(slides, 0, 1)).toBe(1)
    expect(adjacentPresentationSlide(slides, 2, -1)).toBe(1)
  })

  it('handles empty decks and invalid positions', () => {
    expect(presentationPosition([], 0)).toEqual({ current: 0, total: 0 })
    expect(adjacentPresentationSlide([], 0, 1)).toBeUndefined()
    expect(presentationPosition([{ id: 'a' }], -1)).toEqual({ current: 0, total: 1 })
  })
})
