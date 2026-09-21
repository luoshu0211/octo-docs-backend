import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { isMediaPlaybackKey, releaseDepartedMediaFocus } from '../runtime/ppt-player/vendor/mediaPlayback'

let dom: JSDOM
beforeEach(() => {
  dom = new JSDOM()
  vi.stubGlobal('Element', dom.window.Element)
})
afterEach(() => {
  vi.unstubAllGlobals()
  dom.window.close()
})

function accepts(tag: string, key: string, controls = true, modifiers: KeyboardEventInit = {}, sectionClass?: string) {
  const target = dom.window.document.createElement(tag)
  if (controls) target.setAttribute('controls', '')
  if (sectionClass !== undefined) {
    const reveal = dom.window.document.createElement('div')
    reveal.className = 'reveal'
    reveal.innerHTML = '<div class="slides"><section></section></div>'
    const section = reveal.querySelector('section')!
    section.className = sectionClass
    section.append(target)
  }
  const event = new dom.window.KeyboardEvent('keydown', { key, ...modifiers })
  Object.defineProperty(event, 'target', { value: target })
  return isMediaPlaybackKey(event)
}

it('only reserves keys for media on the current presentation slide', () => {
  for (const tag of ['video', 'audio']) {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Home', 'End']) {
      expect(accepts(tag, key, true, {}, 'present')).toBe(true)
      expect(accepts(tag, key, true, {}, 'past')).toBe(false)
      expect(accepts(tag, key, true, {}, 'future')).toBe(false)
    }
  }
})

it('blurs departed media without moving unrelated focus', () => {
  const doc = dom.window.document
  const from = doc.createElement('section')
  const media = doc.createElement('video')
  media.controls = true
  media.tabIndex = 0
  from.append(media)
  const elsewhere = doc.createElement('button')
  doc.body.append(from, elsewhere)
  media.focus()
  expect(doc.activeElement).toBe(media)
  releaseDepartedMediaFocus(from)
  expect(doc.activeElement).not.toBe(media)
  elsewhere.focus()
  releaseDepartedMediaFocus(from)
  expect(doc.activeElement).toBe(elsewhere)
  expect(() => releaseDepartedMediaFocus(undefined)).not.toThrow()
  from.remove()
  elsewhere.remove()
})

describe('native media keyboard ownership in the offline player', () => {
  it('reserves seek, volume, playback and boundary keys for video and audio', () => {
    for (const tag of ['video', 'audio']) {
      for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Home', 'End']) {
        expect(accepts(tag, key)).toBe(true)
      }
    }
  })
  it('keeps slide navigation and application shortcuts outside native controls', () => {
    expect(accepts('div', 'ArrowRight')).toBe(false)
    expect(accepts('video', 'ArrowRight', false)).toBe(false)
    for (const key of ['Escape', 's', 'f', 'PageDown']) expect(accepts('video', key)).toBe(false)
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(accepts('video', 'ArrowRight', true, modifiers)).toBe(false)
    }
  })
})
