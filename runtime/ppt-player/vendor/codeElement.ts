// Native Bento code rendering, pinned in native/provenance.json (MIT).
import { renderCodeInto } from './native/code'
import { LANGS } from './native/tokenize'
import type { BentoDoc, CodeElement } from './native/model'
export type { CodeElement } from './native/model'
export const CODE_LANGUAGES = Object.keys(LANGS).sort().concat(['diff', 'md'])
export const CODE_FONT = "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace"
export const codeLanguage = (name = 'js') => ({javascript:'js',typescript:'ts',python:'py',bash:'sh',xml:'html',csharp:'cs',plaintext:'plain'}[name] || name)

export function renderCodeElement(node: HTMLElement, el: CodeElement, doc?: BentoDoc) {
  node.style.display = 'flex'; node.style.flexDirection = 'column'
  node.style.justifyContent = {top:'flex-start',middle:'center',bottom:'flex-end'}[el.valign] || 'flex-start'
  node.style.overflow = 'hidden'
  const pre = document.createElement('pre'); pre.className = 'bento-text-inner bento-code bento-code-inner'; pre.dir = 'auto'
  Object.assign(pre.style, {margin:'0',width:'100%',whiteSpace:'pre',tabSize:'2',
    fontFamily:el.fontFamily || CODE_FONT, fontSize:`${el.fontSize || 32}px`,lineHeight:String(el.lineHeight || 1.25),
    color:el.color || '#1e2a3a',textAlign:el.align || 'left'})
  // Normalize only the render input: legacy code elements keep their saved IDs
  // and fields. Identity within this deck remains exact for native token diffing.
  const source = doc || {slides:[{elements:[el]}],theme:{fontFamily:CODE_FONT}}
  const rendered = {...source, slides:source.slides.map(slide=>({...slide,elements:slide.elements.map(e=>e.type==='code'?{...e,grammarName:codeLanguage(e.grammarName)}:e)}))}
  const index = source.slides.findIndex(slide=>slide.elements.includes(el))
  const renderedEl = index < 0 ? el : rendered.slides[index]!.elements[source.slides[index]!.elements.indexOf(el)]!
  const content = typeof el.content === 'string' ? el.content : ''
  if (content.length > 50000 || ['plaintext','plain'].includes(el.grammarName || '') || !CODE_LANGUAGES.includes(codeLanguage(el.grammarName)) || !renderCodeInto(pre,renderedEl,rendered)) pre.textContent = content
  pre.querySelectorAll<HTMLElement>('[data-tok]').forEach(span=>{span.style.display='inline-block'})
  node.append(pre)
}
