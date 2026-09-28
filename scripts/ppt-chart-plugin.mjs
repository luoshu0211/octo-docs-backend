import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
const helper = fileURLToPath(new URL('../runtime/ppt-player/chartInteraction.ts', import.meta.url))
const once = (code, before, after) => {
  if (code.split(before).length !== 2) throw new Error('Pinned chart hook drift: ' + before.slice(0, 100))
  return code.replace(before, after)
}
export function pptChartPlugin(source) {
  return { name: 'octo-ppt-chart-interaction', enforce: 'pre', transform(code, id) {
    if (id === resolve(source, 'slides/src/present.ts')) {
      // Presentation capture must leave activation keys to the focused legend.
      return once(code, '  const onKeydown = (ev: KeyboardEvent) => {', `  const onKeydown = (ev: KeyboardEvent) => {
    if ((ev.key === ' ' || ev.key === 'Enter') && ev.target instanceof Element && ev.target.closest('[data-octo-chart-legend]')) return`)
    }
    if (id !== resolve(source, 'kernel/src/charts.ts')) return
    code = once(code, '  const dstr =\n', '  const dstr = a1 - a0 >= Math.PI * 2 - 1e-8 ? fullCirclePiePath(cx, cy, ri, ro, a0) :\n')
    code = once(code, 'if (sweep >= 1 && labelFmt) {', 'if (sweep >= 1 && labelFmt && p.value > 0) {')
    code = once(code, 'rows: [{ name: `${fmt(px)}, ${fmt(py)}`, color }]', 'rows: [{ name: `${fmt(px)}, ${fmt(py)}`, color, seriesName: String(s.name ?? ""), category: "", rawValue: `${fmt(px)}, ${fmt(py)}` }]')
    code = once(code, 'rows: [{ name: p.name, value: `${fmt(p.value)} (${Math.round((frac) * 1000) / 10}%)`, color }]', 'rows: [{ name: p.name, value: `${fmt(p.value)} (${Math.round((frac) * 1000) / 10}%)`, color, seriesName: String(s.name ?? ""), category: p.name, rawValue: fmt(p.value), percent: String(Math.round(frac * 1000) / 10) }]')
    code = once(code, "const legend: LegendCfg | null = legendRaw ? {", "const legend: LegendCfg | null = legendRaw && legendRaw.show !== false ? {")
    code = once(code, 'view: View = { start: 0, end: 1 }): SVGSVGElement {\n  const d = digest(option, w, h)', 'view: View = { start: 0, end: 1 }, hidden: ReadonlySet<string> = new Set(Object.entries(option.legend?.selected ?? {}).filter(([, selected]) => selected === false).map(([name]) => name))): SVGSVGElement {\n  const d = digest(visibleChartOption(option, hidden), w, h)\n  const legendDigest = digest(option, w, h)')
    code = once(code, "if (d.legend && d.series.some((s) => s?.name || s?.type === 'pie')) renderLegend(svg, d)", "if (legendDigest.legend && legendDigest.series.some((s) => s?.name || s?.type === 'pie')) renderLegend(svg, legendDigest)")
    code = once(code, '  const option = el.option as Opt', `  const option = el.option as Opt
  const listeners = new AbortController()
  const hidden = new Set<string>(Object.entries(option.legend?.selected ?? {}).filter(([, selected]) => selected === false).map(([name]) => name))`)
    code = once(code, 'const svg = renderChart(opt, w, h, sweep, view)', 'const svg = renderChart(opt, w, h, sweep, view, hidden)')
    code = once(code, '    wireTooltips(svg, opt)', '    wireTooltips(svg, opt)\n    wireChartLegend(svg, opt, hidden, () => { tipEl.style.display = \'none\'; draw(option) })')
    code = once(code, '    const d = digest(opt, w, h)', '    const d = digest(visibleChartOption(opt, hidden), w, h)')
    const start = code.indexOf('    tipEl.innerHTML =')
    const end = code.indexOf("    tipEl.style.display = 'block'", start)
    if (start < 0 || end < start) throw new Error('Pinned tooltip hook drift')
    code = code.slice(0, start) + '    renderChartTooltip(tipEl, option, title, rows)\n' + code.slice(end)
    code = once(code, '}, { passive: false })', '}, { passive: false, signal: listeners.signal })')
    code = once(code, "host.addEventListener('mousedown', (ev) => { panFrom = { x: ev.clientX, s: view.start, e: view.end } })", "host.addEventListener('mousedown', (ev) => { panFrom = { x: ev.clientX, s: view.start, e: view.end } }, { signal: listeners.signal })")
    code = once(code, "      draw(option)\n    })\n    window.addEventListener('mouseup', () => { panFrom = null })", "      draw(option)\n    }, { signal: listeners.signal })\n    window.addEventListener('mouseup', () => { panFrom = null }, { signal: listeners.signal })")
    code = once(code, '    disposed = true', '    disposed = true\n    listeners.abort()')
    return `import { visibleChartOption, wireChartLegend, renderChartTooltip, fullCirclePiePath } from ${JSON.stringify(helper)}\n` + code
  } }
}
