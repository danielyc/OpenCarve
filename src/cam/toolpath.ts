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
import { polylineBounds, shapeToPolylines } from '../lib/geometry'
import { effectiveBit, vbitMaxDepth } from '../lib/library'
import { formatLength } from '../lib/units'
import { MAX_STEPOVER, tabsActive, type BitRole, type Cut, type CutSettings, type Point, type Project, type Shape } from '../model'
import { opTimes } from './gcode'
import { medialAxis, SPACING, type MedialPoint } from './vcarve'

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
  kind: 'outline' | 'pocket' | 'pocket-detail' | 'vcarve' | 'vcarve-clear'
  segments: Segment[]
  tabs?: Tab[]
  timeSec?: number // set by planProject
}
// A tab's middle on the tool-centre loop, the loop's direction there (radians from +X) and its raised length.
export type Tab = { x: number; y: number; angle: number; width: number }
export const opKey = (o: Op) => `${o.shapeId}:${o.kind}:${o.role}`

export interface CamResult {
  ops: Op[]
  shapes?: Shape[] // the project's shapes it was planned from (set on the main thread; the worker only sees copies)
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

// Morphological opening: what a disc of radius d can reach.
const opening = (p: PathsD, d: number) => inflate(inflate(p, -d), d)

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

// Tabs on one closed tool-centre loop: the shape's tabCount on its longest loop (longest), proportionally fewer on
// shorter ones but at least one, evenly spaced by arc length starting half a spacing in so the plunge at the loop's
// start never lands on a tab. At most half the loop is tab; a loop under 2 tab widths gets one tab of up to half its
// length, one under a tab width none.
export function loopTabs(pts: Point[], count: number, longest: number, width: number) {
  const cum = arcLengths(pts)
  const total = cum.at(-1)!
  if (total < width) return { centres: [], width, tabs: [] }
  const w = Math.min(width, total / 2)
  const n = Math.max(1, Math.min(Math.round((count * total) / longest), Math.floor(total / 2 / w)))
  const centres = Array.from({ length: n }, (_, i) => ((i + 0.5) * total) / n)
  const tabs = centres.map((c): Tab => {
    const j = Math.max(1, cum.findIndex((a) => a >= c))
    const [a, b] = [pts[j - 1], pts[j]]
    const [x, y] = lerpPt(a, b, cum[j] > cum[j - 1] ? (c - cum[j - 1]) / (cum[j] - cum[j - 1]) : 0)
    return { x, y, angle: Math.atan2(b[1] - a[1], b[0] - a[0]), width: w }
  })
  return { centres, width: w, tabs }
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

// Parts of a medial chain with lo < clearance <= hi (clearance is linear along each segment).
function clipBand(pts: MedialPoint[], lo: number, hi: number): MedialPoint[][] {
  const out: MedialPoint[][] = []
  let cur: MedialPoint[] | null = null
  const at = (a: MedialPoint, b: MedialPoint, t: number): MedialPoint => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
  const inBand = (c: number) => c > lo && c <= hi
  if (inBand(pts[0][2])) out.push((cur = [pts[0]]))
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]]
    const dc = b[2] - a[2]
    let [t0, t1] = [0, 1]
    if (dc) {
      const [u, v] = [(lo - a[2]) / dc, (hi - a[2]) / dc]
      t0 = Math.max(0, Math.min(u, v))
      t1 = Math.min(1, Math.max(u, v))
    } else if (!inBand(a[2])) t1 = -1
    if (t1 <= t0) {
      cur = null
      continue
    }
    if (!cur || t0 > 0) out.push((cur = [at(a, b, t0)]))
    cur.push(at(a, b, t1))
    if (t1 < 1) cur = null
  }
  return out.filter((p) => p.length > 1)
}

