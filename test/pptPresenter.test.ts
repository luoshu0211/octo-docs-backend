import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { installPresenter } from '../runtime/ppt-player/vendor/presenter'

vi.mock('bento-slides/render', () => ({
  renderThumbnail: (slide: { id: string }) => {
    const node = document.createElement('div')
    node.textContent = slide.id
    return node
  },
}))
vi.mock('bento-slides/fonts', () => ({ injectFonts: vi.fn() }))

let dom: JSDOM
beforeEach(() => {
  vi.useFakeTimers()
  dom = new JSDOM('<div id="app"></div>')
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('ResizeObserver', class { observe() {} })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  dom.window.close()
})

it('counts main slides and skips child pages in speaker next/previous/preview', () => {
  const postMessage = vi.fn()
  const receive = installPresenter({ postMessage } as unknown as MessagePort, {
    title: 'Speaker', current: 'Current', next: 'Next', previous: 'Previous', notes: 'Notes', emptyNotes: 'No notes',
  })
  const slides = [
    { id: 'cover' }, { id: 'system' },
    { id: 'ingest', stateOf: 'system' }, { id: 'model', stateOf: 'system' },
    { id: 'growth' },
  ]
  const draw = (index: number) => receive({ type: 'presenter-state', deck: { title: 'Orbital', slides }, index })
  const find = (selector: string) => document.querySelector(selector) as HTMLButtonElement
  draw(1)
  expect(find('.count').textContent).toBe('2 / 3')
  expect(find('.next').textContent).toBe('growth')
  find('.forward').click()
  expect(postMessage).toHaveBeenLastCalledWith({ type: 'presenter-navigate', index: 4 })
  draw(4)
  expect(find('.forward').disabled).toBe(true)
  expect(find('.next').textContent).toBe('')
  find('.previous').click()
  expect(postMessage).toHaveBeenLastCalledWith({ type: 'presenter-navigate', index: 1 })
  draw(2)
  expect(find('.count').textContent).toBe('2 / 3')
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft' }))
  expect(postMessage).toHaveBeenLastCalledWith({ type: 'presenter-navigate', index: 1 })
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight' }))
  expect(postMessage).toHaveBeenLastCalledWith({ type: 'presenter-navigate', index: 4 })
  draw(0)
  expect(find('.previous').disabled).toBe(true)
  expect(find('.count').textContent).toBe('1 / 3')
})

it('renders an orphan first page as 1 / 2 and allows navigating back to it', () => {
  const postMessage = vi.fn()
  const receive = installPresenter({ postMessage } as unknown as MessagePort, {
    title: 'Speaker', current: 'Current', next: 'Next', previous: 'Previous', notes: 'Notes', emptyNotes: 'No notes',
  })
  const deck = { title: 'Imported', slides: [{ id: 'child', stateOf: 'deleted' }, { id: 'main' }] }
  receive({ type: 'presenter-state', deck, index: 0 })
  expect(document.querySelector('.count')?.textContent).toBe('1 / 2')
  expect(document.querySelector('.next')?.textContent).toBe('main')
  receive({ type: 'presenter-state', deck, index: 1 })
  ;(document.querySelector('.previous') as HTMLButtonElement).click()
  expect(postMessage).toHaveBeenLastCalledWith({ type: 'presenter-navigate', index: 0 })
})
