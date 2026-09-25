import {
  areaD,
  booleanOpD,
  booleanOpDWithPolyTree,
  ClipType,
  EndType,
  FillRule,
  inflatePathsD,
  JoinType,
  pointInPolygonD,
  PointInPolygonResult,
  PolyTreeD,
  type PathD,
  type PathsD,
  type PolyPathD,
} from 'clipper2-ts'
import { polylineBounds, shapeToPolylines, tabPositions } from '../lib/geometry'
import { findBit } from '../lib/library'
import { MAX_STEPOVER, tabsActive, type BitRole, type Cut, type CutSettings, type Point, type Project, type Shape } from '../model'
import { opsTime } from './gcode'

export type Pt3 = [number, number, number]
// rapid: G0 at safe Z. plunge: Z move at plunge feed. Otherwise G1 at cutting feed.
export interface Segment {
  points: Pt3[]
  rapid: boolean
  plunge?: boolean
}
export interface Op {
  role: BitRole
  shapeId: string
  kind: 'outline' | 'pocket' | 'pocket-detail' | 'vcarve'
  segments: Segment[]
}
export interface CamResult {
  ops: Op[]
  warnings: string[]
  timeSec: Record<BitRole, number>
}

const PRECISION = 3 // decimals, 0.001 mm
const ARC_TOLERANCE = 0.01 // mm
const SLIVER = 0.02 // mm; rest-machining leftovers thinner than this are float noise

const fillRule = (s: Shape) => (s.fillRule === 'evenodd' ? FillRule.EvenOdd : FillRule.NonZero)
const boolean = (type: ClipType, a: PathsD, b: PathsD | null) => booleanOpD(type, a, b, FillRule.NonZero, PRECISION)
export const inflate = (paths: PathsD, delta: number) =>
  delta ? inflatePathsD(paths, delta, JoinType.Round, EndType.Polygon, 2, PRECISION, ARC_TOLERANCE) : paths

// Filled area of the closed contours; outers have positive area (CCW, Y up), holes negative.
export function shapeRegion(shape: Shape): PathsD {
  const closed = shapeToPolylines(shape)
    .filter((p) => p.closed && p.points.length > 2)
    .map((p) => p.points.map(([x, y]) => ({ x, y })))
  return booleanOpD(ClipType.Union, closed, null, fillRule(shape), PRECISION)
}

// Each outer contour with its direct holes; islands inside holes become their own entries.
function islands(region: PathsD): PathsD[] {
  const tree = new PolyTreeD()
  booleanOpDWithPolyTree(ClipType.Union, region, null, tree, FillRule.NonZero, PRECISION)
  const out: PathsD[] = []
  const walk = (outer: PolyPathD) => {
    const island = [outer.poly!]
    for (let i = 0; i < outer.count; i++) {
      const hole = outer.child(i)
      island.push(hole.poly!)
      for (let j = 0; j < hole.count; j++) walk(hole.child(j))
    }
    out.push(island)
  }
  for (let i = 0; i < tree.count; i++) walk(tree.child(i))
  return out
}

export const outlinePaths = (region: PathsD, side: Cut['side'], r: number) => inflate(region, side === 'on' ? 0 : side === 'outside' ? r : -r)

// Tool-centre rings, innermost first; the last one (offset -r) is the finishing wall.
export function pocketRings(region: PathsD, r: number, step: number): PathsD[] {
  const rings: PathsD[] = []
  for (let d = r; ; d += step) {
    const ring = inflate(region, -d)
    if (!ring.length) break
    rings.push(ring)
  }
  return rings.reverse()
}

// Spindle turns clockwise seen from above, so climb milling keeps the finished wall on the tool's right:
// outside contours (wall inside the path) run CW, inside contours CCW. Conventional is the reverse.
export function orient(path: PathD, outside: boolean, direction: CutSettings['direction']): PathD {
  const cw = outside === (direction === 'climb')
  return areaD(path) < 0 === cw ? path : [...path].reverse()
}

