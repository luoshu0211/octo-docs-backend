import { showHostedNotice } from './hostedDialog'
import { openPresenterView } from './openPresenter'
import { installPresenter } from './presenter'
import { renderSlide } from 'bento-slides/render'

let detachControls = () => {}

/** User-gesture fullscreen plus the native all-slide print layout. */
export function installPresentationControls(deck: any) {
  const overlay=document.querySelector<HTMLElement>('.bento-present-overlay')
  if(!overlay || overlay.querySelector('.octo-ppt-player-controls')) return
  detachControls()
  const zh=document.documentElement.lang.startsWith('zh') || navigator.language.startsWith('zh')
  const controls=document.createElement('div');controls.className='octo-ppt-player-controls'
  controls.style.cssText='position:absolute;top:14px;right:16px;display:flex;gap:8px;z-index:1000'
  const button=(text:string,action:()=>void)=>{const b=document.createElement('button');b.textContent=text;b.style.cssText='border:1px solid #ffffff55;border-radius:8px;background:#1e2a3add;color:#fff;padding:8px 12px;font:14px "PingFang SC",Inter,-apple-system,BlinkMacSystemFont,"Noto Sans SC",sans-serif;cursor:pointer';b.onclick=e=>{e.stopPropagation();action()};controls.append(b);return b}
  button(zh?'全屏（F）':'Fullscreen (F)',()=>{if(document.fullscreenElement)void document.exitFullscreen();else void overlay.requestFullscreen().catch(()=>{})})
  button(zh?'演讲者视图（S）':'Speaker view (S)',()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'s',bubbles:true})))
  const print=()=>{
    document.getElementById('bento-print')?.remove()
    const box=document.createElement('div');box.id='bento-print'
    const pageH=Math.round(1600*deck.size.height/deck.size.width),style=document.createElement('style')
    style.textContent=`@page{size:1600px ${pageH}px;margin:0}#bento-print .bp-page{height:${pageH}px}@media print{.octo-ppt-player-controls{display:none!important}}`
    box.append(style)
    for(const slide of deck.slides){
      if(slide.stateOf)continue
      const page=document.createElement('div');page.className='bp-page'
      const surface=renderSlide(slide,deck,{svgAsImage:true,hidePlaceholders:true})
      surface.style.transformOrigin='0 0';surface.style.transform=`scale(${1600/deck.size.width})`
      page.append(surface);box.append(page)
    }
    document.body.append(box)
    // Image decode finishes before opening the dialog; no network is required.
    void Promise.all([...box.querySelectorAll('img')].map(img=>img.decode().catch(()=>{}))).then(()=>window.print())
  }
  const printKey=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='p'){event.preventDefault();print()}}
  document.addEventListener('keydown',printKey)
  const fullscreen = () => { controls.style.display=document.fullscreenElement?'none':'flex' }
  document.addEventListener('fullscreenchange',fullscreen)
  detachControls=()=>{document.removeEventListener('keydown',printKey);document.removeEventListener('fullscreenchange',fullscreen)}
  fullscreen()
  overlay.append(controls)
  if(window.name==='octo-ppt-print')setTimeout(print,300)
}

/** The exported wrapper owns the popup; presentation data stays sandboxed. */
export function prepareOfflinePresenter(deck: any): boolean {
  const send = (data: unknown) => parent.postMessage(data, '*')
  if (window.name === 'octo-ppt-speaker') {
    const zh = navigator.language.startsWith('zh')
    const labels = zh ? {title:'演讲者视图',current:'当前页',next:'下一页',previous:'上一页',notes:'演讲备注',emptyNotes:'暂无备注'} : {title:'Speaker view',current:'Current',next:'Next',previous:'Previous',notes:'Notes',emptyNotes:'No notes'}
    const update = installPresenter({postMessage:send} as MessagePort, labels)
    window.addEventListener('message', event => {
      if(event.source === parent && event.data?.type === 'offline-state') update({...event.data,type:'presenter-state',deck})
    })
    send({type:'offline-ready'})
    return true
  }
  let navigate: ((index:number)=>void) | undefined, index = 0
  const state = () => send({type:'offline-state',index})
  ;(window as any).__octoPresenter = {
    open: () => openPresenterView(() => { state(); send({type:'offline-open'}) }),
    attach: (go: (index:number)=>void, current:number) => { navigate=go; index=current; state() },
    change: (current:number) => { index=current; state() },
    detach: () => { navigate=undefined },
  }
  window.addEventListener('message', event => {
    if(event.source !== parent) return
    if(event.data?.type === 'presenter-navigate' && Number.isInteger(event.data.index) && event.data.index >= 0 && event.data.index < deck.slides.length) navigate?.(event.data.index)
    if(event.data?.type === 'offline-blocked') showHostedNotice(navigator.language.startsWith('zh') ? '演讲者窗口被浏览器拦截，请允许弹出窗口后重试。' : 'Allow popups, then open speaker view again.')
  })
  return false
}
