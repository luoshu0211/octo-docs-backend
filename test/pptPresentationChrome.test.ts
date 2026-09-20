import { afterEach, beforeEach, it, expect, vi } from 'vitest'
import { JSDOM } from 'jsdom'
let dom: JSDOM
beforeEach(() => {
  dom = new JSDOM()
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('Element', dom.window.Element)
  vi.stubGlobal('MouseEvent', dom.window.MouseEvent)
  vi.stubGlobal('Event', dom.window.Event)
})
afterEach(() => { vi.unstubAllGlobals(); dom.window.close() })
import { installPresentationChrome } from '../runtime/ppt-player/vendor/presentationChrome'

const slides = [{ id: 'root' }, { id: 'child', stateOf: 'root' }, { id: 'nested', stateOf: 'child' }, { id: 'next' }]

it('maps progress and arrows to main pages, preserving direct-parent back navigation', () => {
  const root = document.createElement('div')
  root.innerHTML = '<aside class="controls"><button class="navigate-left"></button><button class="navigate-right"></button></aside><div class="progress"><span></span></div>'
  document.body.append(root)
  let index = 0
  const move = vi.fn((next: number) => { index = next })
  const nativeBar = root.querySelector<HTMLElement>('.progress > span')!
  const update = installPresentationChrome(root, slides, () => index, move)
  const next = root.querySelector<HTMLButtonElement>('.navigate-right')!
  const prev = root.querySelector<HTMLButtonElement>('.navigate-left')!
  const progress = root.querySelector<HTMLElement>('.progress')!
  vi.spyOn(progress, 'getBoundingClientRect').mockReturnValue({ left: 50, width: 200 } as DOMRect)
  const native = vi.fn()
  progress.addEventListener('click', native)
  next.addEventListener('click', native)
  progress.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 160 }))
  expect(move).toHaveBeenLastCalledWith(3)
  expect(native).not.toHaveBeenCalled()
  update()
  expect(next.disabled).toBe(true)
  expect(progress.firstElementChild!.getAttribute('style')).toContain('scaleX(1)')
  nativeBar.style.transform = 'scaleX(0.5)'
  expect(progress.firstElementChild).not.toBe(nativeBar)
  expect(progress.firstElementChild!.getAttribute('style')).toContain('scaleX(1)')
  prev.click()
  expect(index).toBe(0)
  update()
  expect(prev.disabled).toBe(true)
  next.click()
  expect(index).toBe(3)
  index = 2
  update()
  expect(prev.disabled).toBe(false)
  expect(progress.firstElementChild!.getAttribute('style')).toContain('scaleX(0)')
  prev.click()
  expect(index).toBe(1)
  root.remove()
})

it('does not swallow slide links and reserves a touch tap for one click on release', () => {
  const root = document.createElement('div')
  root.innerHTML = '<aside class="controls"><button class="navigate-right"></button></aside><a>slide link</a>'
  document.body.append(root)
  const move = vi.fn()
  installPresentationChrome(root, slides, () => 0, move)
  const native = vi.fn()
  root.addEventListener('touchstart', native)
  root.addEventListener('touchend', native)
  const button = root.querySelector<HTMLButtonElement>('button')!
  for (const type of ['touchstart', 'touchend']) button.dispatchEvent(new Event(type, { bubbles: true }))
  expect(native).not.toHaveBeenCalled()
  expect(move).not.toHaveBeenCalled()
  button.click()
  expect(move).toHaveBeenCalledTimes(1)
  expect(move).toHaveBeenCalledWith(3)
  const click = vi.fn()
  root.querySelector('a')!.addEventListener('click', click)
  root.querySelector('a')!.click()
  expect(click).toHaveBeenCalledOnce()
  expect(move).toHaveBeenCalledTimes(1)
  root.remove()
})
