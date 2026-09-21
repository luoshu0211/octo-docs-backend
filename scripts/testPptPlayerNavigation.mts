// Usage: node --import tsx scripts/testPptPlayerNavigation.mts <playwright-package.json> [frontend-export.html]
// Tests real audience and speaker frames, with no login or shared-service writes.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildPptHtml } from '../src/ppt/render.js'
import type { BentoDoc } from '../src/ppt/bentoDoc.js'

const [playwrightPackage, frontendExport] = process.argv.slice(2)
assert(playwrightPackage, 'Provide Playwright package.json')
const { chromium, expect } = createRequire(resolve(playwrightPackage))('@playwright/test')
const players = [['backend', resolve('assets/ppt/player.html')]]
if (frontendExport) players.push(['frontend', resolve(frontendExport)])
const cases = [
  { name: 'orphan', slides: [{ id: 'a', stateOf: 'missing' }, { id: 'b' }], steps: [[0, '1 / 2'], [1, '2 / 2']] },
  { name: 'cycle', slides: [{ id: 'a', stateOf: 'b' }, { id: 'b', stateOf: 'a' }, { id: 'c', stateOf: 'c' }], steps: [[0, '1 / 3'], [1, '2 / 3'], [2, '3 / 3']] },
  { name: 'nested', slides: [{ id: 'a' }, { id: 'b', stateOf: 'a' }, { id: 'c', stateOf: 'b' }, { id: 'd' }], jump: 'c', steps: [[2, '1 / 2'], [3, '2 / 2']] },
  { name: 'nonadjacent', slides: [{ id: 'a' }, { id: 'b' }, { id: 'c', stateOf: 'a' }, { id: 'd' }], jump: 'c', steps: [[2, '1 / 3'], [1, '2 / 3'], [3, '3 / 3']] },
  { name: 'trailing-state', slides: [{ id: 'a' }, { id: 'b' }, { id: 'c', stateOf: 'b' }], steps: [[0, '1 / 2'], [1, '2 / 2']] },
] as const
const dir = mkdtempSync(join(tmpdir(), 'ppt-navigation-regression-'))
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results: unknown[] = []
try {
  for (const [name, file] of players) {
    let shell = readFileSync(file!, 'utf8')
    if (name === 'frontend') {
      const slot = /<script\b[^>]*\bid="bento-doc"[^>]*>[\s\S]*?<\/script>/
      assert(slot.test(shell))
      shell = shell.replace(slot, '<script id="bento-doc" type="application/json">__OCTO_PPT_DECK__</script>')
    }
    for (const scenario of cases) {
      const deck: BentoDoc = {
        format: 'bento/slides', version: 1, docId: 'navigation-regression', title: scenario.name,
        size: { width: 1280, height: 720 }, modified: '2026-09-19T00:00:00.000Z',
        theme: { background: '#fff', color: '#000', accent: '#0055ff', fontFamily: 'Arial' },
        present: { controls: true },
        slides: scenario.slides.map((slide, index) => ({
          ...slide, background: '#fff', transition: 'none', notes: slide.id,
          elements: index === 0 && 'jump' in scenario ? [{
            id: 'jump', type: 'text', x: 100, y: 100, w: 500, h: 100, rotation: 0, opacity: 1,
            html: 'Open subpage', color: '#000', fontFamily: 'Arial', fontSize: 40, link: scenario.jump,
          }] : [],
        })),
      }
      const html = join(dir, `${name}-${scenario.name}.html`)
      writeFileSync(html, buildPptHtml(shell, deck))
      for (let round = 1; round <= 3; round++) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true })
        page.setDefaultTimeout(10000)
        await page.goto(pathToFileURL(html).href)
        const audience = page.frameLocator('iframe')
        await audience.locator('.slides > section.present').waitFor()
        await audience.locator('.slides > section.present').click({ position: { x: 10, y: 10 } })
        const opened = page.waitForEvent('popup')
        await page.keyboard.press('s')
        const popup = await opened
        const speaker = popup.frameLocator('iframe')
        const check = async (index: number, counter: string) => {
          await expect(audience.locator(`.slides > section:nth-child(${index + 1})`)).toHaveClass(/present/)
          await expect(audience.locator('.slide-number')).toHaveText(counter)
          await expect(speaker.locator('.count')).toHaveText(counter)
          const [current, total] = counter.split('/').map(Number) as [number, number]
          await expect.poll(() => audience.locator('.progress > span').evaluate((el: HTMLElement) => el.style.transform))
            .toBe(`scaleX(${total > 1 ? (current - 1) / (total - 1) : 0})`)
        }
        await check(0, scenario.steps[0][1])
        if (scenario.name === 'nested') {
          const progress = audience.locator('.progress')
          const bounds = await progress.boundingBox()
          assert(bounds)
          await progress.click({ position: { x: bounds.width * .55, y: bounds.height / 2 } })
          await check(3, '2 / 2')
          await progress.click({ position: { x: 1, y: bounds.height / 2 } })
          await check(0, '1 / 2')
          await audience.locator('.controls .navigate-right').click()
          await check(3, '2 / 2')
          await expect(audience.locator('.controls .navigate-right')).toBeDisabled()
          await audience.locator('.controls .navigate-left').click()
          await check(0, '1 / 2')
          await expect(audience.locator('.controls .navigate-left')).toBeDisabled()
          await audience.locator('.controls .navigate-right').tap()
          await check(3, '2 / 2')
          await audience.locator('.controls .navigate-left').tap()
          await check(0, '1 / 2')
        }
        if (scenario.name === 'nested' || scenario.name === 'trailing-state') {
          const lastMain = scenario.name === 'nested' ? 3 : 1
          await audience.locator('.slides > section.present').click({ position: { x: 10, y: 10 } })
          for (const [nextKey, prevKey] of [['n', 'p'], ['ArrowDown', 'ArrowUp'], ['j', 'k'], ['End', 'Home']]) {
            await page.keyboard.press(nextKey!)
            await check(lastMain, '2 / 2')
            await page.keyboard.press(prevKey!)
            await check(0, '1 / 2')
          }
        }
        if ('jump' in scenario) {
          await audience.locator('.present [data-el-id="jump"]').click()
        }
        for (let i = 0; i < scenario.steps.length; i++) {
          if (i) await speaker.locator('.forward').click()
          const [index, counter] = scenario.steps[i]!
          await check(index, counter)
        }
        // Back from a nested state must return to its immediate parent, not root.
        if ('jump' in scenario) {
          await audience.locator('.slides').evaluate((el: HTMLElement) => el.ownerDocument.body.focus())
          await page.keyboard.press('Home')
          await audience.locator('.present [data-el-id="jump"]').click()
          await speaker.locator('.previous').click()
          await check(scenario.name === 'nested' ? 1 : 0, scenario.steps[0][1])
        } else {
          await expect(speaker.locator('.forward')).toBeDisabled()
        }
        await page.screenshot({ path: join(dir, `${name}-${scenario.name}-${round}.png`) })
        results.push({ player: name, scenario: scenario.name, round, passed: true })
        await popup.close()
        await page.close()
      }
    }
  }
  writeFileSync(join(dir, 'results.json'), JSON.stringify(results, null, 2) + '\n')
  console.log(JSON.stringify({ directory: dir, scenarios: results.length, results }))
} finally {
  await browser.close()
}
