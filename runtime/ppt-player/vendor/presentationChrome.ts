import { adjacentPresentationSlide, presentationAnchors, presentationPosition } from './presentationNavigation'

type Slide = { id: string; stateOf?: string }

/** Keep Reveal's visible controls on the same main-page model as keyboard/speaker navigation. */
export function installPresentationChrome(root: HTMLElement, slides: readonly Slide[], currentIndex: () => number, goTo: (index: number) => void): () => void {
  const main = presentationAnchors(slides).filter((anchor, i) => anchor === i)
  // Reveal's controller holds the original span and updates it on late layout
  // even without a resize event. Give the main-page indicator its own span;
  // keep the native wrapper/styles, but never race two writers on one bar.
  const nativeBar = root.querySelector<HTMLElement>('.progress > span')
  const bar = nativeBar?.cloneNode(false) as HTMLElement | undefined
  if (bar) nativeBar!.replaceWith(bar)
  const controlSelector = '.controls .navigate-left, .controls .navigate-prev, .controls .navigate-right, .controls .navigate-next'
  const control = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>(controlSelector) : null
  root.addEventListener('click', event => {
    const button = control(event.target)
    const progress = event.target instanceof Element ? event.target.closest<HTMLElement>('.progress') : null
    if (!button && !progress) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (button) {
      const delta = button.matches('.navigate-left, .navigate-prev') ? -1 : 1
      const next = adjacentPresentationSlide(slides, currentIndex(), delta)
      if (next !== undefined) goTo(next)
    } else if (progress && main.length) {
      const bounds = progress.getBoundingClientRect()
      if (bounds.width <= 0) return
      const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
      goTo(main[Math.min(main.length - 1, Math.floor(ratio * main.length))]!)
    }
  }, true)
  // Reveal also navigates on touchstart. Suppress that early handler but keep
  // the browser's normal click on release, so a tap advances exactly once.
  for (const type of ['touchstart', 'touchend']) root.addEventListener(type, event => {
    if (control(event.target)) event.stopImmediatePropagation()
  }, { capture: true, passive: true })

  const update = () => {
    const index = currentIndex()
    for (const [selector, delta] of [['.navigate-left, .navigate-prev', -1], ['.navigate-right, .navigate-next', 1]] as const) {
      const enabled = adjacentPresentationSlide(slides, index, delta) !== undefined
      root.querySelectorAll<HTMLButtonElement>('.controls button').forEach(button => {
        if (!button.matches(selector)) return
        button.disabled = !enabled
        button.classList.toggle('enabled', enabled)
        button.setAttribute('aria-disabled', String(!enabled))
      })
    }
    const position = presentationPosition(slides, index)
    if (bar) bar.style.transform = `scaleX(${position.total > 1 ? (position.current - 1) / (position.total - 1) : 0})`
  }
  update()
  return update
}