// Nearest-neighbour order; open paths may be reversed, closed loops (first = last) restarted at any vertex.
function nearestOrder(open: Pt3[][], loops: Pt3[][], from: Pt3 | null): Pt3[][] {
  const pool = [...open.map((p) => ({ p, loop: false })), ...loops.map((p) => ({ p, loop: true }))]
  const d2 = (a: Pt3, b: Pt3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
  const out: Pt3[][] = []
  let here = from ?? pool[0]?.p[0]
  while (pool.length) {
    let [best, bd, rev] = [0, Infinity, false]
    pool.forEach(({ p, loop }, i) => {
      if (d2(here, p[0]) < bd) [best, bd, rev] = [i, d2(here, p[0]), false]
      if (!loop && d2(here, p.at(-1)!) < bd) [best, bd, rev] = [i, d2(here, p.at(-1)!), true]
    })
    const { loop } = pool[best]
    let { p } = pool[best]
    pool[best] = pool.at(-1)!
    pool.pop()
    if (rev) p = [...p].reverse()
    if (loop) {
      let j = 0
      p.forEach((q, i) => d2(here, q) < d2(here, p[j]) && (j = i))
      p = [...p.slice(j, -1), ...p.slice(0, j), p[j]]
    }
    out.push(p)
    here = p.at(-1)!
  }
  return out
}

// V-bit with tan(half angle) k and tip flat radius f: at depth |z| it reaches f + |z|·k sideways. Pass i cuts the
// medial axis where its depth (c − f)/k falls in (z_{i-1}, z_i], and the contour of the region shrunk by f + |z_i|·k
// at z_i; the last contour outlines the flat floor at dmax. Medial parts narrower than the flat (c < f) are skipped.
function vcarveSegments(region: PathsD, chains: MedialPoint[][], k: number, f: number, dmax: number, s: CutSettings) {
  const L = linker(s.safeZ)
  zLevels(dmax, s.stepdown).forEach((z, i, zs) => {
    const hi = f - z * k
    const lo = i ? f - zs[i - 1] * k : f || -1
    const open = chains.flatMap((c) => clipBand(c, lo, hi)).map((c) => c.map(([x, y, cl]): Pt3 => [x, y, -Math.max(0, cl - f) / k]))
    const loops = inflate(region, -hi).map((p) => closedPts(orient(p, areaD(p) < 0, s.direction)).map((q): Pt3 => [...q, z]))
    for (const path of nearestOrder(open, loops, L.cur)) {
      const c = L.cur
      L.moveTo(path[0], !!c && Math.hypot(c[0] - path[0][0], c[1] - path[0][1]) < 0.05)
      L.cut(path.slice(1))
    }
  })
  return L.finish()
}

// Every corner's medial branch dips below the flat within f/sin(θ/2) of the corner; a longer stretch is a real
// feature narrower than the flat. ponytail: length heuristic, misses narrow features shorter than 4·f.
const narrowerThanFlat = (chains: MedialPoint[][], f: number) =>
  f > 0 && chains.some((c) => clipBand(c, -1, f).some((piece) => piece.reduce((a, q, i) => a + (i ? Math.hypot(q[0] - piece[i - 1][0], q[1] - piece[i - 1][1]) : 0), 0) > 4 * f))

export function planProject(project: Project): CamResult {
  const { stock, bits, cutSettings, machine } = project
  const t = stock.thickness
  const ops: Op[] = []
  const last: Op[] = [] // through outlines not cut inside, run after everything else so parts aren't freed early
  let freed = false // a held-back outline without tabs
  const warnings: string[] = []
  if (stock.w > machine.w || stock.h > machine.h) {
    const size = (w: number, h: number) => `${+formatLength(w, project.units)}×${+formatLength(h, project.units)} ${project.units}`
    warnings.push(`Stock (${size(stock.w, stock.h)}) is larger than the machine work area (${size(machine.w, machine.h)})`)
  }
  const carved = project.shapes.filter((s) => s.cut)
  const rs = cutSettings.rough
  const roughBit = effectiveBit(project, 'rough')
  const r = roughBit.diameter / 2
  const detailBit = bits.detail ? effectiveBit(project, 'detail') : null
  const ds = cutSettings.detail
  const usableDetail = detailBit && ds && detailBit.type !== 'vbit' && detailBit.diameter < 2 * r
  const vRole: BitRole | null = detailBit?.type === 'vbit' ? 'detail' : roughBit.type === 'vbit' ? 'rough' : null

  for (const shape of carved) {
    const cut = shape.cut!
    if (cut.type === 'vcarve' && !vRole) {
      warnings.push('V-carve needs a V-bit')
      continue
    }
    if (cut.type !== 'vcarve' && cut.depth > t + 1e-9) warnings.push(`${shape.name} is deeper than the stock`)
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
    const push = (list: Op[], role: BitRole, kind: Op['kind'], segments: Segment[], tabs: Tab[] = []) =>
      segments.length && list.push({ role, shapeId: shape.id, kind, segments, ...(tabs.length && { tabs }) })

    if (cut.type === 'vcarve') {
      const vs = cutSettings[vRole!]!
      const vBit = effectiveBit(project, vRole!)
      const k = Math.tan((vBit.angle! * Math.PI) / 360)
      const f = (vBit.flat ?? 0) / 2 // Bit.flat is a diameter
      const coneDepth = vbitMaxDepth(vBit) // the UI clamps to this; files and bit edits can still exceed it
      const dmax = Math.min(cut.depth, t - 0.5, coneDepth) // never through
      if (coneDepth < Math.min(cut.depth, t - 0.5))
        warnings.push(`${shape.name}: max depth limited to ${+formatLength(coneDepth, project.units)} ${project.units} by the V-bit's diameter`)
      // The flat floor at dmax ends where the V-bit's wall meets it (inset dmax·k); the V-bit's centre stays a further f in.
      const floor = inflate(region, -dmax * k)
      if (floor.length) {
        // Flat floor: the other bit if it's a flat-ish cutter that fits, then the V-bit over what it can't reach
        // (corners, necks). V-bit rings (radius f + 0.4·tan(α/2), stepover ½): for a sharp tip, ridges of about 0.2 mm,
        // up to ~0.35 mm at corners; a flat tip only makes them lower.
        const vRings = (area: PathsD) => pocketSegments(area, f + 2 * 0.2 * k, { ...vs, stepover: MAX_STEPOVER }, dmax)
        const oRole: BitRole = vRole === 'rough' ? 'detail' : 'rough'
        const oBit = bits[oRole] ? effectiveBit(project, oRole) : null
        const or = oBit && oBit.type !== 'vbit' && cutSettings[oRole] ? oBit.diameter / 2 : 0
        if (or && inflate(floor, -or).length) {
          push(ops, oRole, 'vcarve-clear', pocketSegments(floor, or, cutSettings[oRole]!, dmax))
          const rest = opening(boolean(ClipType.Difference, floor, opening(floor, or)), SLIVER)
          if (rest.length) push(ops, vRole!, 'vcarve-clear', vRings(boolean(ClipType.Intersection, floor, inflate(rest, 2 * (f + 0.4 * k)))))
        } else {
          warnings.push(or ? `The endmill is too large for the floor of ${shape.name}; the V-bit clears it` : 'Add a flat endmill for a smoother V-carve floor')
          push(ops, vRole!, 'vcarve-clear', vRings(floor))
        }
      }
      const { chains, spacing } = medialAxis(region)
      if (spacing > SPACING) warnings.push(`${shape.name} is very large; its V-carve is less detailed`)
      if (narrowerThanFlat(chains, f)) warnings.push(`Some details of ${shape.name} are narrower than the V-bit's flat tip`)
      push(ops, vRole!, 'vcarve', vcarveSegments(region, chains, k, f, dmax, vs))
      continue
    }

    if (cut.type === 'outline') {
      const paths = outlinePaths(region, cut.side, r)
      const inside = cut.side === 'inside'
      if (inside && region.length && !paths.length) warnings.push(tooLarge)
      else if (inside && paths.length < region.length) warnings.push(`Bit too large for parts of ${shape.name}`)
      const tabZ = tabsActive(cut, t) ? -(t - cut.tabHeight) : null
      const zs = zLevels(depth, rs.stepdown)
      const loops = paths.map((path) => closedPts(orient(path, areaD(path) > 0 !== inside, rs.direction)))
      const longest = Math.max(...loops.map((l) => arcLengths(l).at(-1)!))
      const tabs: Tab[] = []
      const L = linker(rs.safeZ)
      loops.forEach((pts, k) => {
        const lt = tabZ === null ? null : loopTabs(pts, cut.tabCount, longest, cut.tabWidth)
        if (lt && !lt.centres.length)
          warnings.push(cut.side === 'outside' && areaD(paths[k]) > 0 ? `A piece of ${shape.name} is too small for a tab and will come loose` : `Loop too small for a tab in ${shape.name}`)
        tabs.push(...(lt?.tabs ?? []))
        zs.forEach((z, i) => {
          const pass = lt?.centres.length && z < tabZ! ? withTabs(pts, z, tabZ!, lt.centres, lt.width) : pts.map((p): Pt3 => [...p, z])
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
      const holdBack = cut.side !== 'inside' && cut.depth >= t
      if (holdBack && tabZ === null) freed = true
      push(holdBack ? last : ops, 'rough', 'outline', L.finish(), tabs)
      continue
    }

    push(ops, 'rough', 'pocket', pocketSegments(region, r, rs, depth))
    // Rest machining: what the rough bit's radius couldn't reach, widened so the detail bit can get in, clipped to the pocket.
    const rest = opening(boolean(ClipType.Difference, region, opening(region, r)), SLIVER)
    let detailed = false
    const fits = !!inflate(region, -r).length
    if (usableDetail) {
      const dr = detailBit.diameter / 2
      if (rest.length) detailed = !!push(ops, 'detail', 'pocket-detail', pocketSegments(boolean(ClipType.Intersection, region, inflate(rest, 2 * dr)), dr, ds, depth))
    } else {
      if (detailBit && detailBit.type !== 'vbit') warnings.push('The detail bit must be smaller than the rough bit')
      // ponytail: round inside corners always leave a little rest (about 0.17 r deep), so only leftovers wider than
      // about 0.5 r are flagged; narrower slivers go unmentioned. Measure the rest's depth if that proves too lax.
      if (fits && inflate(rest, -0.25 * r).length) warnings.push(`The rough bit can't reach all of ${shape.name}; add a smaller detail bit`)
    }
    if (region.length && !fits && !detailed) warnings.push(tooLarge) // one warning per cause: not also "can't reach"
  }
  ops.push(...last)
  if (freed && ops.some((o) => o.role === 'detail')) warnings.push('Parts are cut free before the detail pass; keep tabs on')

  const time = (role: BitRole) => {
    const s = cutSettings[role]
    const mine = ops.filter((o) => o.role === role)
    if (!s) return 0
    const secs = opTimes(mine, s)
    mine.forEach((o, i) => (o.timeSec = secs[i]))
    return secs.reduce((a, b) => a + b, 0)
  }
  return { ops, warnings: [...new Set(warnings)], timeSec: { rough: time('rough'), detail: time('detail') } }
}
