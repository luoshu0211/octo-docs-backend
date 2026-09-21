// Usage: node --import tsx scripts/testPptPlayerMedia.mts <playwright-package.json> <deck.json> [frontend-export.html]
// Uses a caller-provided media fixture and local Chrome, with no login or service writes.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildPptHtml } from '../src/ppt/render.js'
import type { BentoDoc } from '../src/ppt/bentoDoc.js'

const [playwrightPackage, fixturePath, frontendExport] = process.argv.slice(2)
assert(playwrightPackage && fixturePath, 'Provide Playwright package.json and a deck JSON containing controlled video/audio')
const { chromium } = createRequire(resolve(playwrightPackage))('@playwright/test')
const input = JSON.parse(readFileSync(resolve(fixturePath), 'utf8'))
const deck: BentoDoc = input.data?.deck ?? input.deck ?? input
const slide = deck.slides.find(s => s.elements.some(element => {
  const media = element as { type?: string; kind?: string; controls?: boolean }
  return media.type === 'media' && media.kind === 'video' && media.controls !== false
}))
assert(slide, 'Fixture must contain a video slide')
const fixture = { ...deck, slides: [
  slide,
  ...['media-regression-next', 'media-regression-last'].map(id => ({ id, background: slide.background, transition: 'none', elements: [], notes: '' })),
] }
const players = [['backend', resolve('assets/ppt/player.html')]]
if (frontendExport) players.push(['frontend', resolve(frontendExport)])
const dir = mkdtempSync(join(tmpdir(), 'ppt-media-regression-'))
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results: unknown[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
  page.setDefaultTimeout(10000)
  for (const [name, file] of players) {
    let shell = readFileSync(file!, 'utf8')
    if (name === 'frontend') {
      const slot = /<script\b[^>]*\bid="bento-doc"[^>]*>[\s\S]*?<\/script>/
      assert(slot.test(shell), 'Frontend export must contain an inert deck slot')
      shell = shell.replace(slot, '<script id="bento-doc" type="application/json">__OCTO_PPT_DECK__</script>')
    }
    const html = join(dir, `${name}.html`)
    writeFileSync(html, buildPptHtml(shell, fixture))
    for (let round = 1; round <= 3; round++) {
      await page.goto(pathToFileURL(html).href)
      const frame = page.frameLocator('iframe')
      const media = frame.locator('section.present video[controls], section.present audio[controls]')
      await media.first().waitFor()
      for (let i = 0; i < await media.count(); i++) {
        const control = media.nth(i)
        await control.evaluate(async (element: HTMLMediaElement) => {
          if (element.readyState < 2) await new Promise<void>(resolve => element.addEventListener('loadeddata', () => resolve(), { once: true }))
          element.pause()
        })
        for (const key of ['ArrowRight', 'ArrowLeft']) {
          await control.evaluate((element: HTMLMediaElement) => { element.currentTime = 1 })
          await control.focus()
          await page.keyboard.press(key)
          await page.waitForTimeout(250)
          const state = await control.evaluate((element: HTMLMediaElement) => ({ tag: element.tagName, time: element.currentTime, duration: element.duration }))
          assert(state.duration > 1, 'Fixture media must be longer than one second')
          assert(key === 'ArrowRight' ? state.time > 1.001 : state.time < .999, `${name} round ${round} ${state.tag} ${key}: ${state.time}`)
          results.push({ player: name, round, key, ...state })
        }
      }
      await page.screenshot({ path: join(dir, `${name}-${round}.png`) })
      // PageDown is intentionally not a media key. Leaving a focused control
      // must restore arrow navigation immediately, without a compensating click.
      await media.first().focus()
      await page.keyboard.press('PageDown')
      await frame.locator('.slides > section:nth-child(2).present').waitFor()
      await page.keyboard.press('ArrowRight')
      await frame.locator('.slides > section:nth-child(3).present').waitFor()
      await page.keyboard.press('ArrowLeft')
      await frame.locator('.slides > section:nth-child(2).present').waitFor()
      results.push({ player: name, round, staleFocusNavigation: 'passed' })
    }
  }
  writeFileSync(join(dir, 'results.json'), JSON.stringify(results, null, 2) + '\n')
  console.log(JSON.stringify({ directory: dir, checks: results.length, results }))
} finally {
  await browser.close()
}
