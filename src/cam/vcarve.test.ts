import { pointInPolygonD, PointInPolygonResult, type PathsD } from 'clipper2-ts'
import { describe, expect, it } from 'vitest'
import type { CompoundShape, Point, Shape } from '../model'
import { shapeRegion } from './toolpath'
import { medialAxis, type MedialPoint } from './vcarve'

const shape = (type: 'rect' | 'ellipse', w: number, h: number, rotation = 0) => ({ id: 's', type, name: 'S', x: 50, y: 50, rotation, w, h }) as Shape
const sq = (s: number): Point[] => [[-s, -s], [s, -s], [s, s], [-s, s]]
const ring: CompoundShape = { id: 'c', type: 'compound', name: 'C', x: 50, y: 50, rotation: 0, paths: [{ closed: true, points: sq(15) }, { closed: true, points: sq(10).reverse() }] }
const length = (c: MedialPoint[]) => c.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - c[i][0], p[1] - c[i][1]), 0)
const total = (chains: MedialPoint[][]) => chains.reduce((a, c) => a + length(c), 0)
// Closest point on any chain segment: [distance, interpolated clearance].
const closest = (chains: MedialPoint[][], x: number, y: number) =>
  chains
    .flatMap((c) => c.slice(1).map((b, i) => [c[i], b]))
    .map(([a, b]) => {
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)))
      return [Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy), a[2] + t * (b[2] - a[2])]
    })
    .reduce((m, d) => (d[0] < m[0] ? d : m))

// Winding-number inside test and distance to the region boundary.
function probe(region: PathsD) {
  const edges = region.flatMap((path) => path.map((a, i) => [a, path[(i + 1) % path.length]]))
  return {
    inside: (x: number, y: number) =>
      region.reduce((w, path) => {
        const area = path.reduce((a, q, i) => a + q.x * path[(i + 1) % path.length].y - path[(i + 1) % path.length].x * q.y, 0)
        return w + (pointInPolygonD({ x, y }, path) === PointInPolygonResult.IsOutside ? 0 : Math.sign(area))
      }, 0) > 0,
    dist: (x: number, y: number) =>
      Math.min(
        ...edges.map(([a, b]) => {
          const dx = b.x - a.x
          const dy = b.y - a.y
          const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)))
          return Math.hypot(x - a.x - t * dx, y - a.y - t * dy)
        }),
      ),
  }
}

describe('medial axis', () => {
  it.each([
    ['40×10 rect', shape('rect', 40, 10)],
    ['20 mm circle', shape('ellipse', 20, 20)],
    ['rotated square', shape('rect', 20, 20, 30)],
    ['ring', ring],
  ])('stays inside with honest clearance: %s', (_, s) => {
    const region = shapeRegion(s)
    const { inside, dist } = probe(region)
    const { chains } = medialAxis(region)
    for (const [x, y, c] of chains.flat()) {
      expect(inside(x, y) || c === 0).toBe(true) // corner points sit on the boundary
      expect(c).toBeLessThanOrEqual(dist(x, y) + 0.05)
    }
  })
  it('40×10 rect: a spine plus four corner diagonals', () => {
    const { chains } = medialAxis(shapeRegion(shape('rect', 40, 10)))
    expect(total(chains)).toBeGreaterThan(0.9 * (30 + 4 * 5 * Math.SQRT2))
    expect(total(chains)).toBeLessThan(1.1 * (30 + 4 * 5 * Math.SQRT2))
    const spine = chains.flat().filter((p) => Math.abs(p[1] - 50) < 0.01 && Math.abs(p[0] - 50) <= 15.01)
    expect(Math.max(...spine.map((p) => p[0])) - Math.min(...spine.map((p) => p[0]))).toBeCloseTo(30, 0)
    for (const p of spine) expect(p[2]).toBeCloseTo(5, 1)
    const corners = [[30, 45], [70, 45], [70, 55], [30, 55]]
    for (const [x, y] of corners) expect(chains.flat().some((p) => Math.hypot(p[0] - x, p[1] - y) < 1e-6 && p[2] === 0)).toBe(true)
  })
  it('flattened circle has no star', () => {
    expect(total(medialAxis(shapeRegion(shape('ellipse', 20, 20))).chains)).toBeLessThan(1.5)
  })
  it('rotated square: diagonals to the corners', () => {
    const { chains } = medialAxis(shapeRegion(shape('rect', 20, 20, 30)))
    expect(total(chains)).toBeGreaterThan(0.9 * 4 * 10 * Math.SQRT2)
    expect(total(chains)).toBeLessThan(1.1 * 4 * 10 * Math.SQRT2)
    expect(Math.max(...chains.flat().map((p) => p[2]))).toBeCloseTo(10, 1)
  })
  it('ring: a closed loop mid-ring at half the ring width', () => {
    const { chains } = medialAxis(shapeRegion(ring))
    // Mid-side points of the loop.
    for (const [x, y] of [[62.5, 50], [37.5, 50], [50, 62.5], [50, 37.5]]) {
      const [d, c] = closest(chains, x, y)
      expect(d).toBeLessThan(0.05)
      expect(c).toBeCloseTo(2.5, 1)
    }
    // Without the corner spurs (which run out to clearance 0) every chain end meets another: a loop.
    const loop = chains.filter((c) => Math.min(...c.map((p) => p[2])) > 1)
    const ends = loop.flatMap((c) => [c[0], c.at(-1)!])
    for (const e of ends) expect(ends.filter((f) => Math.hypot(f[0] - e[0], f[1] - e[1]) < 1e-6).length).toBeGreaterThanOrEqual(2)
    expect(total(loop)).toBeGreaterThan(80)
  })
})
