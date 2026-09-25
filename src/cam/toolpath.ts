import {
  areaD,
  booleanOpD,
  booleanOpDWithPolyTree,
  ClipType,
  EndType,
  FillRule,
  inflatePathsD,
  JoinType,
  PolyTreeD,
  type PathD,
  type PathsD,
  type PolyPathD,
} from 'clipper2-ts'
import { polylineBounds, shapeToPolylines } from '../lib/geometry'
import { findBit } from '../lib/library'
import { tabsActive, type BitRole, type Cut, type CutSettings, type Point, type Project, type Shape } from '../model'
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
  version: number
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
// ponytail: stepover above 50% can leave a nub inside the innermost ring; add a centre clean-up pass if that matters.
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

// Raises Z to tabZ over each tab. Centres are at arc length (k + 0.5) · L / count, the same spots tabPositions() draws.
export function withTabs(pts: Point[], z: number, tabZ: number, count: number, width: number): Pt3[] {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  const total = cum.at(-1)!
  const events: [number, number][] = []
  for (let k = 0; k < count; k++) {
    const s = ((k + 0.5) * total) / count
    events.push([Math.max(0, s - width / 2), 1], [Math.min(total, s + width / 2), -1])
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let up = 0
  let i = 1
  const zNow = () => (up > 0 ? tabZ : z)
  const out: Pt3[] = [[...pts[0], z]]
  for (const [s, step] of events) {
    for (; i < pts.length && cum[i] < s; i++) out.push([...pts[i], zNow()])
    const seg = cum[i] - cum[i - 1]
    const t = seg ? (s - cum[i - 1]) / seg : 0
    const p: Point = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]
    out.push([...p, zNow()])
    up += step
    out.push([...p, zNow()])
  }
  for (; i < pts.length; i++) out.push([...pts[i], zNow()])
  return out
}

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
      const rings = pocketRings(island, r, s.stepover * 2 * r)
      return { wall: rings.at(-1) ?? [], rings: rings.map((level) => level.map((p) => closedPts(orient(p, areaD(p) < 0, s.direction)))) }
    })
    .filter((isl) => isl.rings.length)
  const L = linker(s.safeZ)
  let prev: (typeof plan)[number] | null = null
  for (const z of zLevels(depth, s.stepdown)) {
    for (const isl of plan) {
      for (const ring of isl.rings.flat()) {
        const c = L.cur
        L.moveTo([...ring[0], z], prev === isl && !!c && !crosses([c[0], c[1]], ring[0], isl.wall))
        L.cut(ring.slice(1).map((p): Pt3 => [...p, z]))
        prev = isl
      }
    }
  }
  return L.finish()
}

export function planProject(project: Project, version = 0): CamResult {
  const { stock, bits, cutSettings } = project
  const t = stock.thickness
  const ops: Op[] = []
  const warnings: string[] = []
  const carved = project.shapes.filter((s) => s.cut)
  if (!carved.length) warnings.push('Nothing to carve')
  const rs = cutSettings.rough
  const r = findBit(bits.rough).diameter / 2
  const detailBit = bits.detail ? findBit(bits.detail) : null
  const ds = cutSettings.detail

  for (const shape of carved) {
    const cut = shape.cut!
    if (cut.type === 'vcarve') {
      warnings.push('V-carve is not generated yet')
      continue
    }
    if (cut.depth > t + 1e-9) warnings.push(`${shape.name} is deeper than the stock`)
    const depth = Math.min(cut.depth, t)
    const polys = shapeToPolylines(shape)
    const b = polylineBounds(polys)
    if (b.minX < 0 || b.minY < 0 || b.maxX > stock.w || b.maxY > stock.h) warnings.push(`${shape.name} is partly outside the stock`)
    const region = shapeRegion(shape)
    const tooLarge = `Bit too large for ${shape.name}`
    const push = (role: BitRole, kind: Op['kind'], segments: Segment[]) => segments.length && ops.push({ role, shapeId: shape.id, kind, segments })

    if (cut.type === 'outline') {
      const paths = outlinePaths(region, cut.side, r)
      if (cut.side === 'inside' && region.length && !paths.length) warnings.push(tooLarge)
      const inside = cut.side === 'inside'
      const tabZ = tabsActive(cut, t) ? -(t - cut.tabHeight) : null
      const zs = zLevels(depth, rs.stepdown)
      const L = linker(rs.safeZ)
      for (const path of paths) {
        const pts = closedPts(orient(path, areaD(path) > 0 !== inside, rs.direction))
        zs.forEach((z, i) => {
          const pass = tabZ !== null && z < tabZ ? withTabs(pts, z, tabZ, cut.tabCount, cut.tabWidth) : pts.map((p): Pt3 => [...p, z])
          L.moveTo(pass[0], i > 0)
          L.cut(pass.slice(1))
        })
      }
      // Open paths retract between passes: going back to the start at depth would cut through stock.
      for (const { points } of cut.side === 'on' ? polys.filter((p) => !p.closed) : []) {
        for (const z of zs) {
          L.moveTo([...points[0], z], false)
          L.cut(points.slice(1).map((p): Pt3 => [...p, z]))
        }
      }
      push('rough', 'outline', L.finish())
      continue
    }

    if (region.length && !inflate(region, -r).length) warnings.push(tooLarge)
    push('rough', 'pocket', pocketSegments(region, r, rs, depth))
    // Rest machining: what the rough bit's radius couldn't reach, widened so the detail bit can get in, clipped to the pocket.
    if (detailBit && ds && detailBit.type !== 'vbit' && detailBit.diameter < 2 * r) {
      const open = (p: PathsD, d: number) => inflate(inflate(p, -d), d)
      const rest = open(boolean(ClipType.Difference, region, open(region, r)), SLIVER)
      const dr = detailBit.diameter / 2
      if (rest.length) push('detail', 'pocket-detail', pocketSegments(boolean(ClipType.Intersection, region, inflate(rest, 2 * dr)), dr, ds, depth))
    }
  }

  const time = (role: BitRole) => {
    const s = cutSettings[role]
    return s ? opsTime(ops.filter((o) => o.role === role), s) : 0
  }
  return { ops, warnings: [...new Set(warnings)], timeSec: { rough: time('rough'), detail: time('detail') }, version }
}
