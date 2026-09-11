// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
import { t } from 'bento-slides/i18n'
import { CODE_LANGUAGES, codeLanguage, type CodeElement } from './codeElement'
export function buildNativeCodeProps(this: any, el: CodeElement) {
    this.section(document.documentElement.lang.startsWith('zh') ? '源代码' : 'Source Code')
    const status = document.createElement('p')
    status.className = 'ed-hint'
    this.host.appendChild(status)
    // Font Size
    // Shown in POINTS (the unit office users know); the model stores slide-space
    // px. 1pt = 4/3 px at the slide's 96dpi space, so 32px = 24pt exactly.
    this.row('Size (pt)', this.number(Math.round(el.fontSize * 0.75 * 10) / 10, 1, (v, fin) =>
      this.mutate(el.id, (e) => {
        (e as CodeElement).fontSize = Math.round(Math.max(v, 3) * (4 / 3) * 100) / 100
      }, fin)))
    // Alignment
    this.row('Align', this.select(['left', 'center', 'right'], el.align, (v) =>
      this.mutate(el.id, (e) => { (e as CodeElement).align = v as CodeElement['align'] }, true)))
    // V-Alignment
    this.row('V-align', this.select(['top', 'middle', 'bottom'], el.valign, (v) =>
      this.mutate(el.id, (e) => { (e as CodeElement).valign = v as CodeElement['valign'] }, true)))
    // Line height
    this.row('Line height', this.number(el.lineHeight, 0.05, (v, fin) =>
      this.mutate(el.id, (e) => { (e as CodeElement).lineHeight = Math.max(v, 0.5) }, fin)))
    // Language — selects the built-in tokenizer table. grammarName doubles as
    // the language id; grammarAssetId/themeAssetId stay in the format as the
    // seam for a future signed-extension tier carrying real TextMate grammars
    // as deck assets, at which point pickers for them return here.
    const langs = [...CODE_LANGUAGES]
    this.row(t('Language'), this.select(langs, codeLanguage(el.grammarName), (v) =>
      this.mutate(el.id, (e) => { (e as CodeElement).grammarName = v }, true)))
    status.textContent = document.documentElement.lang.startsWith('zh') ? `内置 ${langs.length} 种语言` : `${langs.length} languages built in`
    this.host.appendChild(status)
  }
