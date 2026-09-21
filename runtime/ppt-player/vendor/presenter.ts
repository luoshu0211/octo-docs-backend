import type { BentoDoc } from 'bento-slides/model'
import { renderThumbnail } from 'bento-slides/render'
import { injectFonts } from 'bento-slides/fonts'
import { adjacentPresentationSlide, presentationPosition } from './presentationNavigation'

/** Render deck content only inside the same opaque sandbox as the editor. */
export function installPresenter(port: MessagePort, labels: Record<string, string>) {
  const app = document.getElementById('app')!
  app.className = 'octo-presenter'
  app.innerHTML = '<header><h1></h1><time></time></header><main><section><h2></h2><div class="current"></div></section><aside><h2></h2><div class="next"></div><h2 class="notes-title"></h2><p class="notes"></p></aside></main><footer><button class="previous"></button><span class="count"></span><button class="forward"></button></footer>'
  const style = document.createElement('style')
  style.textContent = `html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}.octo-presenter{background:#f5f5f6;color:#25252b;font:14px "PingFang SC",Inter,-apple-system,BlinkMacSystemFont,"Noto Sans SC",sans-serif;display:flex;flex-direction:column}.octo-presenter header{display:flex;justify-content:space-between;align-items:center;padding:18px 24px;border-bottom:1px solid #ddd}.octo-presenter h1{font-size:16px;margin:0}.octo-presenter h2{font-size:12px;font-weight:500;color:#666;margin:0 0 12px}.octo-presenter main{display:grid;grid-template-columns:2fr 1fr;gap:24px;padding:24px;flex:1;min-height:0;overflow:auto}.octo-presenter section,.octo-presenter aside{min-width:0}.octo-presenter .current,.octo-presenter .next{overflow:hidden;pointer-events:none;box-shadow:0 2px 12px #0001}.octo-presenter .notes-title{margin-top:24px}.octo-presenter .notes{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}.octo-presenter footer{display:flex;gap:24px;align-items:center;justify-content:center;padding:16px;border-top:1px solid #ddd}.octo-presenter footer button{border:1px solid #ddd;background:white;border-radius:8px;padding:8px 20px;font:inherit;cursor:pointer}.octo-presenter footer button:disabled{opacity:.4;cursor:default}@media(max-width:650px){.octo-presenter main{grid-template-columns:1fr}.octo-presenter .next{display:none}}`
  document.head.append(style)
  const find = <T extends HTMLElement>(selector: string) => app.querySelector<T>(selector)!
  find('h1').textContent = labels.title
  find('section h2').textContent = labels.current
  find('aside h2').textContent = labels.next
  find('.notes-title').textContent = labels.notes
  find('.previous').textContent = `← ${labels.previous}`; find('.forward').textContent = `${labels.next} →`
  let deck: BentoDoc | undefined, index = 0
  const move = (delta: -1 | 1) => {
    const next = deck && adjacentPresentationSlide(deck.slides, index, delta)
    if (next !== undefined) port.postMessage({type:'presenter-navigate',index:next})
  }
  find('.previous').onclick = () => move(-1); find('.forward').onclick = () => move(1)
  document.addEventListener('keydown', e => { if (e.key==='ArrowLeft'||e.key==='ArrowRight') { e.preventDefault(); move(e.key==='ArrowRight'?1:-1) } })
  const began = Date.now()
  setInterval(() => { const seconds = Math.floor((Date.now()-began)/1000); find('time').textContent = `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}` },1000)
  function draw() {
    if (!deck) return
    const next = adjacentPresentationSlide(deck.slides, index, 1)
    for (const [selector,i] of [['.current',index],['.next',next]] as const) {
      const box = find(selector); box.replaceChildren()
      const slide = i === undefined ? undefined : deck.slides[i]
      if (slide) box.append(renderThumbnail(slide, deck, box.clientWidth))
    }
    find('h1').textContent = `${deck.title} · ${labels.title}`
    find('.notes').textContent = deck.slides[index]?.notes || labels.emptyNotes
    const position = presentationPosition(deck.slides, index)
    find('.count').textContent = `${position.current} / ${position.total}`
    find<HTMLButtonElement>('.previous').disabled = adjacentPresentationSlide(deck.slides,index,-1) === undefined
    find<HTMLButtonElement>('.forward').disabled = next === undefined
  }
  new ResizeObserver(draw).observe(find('main'))
  return (data: any) => {
    if (data.type !== 'presenter-state' || !Array.isArray(data.deck?.slides) || !Number.isInteger(data.index)) return
    deck = data.deck; index = Math.max(0,Math.min(data.index,deck!.slides.length-1)); injectFonts(deck!); draw()
  }
}
