import { installHostedChinese } from './vendor/chinese'
import { installPresentationControls, prepareOfflinePresenter } from './vendor/presentationControls'
import 'bento-slides/styles.css'
import './vendor/overlays.css'
import { configureApp } from 'bento-kernel/app.ts'
import { startPresentation } from 'bento-slides/present'
import { setLocale, applyDirection } from 'bento-slides/i18n'
import { injectFonts } from 'bento-slides/fonts'

configureApp({ appId: 'bento-slides', appName: 'Octo PPT', manifestUrl: '' })
installHostedChinese()
setLocale('zh-CN'); applyDirection()
const deck = JSON.parse(document.getElementById('bento-doc')!.textContent!)
if (deck.fonts?.length) injectFonts(deck)
const play = (index = 0) => {
  const result = startPresentation(deck, index, last => play(last), { fullscreen: false })
  installPresentationControls(deck)
  return result
}
if (!prepareOfflinePresenter(deck)) play()
