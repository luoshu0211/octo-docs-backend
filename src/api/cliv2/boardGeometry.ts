// Board comment coordinates follow the same Excalidraw 0.18.1 / RoughJS 4.6.4
// geometry previously used by the CLI, including bound text on connectors.
type Element = Record<string, unknown>
type Point = readonly [number, number]
type Cubic = readonly [Point, Point, Point, Point]
type Bounds = { minX: number; minY: number; maxX: number; maxY: number }

export const boardCoordinateLimit = 1_000_000

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > boardCoordinateLimit) {
    throw new RangeError('Invalid board coordinate')
  }
  return value
}

function dimension(value: unknown): number {
  const size = number(value)
  if (size < 0) throw new RangeError('Invalid board dimension')
  return size
}

function rotate([x, y]: Point, [cx, cy]: Point, angle: number): Point {
  const cos = Math.cos(angle), sin = Math.sin(angle)
  return [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos]
}

function center(b: Bounds): Point {
  return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]
}

function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
}

function include(b: Bounds, [x, y]: Point): void {
  b.minX = Math.min(b.minX, x)
  b.minY = Math.min(b.minY, y)
  b.maxX = Math.max(b.maxX, x)
  b.maxY = Math.max(b.maxY, y)
}

function pointsBounds(points: readonly Point[]): Bounds {
  const b = emptyBounds()
  for (const point of points) include(b, point)
  return b
}

function localPoints(raw: unknown): Point[] {
  if (!Array.isArray(raw) || !raw.length) throw new RangeError('Missing board points')
  return raw.map(point => {
    if (!Array.isArray(point)) throw new RangeError('Invalid board point')
    return [number(point[0]), number(point[1])]
  })
}

function random(seed: number) {
  return () => {
    seed = Math.imul(seed, 48271) & 0x7fffffff
    return seed / 2147483648
  }
}

function roughCurve(points: Point[], roughness: number, offset: number, next: () => number): Cubic[] {
  const jitter = (p: Point): Point => [
    p[0] + roughness * (next() * 2 * offset - offset),
    p[1] + roughness * (next() * 2 * offset - offset),
  ]
  const nodes = [points[0]!, ...points, points.at(-1)!].map(jitter)
  const curves: Cubic[] = []
  for (let i = 1; i + 2 < nodes.length; i++) {
    const prev = nodes[i - 1]!, a = nodes[i]!, b = nodes[i + 1]!, next = nodes[i + 2]!
    curves.push([a, [a[0] + (b[0] - prev[0]) / 6, a[1] + (b[1] - prev[1]) / 6],
      [b[0] + (a[0] - next[0]) / 6, b[1] + (a[1] - next[1]) / 6], b])
  }
  return curves
}

function roughSegment(a: Point, b: Point, roughness: number, preserve: boolean, single: boolean, next: () => number): Cubic[] {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const length = Math.hypot(dx, dy)
  const gain = length > 500 ? 0.4 : length >= 200 ? -0.0016668 * length + 1.233334 : 1
  const offset = length < 20 ? length / 10 : 2
  const offsetBy = (limit: number) => roughness * gain * (next() * 2 * limit - limit)
  return (single ? [offset] : [offset, offset / 2]).map(limit => {
    const diverge = 0.2 + next() * 0.2
    const bowX = offsetBy(dy / 100), bowY = offsetBy(-dx / 100)
    const start = preserve ? a : [a[0] + offsetBy(limit), a[1] + offsetBy(limit)] as const
    const p1: Point = [bowX + a[0] + dx * diverge + offsetBy(limit), bowY + a[1] + dy * diverge + offsetBy(limit)]
    const p2: Point = [bowX + a[0] + 2 * dx * diverge + offsetBy(limit), bowY + a[1] + 2 * dy * diverge + offsetBy(limit)]
    const end = preserve ? b : [b[0] + offsetBy(limit), b[1] + offsetBy(limit)] as const
    return [start, p1, p2, end]
  })
}

