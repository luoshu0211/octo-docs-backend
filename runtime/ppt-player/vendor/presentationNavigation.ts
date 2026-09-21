type PresentationSlide = { id: string; stateOf?: string }

/** Resolve nested states to a main page; missing/cyclic families stay reachable. */
export function presentationAnchors(slides: readonly PresentationSlide[]): number[] {
  const byId = new Map(slides.map((slide, index) => [slide.id, index]))
  return slides.map((_, index) => {
    const seen = new Set<number>()
    let anchor = index
    while (slides[anchor]?.stateOf) {
      if (seen.has(anchor)) return index
      seen.add(anchor)
      const parent = byId.get(slides[anchor]!.stateOf!)
      if (parent === undefined) return index
      anchor = parent
    }
    return anchor
  })
}

/** Shared audience/speaker navigation; invalid families remain standalone pages. */
export function adjacentPresentationSlide(slides: readonly PresentationSlide[], index: number, delta: -1 | 1): number | undefined {
  if (!slides[index]) return undefined
  const anchors = presentationAnchors(slides)
  const anchor = anchors[index]!
  if (delta === -1 && anchor !== index) return slides.findIndex(slide => slide.id === slides[index]!.stateOf)
  for (let i = anchor + delta; i >= 0 && i < slides.length; i += delta) {
    if (anchors[i] === i) return i
  }
  return undefined
}

/** Use the same standalone-page fallback for the counter and navigation. */
export function presentationPosition(slides: readonly PresentationSlide[], index: number): { current: number; total: number } {
  const anchors = presentationAnchors(slides)
  const main = anchors.filter((anchor, i) => anchor === i)
  return {
    current: slides[index] ? main.indexOf(anchors[index]!) + 1 : 0,
    total: main.length,
  }
}
