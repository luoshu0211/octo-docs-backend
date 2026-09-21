import { JSDOM } from 'jsdom'

/** Parse trusted gallery markup once, then let the SVG writer escape plain text. */
export function galleryTextLines(html) {
  const fragment = JSDOM.fragment(html.replace(/<br\s*\/?\s*>/gi, '\n'))
  return fragment.textContent.split('\n')
}
