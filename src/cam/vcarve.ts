import type { PathsD } from 'clipper2-ts'
import { Delaunay } from 'd3-delaunay'

export type MedialPoint = [number, number, number] // x, y, clearance (distance to the nearest boundary)

export const SPACING = 0.15 // mm between boundary samples
const MAX_SAMPLES = 60_000
// A Voronoi edge is kept only if the boundary between its two generating samples dips at least this far into their
// empty circle. Flattened curves (0.02 mm chord tolerance) never dip more than 0.02, so their star of bisectors to
// every vertex goes; real corners and strokes stay. Dropping an edge leaves at most this much uncut next to it.
const SAGITTA = 0.05 // mm
const SIMPLIFY = 0.005 // mm, in x, y and clearance

// Approximate medial axis of a region (outers CCW, holes CW) from the Voronoi diagram of dense boundary samples.
// Returns polylines of [x, y, clearance] and the sample spacing used (raised for huge shapes).
// ponytail: spacing is uniform per shape; adaptive sampling if very large shapes need fine detail.
export function medialAxis(region: PathsD, spacing = SPACING): { chains: MedialPoint[][]; spacing: number } {
  const perimeter = region.reduce((a, path) => a + path.reduce((b, p, i) => b + dist(p.x, p.y, path[(i + 1) % path.length].x, path[(i + 1) % path.length].y), 0), 0)
  const s = Math.max(spacing, perimeter / MAX_SAMPLES)

  // Samples include every region vertex, so consecutive samples span the exact boundary.
  const xy: number[] = []
  const prev: number[] = []
  const next: number[] = []
  const convex: { v: [number, number]; o: [number, number]; q: [number, number] }[] = [] // corner and its neighbours
  for (const path of region) {
    const start = xy.length / 2
    path.forEach((p, i) => {
      const q = path[(i + 1) % path.length]
      const o = path[(i + path.length - 1) % path.length]
      if ((p.x - o.x) * (q.y - p.y) - (p.y - o.y) * (q.x - p.x) > 0) convex.push({ v: [p.x, p.y], o: [o.x, o.y], q: [q.x, q.y] }) // left turn: interior on the left
      const n = Math.max(1, Math.ceil(dist(p.x, p.y, q.x, q.y) / s))
      for (let j = 0; j < n; j++) xy.push(p.x + ((q.x - p.x) * j) / n, p.y + ((q.y - p.y) * j) / n)
    })
    const end = xy.length / 2
    for (let i = start; i < end; i++) {
      prev.push(i === start ? end - 1 : i - 1)
      next.push(i === end - 1 ? start : i + 1)
    }
  }
  const n = xy.length / 2
  if (n < 3) return { chains: [], spacing: s }

  // Winding number over the sample loops, with edges bucketed into horizontal rows.
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 1; i < xy.length; i += 2) [minY, maxY] = [Math.min(minY, xy[i]), Math.max(maxY, xy[i])]
  const rowH = 4 * s
  const rows: number[][] = Array.from({ length: Math.floor((maxY - minY) / rowH) + 1 }, () => [])
  for (let i = 0; i < n; i++) {
    const [a, b] = [xy[2 * i + 1], xy[2 * next[i] + 1]]
    for (let r = Math.floor((Math.min(a, b) - minY) / rowH); r <= Math.floor((Math.max(a, b) - minY) / rowH); r++) rows[r].push(i)
  }
  const winding = (x: number, y: number) => {
    let w = 0
    for (const i of rows[Math.floor((y - minY) / rowH)] ?? []) {
      const [ax, ay, bx, by] = [xy[2 * i], xy[2 * i + 1], xy[2 * next[i]], xy[2 * next[i] + 1]]
      const left = (bx - ax) * (y - ay) - (x - ax) * (by - ay)
      if (ay <= y) {
        if (by > y && left > 0) w++
      } else if (by <= y && left < 0) w--
    }
    return w
  }
  const segDist = (x: number, y: number, i: number, j: number) => {
    const [ax, ay, bx, by] = [xy[2 * i], xy[2 * i + 1], xy[2 * j], xy[2 * j + 1]]
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2)) : 0
    return dist(x, y, ax + t * (bx - ax), ay + t * (by - ay))
  }
  // Distance to the boundary segments on either side of the given samples.
  const clearance = (x: number, y: number, gens: number[]) => Math.min(...gens.flatMap((g) => [segDist(x, y, prev[g], g), segDist(x, y, g, next[g])]))

  // Voronoi vertices = triangle circumcentres. R: distance to the generators; C: distance to the boundary segments
  // next to them (the true clearance, give or take a sagitta).
  const { triangles, halfedges } = new Delaunay(Float64Array.from(xy))
  const nt = triangles.length / 3
  const cx = new Float64Array(nt)
  const cy = new Float64Array(nt)
  const R = new Float64Array(nt)
  const C = new Float64Array(nt)
  const keep = new Uint8Array(nt)
  for (let t = 0; t < nt; t++) {
    const [a, b, c] = [triangles[3 * t], triangles[3 * t + 1], triangles[3 * t + 2]]
    const [ax, ay] = [xy[2 * a], xy[2 * a + 1]]
    const [bx, by, qx, qy] = [xy[2 * b] - ax, xy[2 * b + 1] - ay, xy[2 * c] - ax, xy[2 * c + 1] - ay]
    const d = 2 * (bx * qy - by * qx)
    if (Math.abs(d) < 1e-12) continue
    const b2 = bx * bx + by * by
    const c2 = qx * qx + qy * qy
    const [ux, uy] = [(qy * b2 - by * c2) / d, (bx * c2 - qx * b2) / d]
    cx[t] = ax + ux
    cy[t] = ay + uy
    R[t] = Math.hypot(ux, uy)
    C[t] = clearance(cx[t], cy[t], [a, b, c])
    keep[t] = +(C[t] > 1e-3 && winding(cx[t], cy[t]) !== 0)
  }

  // Graph on kept triangles; one Voronoi edge per interior Delaunay edge (a, b).
  const edges: [number, number, number, number][] = [] // triangles t1, t2 and generating samples a, b
  const adj = new Map<number, number[]>()
  for (let e = 0; e < halfedges.length; e++) {
    const o = halfedges[e]
    if (o < e) continue
    const [t1, t2] = [Math.floor(e / 3), Math.floor(o / 3)]
    if (!keep[t1] || !keep[t2]) continue
    const a = triangles[e]
    const b = triangles[e % 3 === 2 ? e - 2 : e + 1]
    if (next[a] === b || prev[a] === b) continue // spur to a single boundary sample
    const r = Math.max(R[t1], R[t2])
    const h = dist(xy[2 * a], xy[2 * a + 1], xy[2 * b], xy[2 * b + 1]) / 2
    if (r - Math.sqrt(Math.max(0, r * r - h * h)) < SAGITTA) continue
    for (const t of [t1, t2]) adj.set(t, [...(adj.get(t) ?? []), edges.length])
    edges.push([t1, t2, a, b])
  }

  // Chain edges into polylines: from every leaf/junction, then the remaining cycles.
  const used = new Uint8Array(edges.length)
  const deg = (t: number) => adj.get(t)!.length
  // Clearance along an edge (distance to two points, or their segments) is convex, not linear: long edges get
  // intermediate points with their exact clearance so interpolating between points never cuts too deep.
  const walk = (t: number, e: number) => {
    const from = t
    const pts: MedialPoint[] = [[cx[t], cy[t], C[t]]]
    for (;;) {
      used[e] = 1
      const [t1, t2, a, b] = edges[e]
      const u = t
      t = t1 === t ? t2 : t1
      const n = Math.ceil(dist(cx[u], cy[u], cx[t], cy[t]) / s)
      for (let j = 1; j < n; j++) {
        const [x, y] = [cx[u] + ((cx[t] - cx[u]) * j) / n, cy[u] + ((cy[t] - cy[u]) * j) / n]
        pts.push([x, y, clearance(x, y, [a, b])])
      }
      pts.push([cx[t], cy[t], C[t]])
      const nextEdge = deg(t) === 2 ? adj.get(t)!.find((f) => !used[f]) : undefined
      if (nextEdge === undefined) return { from, to: t, pts }
      e = nextEdge
    }
  }
  const walks: ReturnType<typeof walk>[] = []
  for (const [t, es] of adj) if (es.length !== 2) for (const e of es) if (!used[e]) walks.push(walk(t, e))
  edges.forEach(([t], e) => !used[e] && walks.push(walk(t, e)))

  // Leaves near a convex corner run on into it (clearance 0) so corners are cut to a point. Only when the leaf sits
  // on the corner's bisector at its own clearance from both sides, where clearance falls linearly to the tip.
  const lineDist = (p: MedialPoint, [ax, ay]: [number, number], [bx, by]: [number, number]) =>
    Math.abs((bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax)) / dist(ax, ay, bx, by)
  const extend = (t: number, p: MedialPoint): MedialPoint[] => {
    if (deg(t) !== 1) return []
    let best: [number, number] | null = null
    let bd = Math.max(3 * s, 4 * p[2])
    for (const { v, o, q } of convex) {
      const d = dist(p[0], p[1], v[0], v[1])
      // Beyond 3 s, only corners sharp enough to matter by the same sagitta rule (not every flattened-curve vertex).
      const sharp = d <= 3 * s || p[2] * (1 - p[2] / d) >= SAGITTA
      if (d < bd && sharp && Math.abs(lineDist(p, o, v) - p[2]) < 0.02 && Math.abs(lineDist(p, v, q) - p[2]) < 0.02) [best, bd] = [v, d]
    }
    return best ? [[best[0], best[1], 0]] : []
  }
  const chains = walks.map(({ from, to, pts }) => [...extend(from, pts[0]), ...simplify(pts), ...extend(to, pts.at(-1)!)])
  return { chains: chains.filter((c) => c.length > 1), spacing: s }
}

const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay)

function dist3(p: MedialPoint, a: MedialPoint, b: MedialPoint) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const len2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / len2)) : 0
  return Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1], p[2] - a[2] - t * d[2])
}

// Douglas-Peucker in (x, y, clearance).
function simplify(pts: MedialPoint[]): MedialPoint[] {
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [i, j] = stack.pop()!
    let [best, m] = [SIMPLIFY, -1]
    for (let k = i + 1; k < j; k++) {
      const d = dist3(pts[k], pts[i], pts[j])
      if (d > best) [best, m] = [d, k]
    }
    if (m >= 0) {
      keep[m] = 1
      stack.push([i, m], [m, j])
    }
  }
  return pts.filter((_, i) => keep[i])
}