export function zLevels(depth: number, stepdown: number): number[] {
  const n = Math.max(1, Math.ceil(depth / stepdown - 1e-9))
  return Array.from({ length: n }, (_, i) => -Math.min(depth, (i + 1) * stepdown))
}

const closedPts = (path: PathD): Point[] => [...path, path[0]].map((p): Point => [p.x, p.y])

function arcLengths(pts: Point[]) {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  return cum
}

const lerpPt = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

// Distance from p to a polyline and the arc length of the closest point on it.
function nearest(pts: Point[], cum: number[], [x, y]: Point) {
  let best = { d: Infinity, s: 0 }
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]]
    const len = cum[i] - cum[i - 1]
    const t = len ? Math.min(1, Math.max(0, ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / (len * len))) : 0
    const [px, py] = lerpPt(a, b, t)
    const d = Math.hypot(x - px, y - py)
    if (d < best.d) best = { d, s: cum[i - 1] + t * len }
  }
  return best
}

// Tabs go where the canvas draws them (tabPositions on the design outline), projected onto this loop.
// The loop is restarted in the middle of the widest gap between tabs so the plunge never lands on one.
export function placeTabs(pts: Point[], tabPoints: Point[]): { pts: Point[]; centres: number[] } {
  if (!tabPoints.length) return { pts, centres: [] }
  const cum = arcLengths(pts)
  const total = cum.at(-1)!
  const s = tabPoints.map((p) => nearest(pts, cum, p).s).sort((a, b) => a - b)
  let s0 = 0
  let gap = -1
  s.forEach((a, i) => {
    const b = i + 1 < s.length ? s[i + 1] : s[0] + total
    if (b - a > gap) [gap, s0] = [b - a, (a + (b - a) / 2) % total]
  })
  const j = Math.max(1, cum.findIndex((c) => c > s0)) - 1
  const p = lerpPt(pts[j], pts[j + 1], cum[j + 1] > cum[j] ? (s0 - cum[j]) / (cum[j + 1] - cum[j]) : 0)
  return { pts: [p, ...pts.slice(j + 1, -1), ...pts.slice(0, j + 1), p], centres: s.map((a) => (a - s0 + total) % total) }
}

