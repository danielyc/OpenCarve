import type { PathD, PathsD } from 'clipper2-ts'
import { describe, expect, it } from 'vitest'
import { tabPositions } from '../lib/geometry'
import { findBit, findMaterial, recommendedSettings } from '../lib/library'
import { defaultCut, newProject, type CompoundShape, type Point, type Project, type RectShape, type Shape } from '../model'
import { toGcode } from './gcode'
import { orient, outlinePaths, planProject, pocketRings, shapeRegion, withTabs, zLevels, type Pt3 } from './toolpath'

const area = (p: PathD) => p.reduce((a, q, i) => { const n = p[(i + 1) % p.length]; return a + q.x * n.y - n.x * q.y }, 0) / 2
const bounds = (paths: PathsD) => {
  const xs = paths.flat().map((p) => p.x)
  const ys = paths.flat().map((p) => p.y)
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}
const rect = (w: number, h: number, extra: Partial<RectShape> = {}): RectShape => ({ id: 'r', type: 'rect', name: 'Rect', x: 50, y: 50, rotation: 0, w, h, ...extra })

describe('regions', () => {
  it('rect is one CCW outer', () => {
    const region = shapeRegion(rect(20, 10))
    expect(region).toHaveLength(1)
    expect(area(region[0])).toBeCloseTo(200)
  })
  it('opposite-wound inner contour becomes a hole', () => {
    const sq = (s: number): Point[] => [[-s, -s], [s, -s], [s, s], [-s, s]]
    const shape: CompoundShape = { id: 'c', type: 'compound', name: 'C', x: 0, y: 0, rotation: 0, paths: [{ closed: true, points: sq(10) }, { closed: true, points: sq(5).reverse() }] }
    const areas = shapeRegion(shape).map(area).sort((a, b) => a - b)
    expect(areas[0]).toBeCloseTo(-100)
    expect(areas[1]).toBeCloseTo(400)
  })
})

describe('offset', () => {
  it('outside offset grows by the bit diameter', () => {
    const b = bounds(outlinePaths(shapeRegion(rect(100, 50)), 'outside', 1.5875))
    expect(b.w).toBeCloseTo(103.175, 2)
    expect(b.h).toBeCloseTo(53.175, 2)
  })
  it('inside of a square smaller than the bit is empty and warns', () => {
    expect(outlinePaths(shapeRegion(rect(5, 5)), 'inside', 3)).toHaveLength(0)
    const p = project([{ ...rect(5, 5), cut: { ...defaultCut(12), side: 'inside' } }], '6mm-endmill')
    expect(planProject(p).warnings).toContain('Bit too large for Rect')
  })
  it('pocket rings: count and innermost first', () => {
    const rings = pocketRings(shapeRegion(rect(50, 50)), 1.5875, 0.4 * 3.175)
    expect(rings).toHaveLength(19) // offsets 1.5875 + k·1.27 below 25
    const sizes = rings.map((r) => bounds(r).w)
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b))
    expect(sizes.at(-1)).toBeCloseTo(50 - 3.175, 2)
  })
})

describe('passes and tabs', () => {
  it('z levels end exactly at depth', () => {
    expect(zLevels(12, 5)).toEqual([-5, -10, -12])
    expect(zLevels(10, 5)).toEqual([-5, -10])
  })
  it('through outline gets 4 tabs at the tab height on deep passes only', () => {
    const p = project([{ ...rect(100, 50), cut: { ...defaultCut(12), tabCount: 4, tabWidth: 6, tabHeight: 3 } }])
    p.cutSettings.rough.stepdown = 5
    const pts = planProject(p).ops[0].segments.filter((s) => !s.rapid).flatMap((s) => s.points)
    const passes = new Map<number, Pt3[]>()
    let base = 0
    for (const q of pts) {
      if (q[2] !== -9) base = q[2]
      passes.set(base, [...(passes.get(base) ?? []), q])
    }
    expect([...passes.keys()]).toEqual([-5, -10, -12])
    expect(passes.get(-5)!.some((q) => q[2] === -9)).toBe(false)
    const final = passes.get(-12)!
    const sections: Pt3[][] = []
    final.forEach((q, i) => {
      if (q[2] !== -9) return
      if (final[i - 1]?.[2] !== -9) sections.push([])
      sections.at(-1)!.push(q)
    })
    expect(sections).toHaveLength(4)
    for (const s of sections) {
      const len = s.slice(1).reduce((a, q, i) => a + Math.hypot(q[0] - s[i][0], q[1] - s[i][1]), 0)
      expect(len).toBeCloseTo(6, 3)
    }
  })
  it('tab centres match tabPositions', () => {
    const ring: Point[] = [[0, 0], [40, 0], [40, 20], [0, 20], [0, 0]]
    const path = withTabs(ring, -12, -9, 4, 4)
    const mids: Point[] = []
    path.forEach((q, i) => {
      if (q[2] === -9 && path[i - 1][2] !== -9) {
        const end = path.findIndex((r, j) => j > i && r[2] !== -9) - 1
        mids.push([(q[0] + path[end][0]) / 2, (q[1] + path[end][1]) / 2])
      }
    })
    const expected = tabPositions([{ points: ring.slice(0, -1), closed: true }], 4).map((t) => t.point)
    mids.forEach((m, i) => {
      expect(m[0]).toBeCloseTo(expected[i][0])
      expect(m[1]).toBeCloseTo(expected[i][1])
    })
  })
})

