import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
const renderer = fileURLToPath(new URL('../runtime/ppt-player/vendor/codeElement.ts', import.meta.url))
const panel = fileURLToPath(new URL('../runtime/ppt-player/vendor/codePanel.ts', import.meta.url))
const mediaPlayback = fileURLToPath(new URL('../runtime/ppt-player/vendor/mediaPlayback.ts', import.meta.url))
const presentationNavigation = fileURLToPath(new URL('../runtime/ppt-player/vendor/presentationNavigation.ts', import.meta.url))
const presentationChrome = fileURLToPath(new URL('../runtime/ppt-player/vendor/presentationChrome.ts', import.meta.url))
const native = '01000838496ec863ba1035eae12a8a4943020cdc'
const once = (code,before,after) => {
  if(code.split(before).length !== 2) throw new Error('Pinned native-code hook drift: '+before.slice(0,100))
  return code.replace(before,after)
}
/** Port native Code onto the pinned host, shared by editor and both exporters. */
export function pptCodePlugin(source) {
  return {name:'octo-ppt-native-code',enforce:'pre',transform(code,id) {
    if(id===resolve(source,'slides/src/styles.css')) {
      return code.replaceAll("-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif", "'PingFang SC', Inter, -apple-system, BlinkMacSystemFont, 'Noto Sans SC', sans-serif")
    }
    if(id===resolve(source,'slides/src/editor/editor.ts')) {
      code=once(code, "      const kind: 'video' | 'audio' = file.type.startsWith('audio') ? 'audio' : 'video'", "      const kind: 'video' | 'audio' = file.type.startsWith('audio') ? 'audio' : 'video'\n      if ((window as any).__octoUploadMedia) { void (window as any).__octoUploadMedia(file).then((ref:string)=>{if(!this.store.readOnly)this.insertMedia(kind,ref)}).catch(()=>{}); return }")
      code=once(code, '    probe.src = src', '    probe.src = (window as any).__octoResolveMedia?.(src) ?? src')
      return code
    }
    if(id===resolve(source,'slides/src/render.ts')) {
      // Bento handles autoplay with caught promises; Reveal must not also start media.
      code=code.replaceAll('dataset.autoplay', 'dataset.octoAutoplay')
      code=once(code,'      img.src = resolveAsset(doc, el.src)',"      if(el.src.startsWith('ppt-media:'))img.dataset.octoMediaRef=el.src\n      img.src = resolveAsset(doc, el.src)")
      for(const tag of ['audio','video'])code=once(code,`        if (el.src) ${tag}.src = resolveAsset(doc, el.src)`.trimStart(),`if (el.src) { if(el.src.startsWith('ppt-media:'))${tag}.dataset.octoMediaRef=el.src; ${tag}.src = resolveAsset(doc, el.src) }`)

      code=once(code, "export function resolveAsset(doc: BentoDoc, ref: string): string {", "export function resolveAsset(doc: BentoDoc, ref: string): string {\n  if (ref.startsWith('ppt-media:')) return (window as any).__octoResolveMedia?.(ref) ?? ''")
      return `import { renderCodeElement } from ${JSON.stringify(renderer)}\n` + once(code,"    case 'text': {","    case 'code': { renderCodeElement(node, el, doc); break }\n    case 'text': {")
    }
    if(id===resolve(source,'slides/src/editor/panels.ts')) {
      code=code.replace('saveLy.title = "Add this slide to the document\'s layout picker (New slide button)"', 'saveLy.title = t("Add this slide to the document\'s layout picker (New slide button)")')
      code=code.replace('`slide ${linear}', '`'+"${t('Slide')}"+' ${linear}')
      code = once(code,"text: 'Text', shape:","code: document.documentElement.lang.startsWith('zh') ? '代码' : 'Code', text: 'Text', shape:")
      code = once(code,"    if (el.type === 'text') this.buildTextProps(el)","    if (el.type === 'code') buildNativeCodeProps.call(this, el)\n    if (el.type === 'text') this.buildTextProps(el)")
      return `import { buildNativeCodeProps } from ${JSON.stringify(panel)}\n`+code
    }
    if(id===resolve(source,'slides/src/present.ts')) {
      code = `import { installPresentationChrome } from ${JSON.stringify(presentationChrome)}\n` + code
      code = once(code, '  deck.initialize().then(() => {', `  deck.initialize().then(() => {
    const updateChrome = installPresentationChrome(revealEl, doc.slides, () => deck.getIndices().h, index => deck.slide(index, 0))
    // Reveal refreshes its physical-index chrome after dispatching slidechanged.
    const refreshChrome = () => queueMicrotask(updateChrome)
    deck.on('slidechanged', refreshChrome)
    deck.on('resize', refreshChrome)`)
      code = `import { isMediaPlaybackKey, releaseDepartedMediaFocus } from ${JSON.stringify(mediaPlayback)}\nimport { presentationAnchors, adjacentPresentationSlide, presentationPosition } from ${JSON.stringify(presentationNavigation)}\n` + code
      // Replace the pinned audience navigation block as a unit: counters,
      // button availability, rails and hotkeys must agree with the speaker view.
      const navStart = code.indexOf('  const isState = (i: number) =>')
      const navEnd = code.indexOf('  // ——— black-screen', navStart)
      if (navStart < 0 || navEnd < navStart) throw new Error('Pinned presentation navigation hook drift')
      code = once(code, code.slice(navStart, navEnd), `  const anchors = presentationAnchors(doc.slides)
  const isState = (i: number) => anchors[i] !== undefined && anchors[i] !== i
  const anchorOf = (i: number) => anchors[i] ?? i
  const adjacent = (delta: -1 | 1) => adjacentPresentationSlide(doc.slides, deck.getIndices().h, delta)
  const goNext = () => { const next = adjacent(1); if (next !== undefined) deck.slide(next, 0) }
  const goPrev = () => { const prev = adjacent(-1); if (prev !== undefined) deck.slide(prev, 0) }
  const hasNext = () => adjacent(1) !== undefined
  const hasPrev = () => adjacent(-1) !== undefined
  const visibleIndex = (i: number) => presentationPosition(doc.slides, i).current
  const visibleTotal = presentationPosition(doc.slides, 0).total
  const railIndices = anchors.filter((anchor, i) => anchor === i)
  const goFirst = () => deck.slide(railIndices[0] ?? 0, 0)
  const goLast = () => deck.slide(railIndices[railIndices.length - 1] ?? 0, 0)

`)
      code = once(code, '    const from = event.previousSlide as HTMLElement | undefined', '    const from = event.previousSlide as HTMLElement | undefined\n    releaseDepartedMediaFocus(from)')
      code = once(code, '  const onKeydown = (ev: KeyboardEvent) => {', '  const onKeydown = (ev: KeyboardEvent) => {\n    if (isMediaPlaybackKey(ev)) return')
      code = once(code, '    keyboardCondition: null,', `    keyboardCondition: (event: KeyboardEvent) => !isMediaPlaybackKey(event),
    keyboard: { 35: goLast, 36: goFirst, 38: goPrev, 40: goNext, 72: goPrev, 74: goNext, 75: goPrev, 78: goNext, 80: goPrev },`)
      code=code.replaceAll('data-autoplay', 'data-octo-autoplay')
      code = once(code, "    const wl = (navigator as any).wakeLock", "    if (!(document as any).permissionsPolicy?.allowsFeature('screen-wake-lock') && !(document as any).featurePolicy?.allowsFeature('screen-wake-lock')) return\n    const wl = (navigator as any).wakeLock")
      const patches = [
        ["  const openSpeaker = () => {", "  const openSpeaker = () => {\n    if ((window as any).__octoPresenter) {\n      openingSpeaker = true\n      void Promise.resolve((window as any).__octoPresenter.open()).finally(() => { window.setTimeout(() => { openingSpeaker = false }, 500) })\n      return\n    }"],
        ["    const toIdx = [...slidesEl.children].indexOf(to)", "    const toIdx = [...slidesEl.children].indexOf(to)\n    ;(window as any).__octoPresenter?.change(toIdx)"],
        ["    onExit(last)", "    onExit(last)\n    ;(window as any).__octoPresenter?.detach()"],
        ["    if (startIndex > 0) deck.slide(startIndex, 0)", "    if (startIndex > 0) deck.slide(startIndex, 0)\n    ;(window as any).__octoPresenter?.attach((index: number) => deck.slide(index, 0), startIndex)"],
      ]
      for (const [before, after] of patches) code = once(code, before, after)
      return code
    }
    if(id===resolve(source,'slides/src/editor/canvas.ts')) {
      code = once(code,"if (startEditing && el.type === 'text')", "if (startEditing && (el.type === 'text' || el.type === 'code'))")
      code = once(code,".closest<HTMLElement>('.bento-el-text')",".closest<HTMLElement>('.bento-el-text, .bento-el-code')")
      code = once(code,"    this.editing = node\n    node.classList.add('bento-editing')",`    if (model?.type === 'code') { inner.textContent = model.content; this.editingShowedRaw = true }
    this.editing = node
    node.classList.add('bento-editing')`)
      // Code is raw text: markdown, rich paste, and formatting shortcuts must
      // never transform literal snippets (including tabs and angle brackets).
      code = once(code,"      // inline markup: ⌘/Ctrl+B/I/U toggle bold/italic/underline on the",`      if (model?.type === 'code') {
        if (ev.key === 'Tab') { ev.preventDefault(); document.execCommand('insertText', false, '  ') }
        if ((ev.metaKey || ev.ctrlKey) && ['b','i','u'].includes(ev.key.toLowerCase())) ev.preventDefault()
        return
      }
      // inline markup: ⌘/Ctrl+B/I/U toggle bold/italic/underline on the`)
      code = once(code,"      if (!autoformatAtCaret()) clearAutoformat()","      if (model?.type !== 'code' && !autoformatAtCaret()) clearAutoformat()")
      code = code.replace("      document.execCommand('insertHTML', false, sanitizeHtml(markdownToHtml(text)))","      if (model?.type === 'code') document.execCommand('insertText', false, text)\n      else document.execCommand('insertHTML', false, sanitizeHtml(markdownToHtml(text)))")
      code = once(code,"    } else if (this.editingShowedRaw) {",`    } else if (el && el.type === 'code' && !this.store.readOnly && (el.content !== inner.innerText || grownH > el.h)) {
      const content = inner.innerText
      this.store.commit(() => { el.content = content; if (grownH > el.h) el.h = Math.ceil(grownH) })
    } else if (this.editingShowedRaw) {`)
      return code
    }
  }}
}
export function withCodeNotice(html) {
  return html.replace('</head>', `<!-- Native Bento code module, MIT, nyblnet/bento ${native}. Copyright (c) 2026 The Bento authors. -->\n</head>`)
}