// Raises Z to tabZ over width around each centre (arc length along the closed loop pts).
export function withTabs(pts: Point[], z: number, tabZ: number, centres: number[], width: number): Pt3[] {
  const cum = arcLengths(pts)
  const total = cum.at(-1)!
  const events = centres
    .flatMap((c): [number, number][] => [
      [Math.max(0, c - width / 2), 1],
      [Math.min(total, c + width / 2), -1],
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let up = 0
  let i = 1
  const zNow = () => (up > 0 ? tabZ : z)
  const out: Pt3[] = [[...pts[0], z]]
  for (const [s, step] of events) {
    for (; i < pts.length - 1 && cum[i] < s; i++) out.push([...pts[i], zNow()])
    const seg = cum[i] - cum[i - 1]
    const p = lerpPt(pts[i - 1], pts[i], seg ? (s - cum[i - 1]) / seg : 0)
    out.push([...p, zNow()])
    up += step
    out.push([...p, zNow()])
  }
  for (; i < pts.length; i++) out.push([...pts[i], zNow()])
  return out
}

// A feed move at depth is safe if it stays inside the tool-centre region (the finishing wall).
function inside([x, y]: Point, paths: PathsD) {
  let w = 0
  for (const path of paths) {
    const r = pointInPolygonD({ x, y }, path, PRECISION)
    const outer = areaD(path) > 0
    if (r === PointInPolygonResult.IsInside || (r === PointInPolygonResult.IsOn && outer)) w += outer ? 1 : -1
  }
  return w > 0
}

const safeLink = (a: Point, b: Point, wall: PathsD) => !crosses(a, b, wall) && inside(lerpPt(a, b, 0.5), wall)

// True if segment ab properly crosses any edge of paths (touching at a or b doesn't count).
function crosses(a: Point, b: Point, paths: PathsD): boolean {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  for (const path of paths) {
    for (let i = 0; i < path.length; i++) {
      const p = path[i]
      const q = path[(i + 1) % path.length]
      const ex = q.x - p.x
      const ey = q.y - p.y
      const d = dx * ey - dy * ex
      if (Math.abs(d) < 1e-12) continue
      const t = ((p.x - a[0]) * ey - (p.y - a[1]) * ex) / d
      const u = ((p.x - a[0]) * dy - (p.y - a[1]) * dx) / d
      if (t > 1e-6 && t < 1 - 1e-6 && u >= 0 && u <= 1) return true
    }
  }
  return false
}

function linker(safeZ: number) {
  const segments: Segment[] = []
  let cur: Pt3 | null = null
  return {
    segments,
    get cur() {
      return cur
    },
    // direct: feed straight across at the current depth (only through cleared area) instead of retracting.
    moveTo(p: Pt3, direct: boolean) {
      let z = safeZ
      if (cur && direct) {
        z = cur[2]
        if (cur[0] !== p[0] || cur[1] !== p[1]) segments.push({ rapid: false, points: [[p[0], p[1], z]] })
      } else segments.push({ rapid: true, points: [...(cur ? [[cur[0], cur[1], safeZ] as Pt3] : []), [p[0], p[1], safeZ]] })
      if (z !== p[2]) segments.push({ rapid: false, plunge: true, points: [p] })
      cur = p
    },
    cut(points: Pt3[]) {
      if (!points.length) return
      segments.push({ rapid: false, points })
      cur = points.at(-1)!
    },
    finish() {
      if (cur) segments.push({ rapid: true, points: [[cur[0], cur[1], safeZ]] })
      return segments
    },
  }
}

function pocketSegments(region: PathsD, r: number, s: CutSettings, depth: number) {
  const plan = islands(region)
    .map((island) => {
      const rings = pocketRings(island, r, Math.min(MAX_STEPOVER, s.stepover) * 2 * r)
      return { wall: rings.at(-1) ?? [], rings: rings.map((level) => level.map((p) => closedPts(orient(p, areaD(p) < 0, s.direction)))) }
    })
    .filter((isl) => isl.rings.length)
  const L = linker(s.safeZ)
  let prev: (typeof plan)[number] | null = null
  for (const z of zLevels(depth, s.stepdown)) {
    for (const isl of plan) {
      for (const ring of isl.rings.flat()) {
        const c = L.cur
        L.moveTo([...ring[0], z], prev === isl && !!c && safeLink([c[0], c[1]], ring[0], isl.wall))
        L.cut(ring.slice(1).map((p): Pt3 => [...p, z]))
        prev = isl
      }
    }
  }
  return L.finish()
}

export function planProject(project: Project): CamResult {
  const { stock, bits, cutSettings } = project
  const t = stock.thickness
  const ops: Op[] = []
  const last: Op[] = [] // outside outlines, cut after everything else so parts aren't freed before their pockets
  const warnings: string[] = []
  const carved = project.shapes.filter((s) => s.cut)
  if (!carved.length) warnings.push('Nothing to carve')
  const rs = cutSettings.rough
  const r = findBit(bits.rough).diameter / 2
  const detailBit = bits.detail ? findBit(bits.detail) : null
  const ds = cutSettings.detail
  const usableDetail = detailBit && ds && detailBit.type !== 'vbit' && detailBit.diameter < 2 * r

  for (const shape of carved) {
    const cut = shape.cut!
    if (cut.type === 'vcarve') {
      warnings.push('V-carve is not generated yet')
      continue
    }
    if (cut.depth > t + 1e-9) warnings.push(`${shape.name} is deeper than the stock`)
    const depth = Math.min(cut.depth, t)
    const polys = shapeToPolylines(shape)
    if (!polys.length) {
      warnings.push(`Font still loading for ${shape.name}`)
      continue
    }
    const b = polylineBounds(polys)
    if (b.minX < 0 || b.minY < 0 || b.maxX > stock.w || b.maxY > stock.h) warnings.push(`${shape.name} is partly outside the stock`)
    const region = shapeRegion(shape)
    const tooLarge = `Bit too large for ${shape.name}`
    const push = (list: Op[], role: BitRole, kind: Op['kind'], segments: Segment[]) =>
      segments.length && list.push({ role, shapeId: shape.id, kind, segments })

    if (cut.type === 'outline') {
      const paths = outlinePaths(region, cut.side, r)
      const inside = cut.side === 'inside'
      if (inside && region.length && !paths.length) warnings.push(tooLarge)
      else if (inside && paths.length < region.length) warnings.push(`Bit too large for parts of ${shape.name}`)
      const tabZ = tabsActive(cut, t) ? -(t - cut.tabHeight) : null
      const zs = zLevels(depth, rs.stepdown)
      const loops = paths.map((path) => closedPts(orient(path, areaD(path) > 0 !== inside, rs.direction)))
      const tabsFor = loops.map((): Point[] => [])
      if (tabZ !== null && loops.length) {
        for (const { point } of polys.filter((p) => p.closed).flatMap((p) => tabPositions([p], cut.tabCount))) {
          const d = loops.map((l) => nearest(l, arcLengths(l), point).d)
          tabsFor[d.indexOf(Math.min(...d))].push(point)
        }
      }
      const L = linker(rs.safeZ)
      loops.forEach((loop, k) => {
        const { pts, centres } = placeTabs(loop, tabsFor[k])
        zs.forEach((z, i) => {
          const pass = tabZ !== null && z < tabZ && centres.length ? withTabs(pts, z, tabZ, centres, cut.tabWidth) : pts.map((p): Pt3 => [...p, z])
          L.moveTo(pass[0], i > 0)
          L.cut(pass.slice(1))
        })
      })
      // Open paths retract between passes: going back to the start at depth would cut through stock.
      for (const { points } of cut.side === 'on' ? polys.filter((p) => !p.closed) : []) {
        for (const z of zs) {
          L.moveTo([...points[0], z], false)
          L.cut(points.slice(1).map((p): Pt3 => [...p, z]))
        }
      }
      push(cut.side === 'outside' ? last : ops, 'rough', 'outline', L.finish())
      continue
    }

    if (region.length && !inflate(region, -r).length) warnings.push(tooLarge)
    push(ops, 'rough', 'pocket', pocketSegments(region, r, rs, depth))
    // Rest machining: what the rough bit's radius couldn't reach, widened so the detail bit can get in, clipped to the pocket.
    const open = (p: PathsD, d: number) => inflate(inflate(p, -d), d)
    const rest = open(boolean(ClipType.Difference, region, open(region, r)), SLIVER)
    if (usableDetail) {
      const dr = detailBit.diameter / 2
      if (rest.length) push(ops, 'detail', 'pocket-detail', pocketSegments(boolean(ClipType.Intersection, region, inflate(rest, 2 * dr)), dr, ds, depth))
    } else {
      if (detailBit && detailBit.type !== 'vbit') warnings.push('The detail bit must be smaller than the rough bit')
      // Round inside corners always leave a little rest (about 0.17 r deep); only warn about more than that.
      if (inflate(rest, -0.25 * r).length) warnings.push(`The rough bit can't reach all of ${shape.name}; add a smaller detail bit`)
    }
  }
  ops.push(...last)

  const time = (role: BitRole) => {
    const s = cutSettings[role]
    return s ? opsTime(ops.filter((o) => o.role === role), s) : 0
  }
  return { ops, warnings: [...new Set(warnings)], timeSec: { rough: time('rough'), detail: time('detail') } }
}
