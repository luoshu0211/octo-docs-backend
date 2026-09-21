/** Leave browser fullscreen, not the slideshow, before raising a separate window. */
export async function openPresenterView(open: () => void, doc: Document = document): Promise<void> {
  if (!doc.fullscreenElement) { open(); return }
  // Focus alone cannot reliably raise an existing window over macOS fullscreen.
  // Keep the presentation mounted and request the window from the host only
  // after fullscreen has finished exiting. The host still owns popup reuse.
  try {
    await doc.exitFullscreen()
  } catch {
    // A denied fullscreen exit must not suppress the speaker-window request.
  }
  open()
}