function connectorCurves(element: Element, points: Point[]): Cubic[] {
  const seed = element.seed === undefined ? 0 : element.seed
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0x7fffffff) {
    throw new RangeError('Invalid connector seed')
  }
  const original = element.roughness === undefined ? 1 : number(element.roughness)
  const bounds = pointsBounds(points)
  const width = bounds.maxX - bounds.minX, height = bounds.maxY - bounds.minY
  const maxSize = Math.max(width, height)
  const rounded = element.roundness != null
  const full = maxSize >= 50 || (Math.min(width, height) >= 15 && rounded && element.type === 'line')
  const roughness = full ? original : Math.min(original / (maxSize < 10 ? 3 : 2), 2.5)
  const single = typeof element.strokeStyle === 'string' && element.strokeStyle !== '' && element.strokeStyle !== 'solid'
  const next = random(seed)
  if (rounded) {
    const outer = roughCurve(points, roughness, 1 + roughness * 0.2, next)
    return single ? outer : outer.concat(roughCurve(points, roughness, 1.5 * (1 + roughness * 0.22), random(seed + 1)))
  }
  return points.slice(1).flatMap((p, i) => roughSegment(points[i]!, p, roughness, original < 2, single, next))
}

function cubicPoint([a, b, c, d]: Cubic, t: number): Point {
  const u = 1 - t
  const at = (axis: 0 | 1) => u ** 3 * a[axis] + 3 * u * u * t * b[axis] + 3 * u * t * t * c[axis] + t ** 3 * d[axis]
  return [at(0), at(1)]
}

function roots(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b]
  const discriminant = b * b - 4 * a * c
  if (discriminant < 0) return []
  const root = Math.sqrt(discriminant)
  return [(-b + root) / (2 * a), (-b - root) / (2 * a)]
}

function curvesBounds(curves: Cubic[], position = (p: Point) => p): Bounds {
  const bounds = emptyBounds()
  for (const curve of curves) {
    const [a, b, c, d] = [position(curve[0]), position(curve[1]), position(curve[2]), position(curve[3])] as const
    include(bounds, a)
    include(bounds, d)
    for (const axis of [0, 1] as const) {
      const ab = b[axis] - a[axis], bc = c[axis] - b[axis], cd = d[axis] - c[axis]
      for (const t of roots(3 * (ab - 2 * bc + cd), 6 * (bc - ab), 3 * ab)) {
        if (t > 0 && t < 1) include(bounds, cubicPoint([a, b, c, d], t))
      }
    }
  }
  return bounds
}

function roundedMidpoint(curves: Cubic[], end: Point): Point {
  let closest = curves[0]!
  let distance = Infinity
  for (const curve of curves) {
    const gap = Math.hypot(curve[3][0] - end[0], curve[3][1] - end[1])
    if (gap < distance) {
      distance = gap
      closest = curve
    }
  }
  const samples = Array.from({ length: 20 }, (_, i) => cubicPoint(closest, i / 20))
  const lengths = [0]
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!, b = samples[i]!
    lengths.push(lengths[i - 1]! + Math.hypot(a[0] - b[0], a[1] - b[1]))
  }
  const half = lengths.at(-1)! / 2
  if (half === 0) return cubicPoint(closest, 0.5)
  const high = lengths.findIndex(length => length >= half)
  const low = lengths[high - 1]!
  // Excalidraw's exact-hit branch uses the opposite parameter direction.
  const t = lengths[high] === half ? 1 - high / 19 : (high - 1 + (half - low) / (lengths[high]! - low)) / 19
  return cubicPoint(closest, t)
}

function boundText(element: Element, elements: Map<string, Element>): Element | undefined {
  if (!Array.isArray(element.boundElements)) return undefined
  for (const ref of element.boundElements) {
    if (ref?.type !== 'text' || typeof ref.id !== 'string') continue
    const text = elements.get(ref.id)
    if (text?.type === 'text') return text
  }
  return undefined
}

function offsetText(midpoint: Point, points: Point[], width: number, height: number): Point {
  const [cx, cy] = center(pointsBounds(points))
  let nx = midpoint[0] - cx, ny = midpoint[1] - cy
  let length = Math.hypot(nx, ny)
  if (length < 0.5) {
    const middle = Math.floor(points.length / 2)
    const a = points[middle - 1]!, b = points[Math.min(points.length - 1, middle + points.length % 2)]!
    const tx = b[0] - a[0], ty = b[1] - a[1]
    nx = -ty
    ny = tx
    if ((Math.abs(tx) >= Math.abs(ty) && ny > 0) || (Math.abs(tx) < Math.abs(ty) && nx > 0)) {
      nx = -nx
      ny = -ny
    }
    length = Math.hypot(nx, ny) || 1
  }
  nx /= length
  ny /= length
  const margin = Math.abs(nx) * width / 2 + Math.abs(ny) * height / 2 + 5
  return [midpoint[0] + nx * margin, midpoint[1] + ny * margin]
}