describe('direction', () => {
  const ccw: PathD = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  it('conventional: outside CCW, inside CW; climb flips', () => {
    expect(area(orient(ccw, true, 'conventional'))).toBeGreaterThan(0)
    expect(area(orient(ccw, false, 'conventional'))).toBeLessThan(0)
    expect(area(orient(ccw, true, 'climb'))).toBeLessThan(0)
    expect(area(orient(ccw, false, 'climb'))).toBeGreaterThan(0)
  })
  it('planned outside profile follows the setting', () => {
    const p = project([{ ...rect(20, 20), cut: { ...defaultCut(12), tabs: false } }])
    const ring = planProject(p).ops[0].segments.find((s) => !s.rapid && s.points.length > 2)!.points
    expect(area(ring.map(([x, y]) => ({ x, y })))).toBeGreaterThan(0)
  })
})

describe('detail', () => {
  const pocket = { ...rect(50, 50), cut: { ...defaultCut(12), type: 'pocket' as const, depth: 3 } }
  it('rest machines the corners with the detail bit', () => {
    const p = project([pocket], '6mm-endmill', '1mm-endmill')
    const detail = planProject(p).ops.filter((o) => o.kind === 'pocket-detail')
    expect(detail).toHaveLength(1)
    const pts = detail[0].segments.filter((s) => !s.rapid).flatMap((s) => s.points)
    // Only near the corners: every cut point is within a few mm of a corner (25, 25) or (75, 75) etc.
    for (const [x, y] of pts) expect(Math.min(Math.abs(x - 25), Math.abs(x - 75)) + Math.min(Math.abs(y - 25), Math.abs(y - 75))).toBeLessThan(8)
  })
  it('no detail bit, no detail op', () => {
    expect(planProject(project([pocket])).ops.map((o) => o.kind)).toEqual(['pocket'])
  })
})

describe('plan and gcode', () => {
  const sample = () =>
    project([
      { ...rect(100, 50), id: 'a', name: 'Outline', x: 70, y: 60, cut: defaultCut(12) },
      { ...rect(40, 30), id: 'b', name: 'Pocket', x: 200, y: 100, cut: { ...defaultCut(12), type: 'pocket', depth: 3 } },
    ])
  it('through cut with tabs plus pocket', () => {
    const r = planProject(sample())
    expect(r.warnings).toEqual([])
    expect(r.ops.map((o) => [o.role, o.kind])).toEqual([
      ['rough', 'outline'],
      ['rough', 'pocket'],
    ])
    expect(r.timeSec.rough).toBeGreaterThan(0)
  })
  it('warns about nothing to carve, v-carve and out-of-stock shapes', () => {
    expect(planProject(project([])).warnings).toEqual(['Nothing to carve'])
    const w = planProject(project([{ ...rect(10, 10), x: -2, cut: { ...defaultCut(12), type: 'vcarve' } }, { ...rect(10, 10), id: 'z', x: -2, cut: defaultCut(12) }])).warnings
    expect(w).toEqual(['V-carve is not generated yet', 'Rect is partly outside the stock'])
  })
  it('emits GRBL G-code', () => {
    const p = sample()
    const g = toGcode(planProject(p), 'rough', p)
    const lines = g.trim().split('\n')
    expect(lines).toContain('G21 G90 G17')
    expect(lines.findIndex((l) => l.startsWith('G'))).toBe(lines.indexOf('G21 G90 G17'))
    expect(g).toContain('M3 S18000')
    expect(lines.slice(-2)).toEqual(['M5', 'M2'])
    const g1 = lines.filter((l) => l.startsWith('G1'))
    for (const l of g1) {
      const z = l.match(/Z(-?[\d.]+)/)
      if (z) expect(Number(z[1])).toBeGreaterThanOrEqual(-12)
    }
    const s = p.cutSettings.rough
    const withF = g1.filter((l) => l.includes(' F'))
    expect(withF[0]).toMatch(new RegExp(`^G1 Z-?[\\d.]+ F${s.plunge}$`))
    expect(withF[1]).toMatch(new RegExp(`^G1 X.* F${s.feed}$`))
    // F only appears when the feed changes.
    let feed = 0
    for (const l of g1) {
      const f = l.match(/F(\d+)/)
      const want = [s.plunge, s.feed]
      if (f) expect(Number(f[1])).not.toBe(feed)
      else expect(want).toContain(feed)
      feed = f ? Number(f[1]) : feed
    }
  })
})

function project(shapes: Shape[], rough = '1/8-endmill', detail?: string): Project {
  const p = newProject()
  const rec = (id: string) => recommendedSettings(findMaterial(p.materialId), findBit(id), p.machine.maxRpm)
  return { ...p, shapes, bits: { rough, ...(detail && { detail }) }, cutSettings: { rough: rec(rough), ...(detail && { detail: rec(detail) }) } }
}
