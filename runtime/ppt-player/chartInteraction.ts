// Bento's open chart option schema is interpreted by its pinned native renderer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Option = Record<string, any>
const seriesList = (option: Option): Option[] => (Array.isArray(option.series) ? option.series : option.series ? [option.series] : []).filter((s: unknown) => s && typeof s === 'object')

/** A full circle needs two arcs: SVG ignores a single arc with identical ends. */
export function fullCirclePiePath(cx: number, cy: number, ri: number, ro: number, angle: number): string {
  const p = (r: number, a: number) => `${cx + Math.cos(a) * r} ${cy + Math.sin(a) * r}`
  const ring = (r: number, direction: number) => `M ${p(r, angle)} A ${r} ${r} 0 1 ${direction} ${p(r, angle + Math.PI)} A ${r} ${r} 0 1 ${direction} ${p(r, angle)} Z`
  return ring(ro, 1) + (ri > 0 ? ` ${ring(ri, 0)}` : '')
}

/** Presentation-only selections never change the persisted chart option. */
export function visibleChartOption(option: Option, hidden?: ReadonlySet<string>): Option {
  if (!hidden?.size) return option
  const colors = option.color?.length ? option.color : ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4']
  return { ...option, series: seriesList(option).flatMap((series: Option, index: number) => {
    const name = String(series.name ?? `Series ${index + 1}`)
    if (series.type !== 'pie' && hidden.has(name)) return []
    const itemStyle = { color: colors[index % colors.length], ...series.itemStyle }
    return [{ ...series, itemStyle, lineStyle: { color: itemStyle.color, ...series.lineStyle },
      ...(series.type === 'pie' ? { data: (series.data ?? []).map((item: Option, i: number) => hidden.has(String(item?.name ?? i)) ? { ...item, value: 0 } : item) } : {}) }]
  }) }
}

/** Native legend emits a marker and label per item as the final SVG children. */
export function wireChartLegend(svg: SVGSVGElement, option: Option, hidden: Set<string>, redraw: () => void): void {
  if (!option.legend || option.legend.show === false || option.legend.selectedMode === false) return
  const series = seriesList(option)
  const pie = series.find((s: Option) => s.type === 'pie')
  const names = pie ? (pie.data ?? []).map((p: Option, i: number) => String(p?.name ?? i))
    : series.map((s: Option, i: number) => String(s.name ?? `Series ${i + 1}`))
  if (!names.length || !series.some((s: Option) => s.name || s.type === 'pie')) return
  const nodes = Array.from(svg.children).slice(-2 * names.length)
  names.forEach((name: string, index: number) => {
    const marker = nodes[index * 2], label = nodes[index * 2 + 1]
    if (!marker || !label) return
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    group.dataset.octoChartLegend = name
    group.setAttribute('role', 'button'); group.setAttribute('tabindex', '0')
    group.setAttribute('aria-label', name); group.setAttribute('aria-pressed', String(!hidden.has(name)))
    group.style.cursor = 'pointer'; group.style.opacity = hidden.has(name) ? '0.4' : '1'
    group.append(marker, label); svg.append(group)
    const toggle = () => {
      const host = svg.parentElement
      if (option.legend.selectedMode === 'single') { hidden.clear(); names.forEach((other: string) => { if (other !== name) hidden.add(other) }) }
      else if (hidden.has(name)) hidden.delete(name)
      else hidden.add(name)
      redraw()
      Array.from(host?.querySelectorAll<SVGGElement>('[data-octo-chart-legend]') ?? []).find(el => el.dataset.octoChartLegend === name)?.focus({ preventScroll: true })
    }
    group.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); toggle() })
    group.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault(); event.stopPropagation(); toggle()
    })
  })
}

export function renderChartTooltip(host: HTMLElement, option: Option, title: string, rows: Array<{ name: string; value?: string; color: string; seriesName?: string; category?: string; rawValue?: string; percent?: string }>): void {
  host.replaceChildren()
  const formatter = option.tooltip?.formatter
  if (typeof formatter === 'string') {
    // Pure template strings only; neither markup nor functions are executable.
    host.textContent = formatter.replace(/\{([abcd])(\d*)\}/g, (_: string, key: string, index: string) => {
      const row = rows[Number(index || 0)]
      return key === 'a' ? row?.seriesName ?? row?.name ?? '' : key === 'b' ? row?.category ?? title : key === 'd' ? row?.percent ?? '' : row?.rawValue ?? row?.value ?? ''
    })
    return
  }
  if (title) { const heading = document.createElement('b'); heading.textContent = title; host.append(heading, document.createElement('br')) }
  rows.forEach((row, index) => {
    if (index) host.append(document.createElement('br'))
    const marker = document.createElement('span')
    marker.style.cssText = 'display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px'
    marker.style.backgroundColor = row.color
    host.append(marker, document.createTextNode(row.name + (row.value === undefined ? '' : `: ${row.value}`)))
  })
}