function includeConnectorText(bounds: Bounds, centerOfText: Point, width: number, height: number, angle: number): void {
  const [mx, my] = centerOfText
  const origin = center(bounds)
  const topLeft = rotate([bounds.minX, bounds.minY], origin, angle)
  const topRight = rotate([bounds.maxX, bounds.minY], origin, angle)
  const left = mx - width / 2, top = my - height / 2, right = left + width, bottom = top + height
  const tl = rotate([left, top], origin, -angle), tr = rotate([right, top], origin, -angle)
  const bl = rotate([left, bottom], origin, -angle), br = rotate([right, bottom], origin, -angle)
  if (topLeft[0] < topRight[0] && topLeft[1] >= topRight[1]) {
    bounds.minX = Math.min(bounds.minX, bl[0])
    bounds.maxX = Math.max(bounds.maxX, tr[0], br[0])
    bounds.minY = Math.min(bounds.minY, tl[1])
    bounds.maxY = Math.max(bounds.maxY, br[1])
  } else if (topLeft[0] >= topRight[0] && topLeft[1] > topRight[1]) {
    bounds.minX = Math.min(bounds.minX, br[0])
    bounds.maxX = Math.max(bounds.maxX, tl[0], tr[0])
    bounds.minY = Math.min(bounds.minY, bl[1])
    bounds.maxY = Math.max(bounds.maxY, tr[1])
  } else if (topLeft[0] >= topRight[0]) {
    bounds.minX = Math.min(bounds.minX, tr[0])
    bounds.maxX = Math.max(bounds.maxX, bl[0])
    bounds.minY = Math.min(bounds.minY, br[1])
    bounds.maxY = Math.max(bounds.maxY, tl[1])
  } else {
    bounds.minX = Math.min(bounds.minX, tr[0], tl[0])
    bounds.maxX = Math.max(bounds.maxX, br[0])
    bounds.minY = Math.min(bounds.minY, tr[1])
    bounds.maxY = Math.max(bounds.maxY, bl[1])
  }
}

function linearBounds(element: Element, elements: Map<string, Element>, x: number, y: number, angle: number): Bounds {
  const points = localPoints(element.points)
  const connector = (element.type === 'line' || element.type === 'arrow') && points.length > 1
  const curves = connector ? connectorCurves(element, points) : []
  const pivot = center(connector ? curvesBounds(curves) : pointsBounds(points))
  const position = (p: Point): Point => {
    const [px, py] = rotate(p, pivot, angle)
    return [px + x, py + y]
  }
  const world = points.map(position)
  if (!connector) return pointsBounds(world)
  const bounds = curvesBounds(curves, position)
  const text = boundText(element, elements)
  if (text) {
    const width = dimension(text.width), height = dimension(text.height)
    const mid = Math.floor(points.length / 2)
    let midpoint = world[mid]!
    if (points.length % 2 === 0) {
      const before = world[mid - 1]!
      midpoint = element.roundness != null && points.length > 2
        ? position(roundedMidpoint(curves, points[mid]!))
        : [(before[0] + midpoint[0]) / 2, (before[1] + midpoint[1]) / 2]
    }
    includeConnectorText(bounds, offsetText(midpoint, world, width, height), width, height, angle)
  }
  return bounds
}

function elementBounds(element: Element, elements: Map<string, Element>): Bounds {
  const x = number(element.x), y = number(element.y)
  const angle = element.angle === undefined ? 0 : number(element.angle)
  const type = element.type
  if (type === 'line' || type === 'arrow' || type === 'freedraw') return linearBounds(element, elements, x, y, angle)
  const width = dimension(element.width), height = dimension(element.height)
  const cx = x + width / 2, cy = y + height / 2
  if (type === 'ellipse') {
    const cos = Math.cos(angle), sin = Math.sin(angle)
    const rx = Math.hypot(width / 2 * cos, height / 2 * sin)
    const ry = Math.hypot(height / 2 * cos, width / 2 * sin)
    return { minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry }
  }
  const outline: Point[] = type === 'diamond'
    ? [[cx, y], [x + width, cy], [cx, y + height], [x, cy]]
    : [[x, y], [x + width, y], [x + width, y + height], [x, y + height]]
  return pointsBounds(outline.map(point => rotate(point, [cx, cy], angle)))
}

export function selectionAnchor(ids: string[], elements: Map<string, Element>): Point {
  const bounds = emptyBounds()
  for (const id of ids) {
    const b = elementBounds(elements.get(id)!, elements)
    include(bounds, [b.minX, b.minY])
    include(bounds, [b.maxX, b.maxY])
  }
  return ids.length === 1 ? [bounds.maxX, bounds.minY] : center(bounds)
}
