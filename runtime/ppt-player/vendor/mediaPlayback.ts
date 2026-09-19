const playbackKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Home', 'End'])

/** Only visible native media controls own playback keys during a slideshow. */
export function isMediaPlaybackKey(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || !playbackKeys.has(event.key) || !(event.target instanceof Element)) return false
  const media = event.target.closest('video[controls], audio[controls]')
  if (!media) return false
  const section = media.closest('.reveal .slides > section')
  return !section || section.classList.contains('present')
}

/** Release native-control focus on departure so hidden media cannot seek/play. */
export function releaseDepartedMediaFocus(from: Element | undefined): void {
  const active = from?.ownerDocument.activeElement
  if (active && from?.contains(active) && active.matches('video[controls], audio[controls]')) {
    (active as HTMLElement).blur()
  }
}
