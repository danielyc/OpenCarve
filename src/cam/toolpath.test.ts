import { pointInPolygonD, PointInPolygonResult, type PathD, type PathsD } from 'clipper2-ts'
import { readFileSync } from 'node:fs'
import { parse } from 'opentype.js'
import { describe, expect, it } from 'vitest'
import { glyphPolylines } from '../lib/fonts'
import { shapeToPolylines, tabPositions } from '../lib/geometry'
import { findBit, findMaterial, recommendedSettings } from '../lib/library'
import { defaultCut, newProject, type CompoundShape, type Point, type Project, type RectShape, type Shape } from '../model'
import { toGcode } from './gcode'
import { orient, outlinePaths, placeTabs, planProject, pocketRings, shapeRegion, withTabs, zLevels, type Pt3 } from './toolpath'

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
  it.each([
    ['100×60 rect', rect(100, 60)],
    ['rotated ellipse', { ...rect(80, 40), type: 'ellipse', rotation: 30 } as Shape],
  ])('tabs sit where the canvas draws them: %s', (_, shape) => {
    const p = project([{ ...shape, cut: { ...defaultCut(12), tabCount: 5 } }])
    const final12 = planProject(p).ops[0].segments.filter((s) => s.points.length > 2).at(-1)!.points
    const mids: Point[] = []
    final12.forEach((q, i) => {
      if (q[2] !== -9 || final12[i - 1]?.[2] === -9) return
      const end = final12.findIndex((r, j) => j > i && r[2] !== -9) - 1
      mids.push([(q[0] + final12[end][0]) / 2, (q[1] + final12[end][1]) / 2])
    })
    const expected = tabPositions(shapeToPolylines(shape), 5).map((t) => t.point)
    expect(mids).toHaveLength(5)
    for (const e of expected) expect(Math.min(...mids.map((m) => Math.hypot(m[0] - e[0], m[1] - e[1])))).toBeLessThan(3)
  })
  it('the plunge point is never on a tab', () => {
    const { pts, centres } = placeTabs(
      [[0, 0], [40, 0], [40, 20], [0, 20], [0, 0]],
      [[1, 0], [39, 20]],
    )
    const path = withTabs(pts, -12, -9, centres, 4)
    expect(path[0][2]).toBe(-12)
    expect(path.at(-1)![2]).toBe(-12)
    expect(path.filter((q) => q[2] === -9).length).toBeGreaterThanOrEqual(4)
  })
})

// Samples every XY feed move at depth: all of it must stay at least r inside the pocket.
function assertInsideWall(shape: Shape, bit: string) {
  const p = project([{ ...shape, cut: { ...defaultCut(12), type: 'pocket', depth: 3 } }], bit)
  const r = findBit(bit).diameter / 2
  const edges = shapeRegion(shape).flatMap((path) => path.map((a, i) => [a, path[(i + 1) % path.length]]))
  const region = shapeRegion(shape)
  const dist = (x: number, y: number) =>
    Math.min(...edges.map(([a, b]) => {
      const dx = b.x - a.x, dy = b.y - a.y
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)))
      return Math.hypot(x - a.x - t * dx, y - a.y - t * dy)
    }))
  const insideRegion = (x: number, y: number) => region.reduce((w, path) => w + (pointInPolygonD({ x, y }, path) === PointInPolygonResult.IsInside ? Math.sign(area(path)) : 0), 0) > 0
  let prev: Pt3 | null = null
  let checked = 0
  for (const seg of planProject(p).ops[0].segments) {
    for (const q of seg.points) {
      if (prev && !seg.rapid && q[2] < 0 && (q[0] !== prev[0] || q[1] !== prev[1])) {
        for (let k = 0; k <= 10; k++) {
          const x = prev[0] + ((q[0] - prev[0]) * k) / 10
          const y = prev[1] + ((q[1] - prev[1]) * k) / 10
          expect(insideRegion(x, y)).toBe(true)
          expect(dist(x, y)).toBeGreaterThan(r - 0.02) // arc tolerance
          checked++
        }
      }
      prev = q
    }
  }
  expect(checked).toBeGreaterThan(100)
}

describe('pocket linking', () => {
  it('never feeds across a narrow bridge between offset loops', () => {
    // Two 20 mm squares joined by a 2 mm bridge: the 1/8" bit's loops split and must be linked by a retract.
    const pts: Point[] = [[0, 0], [20, 0], [20, 9], [30, 9], [30, 0], [50, 0], [50, 20], [30, 20], [30, 11], [20, 11], [20, 20], [0, 20]]
    for (const rotation of [0, 37, 90, 180]) {
      assertInsideWall({ id: 'd', type: 'path', name: 'D', x: 100, y: 100, rotation, closed: true, points: pts.map(([x, y]) => [x - 25, y - 10]) }, '1/8-endmill')
    }
  })
  it('never feeds across a hole', () => {
    const sq = (s: number, cx = 0): Point[] => [[cx - s, -s], [cx + s, -s], [cx + s, s], [cx - s, s]]
    const shape: CompoundShape = { id: 'c', type: 'compound', name: 'C', x: 100, y: 100, rotation: 15, paths: [{ closed: true, points: sq(20) }, { closed: true, points: sq(4, -8).reverse() }, { closed: true, points: sq(3, 9).reverse() }] }
    assertInsideWall(shape, '1/8-endmill')
    assertInsideWall(shape, '1/4-endmill')
  })
  it('never gouges "B8e" in Roboto', () => {
    const buf = readFileSync(new URL('../../public/fonts/Roboto-Regular.ttf', import.meta.url))
    const font = parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    const paths = glyphPolylines(font, 'B8e', 40)
    assertInsideWall({ id: 't', type: 'compound', name: 'T', x: 100, y: 100, rotation: 0, paths }, '1/8-endmill')
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
  it('warns when the rough bit leaves more than corners and there is no usable detail bit', () => {
    const slot = { ...rect(40, 2.5), cut: { ...defaultCut(12), type: 'pocket' as const, depth: 3 } }
    expect(planProject(project([slot])).warnings).toContain("The rough bit can't reach all of Rect; add a smaller detail bit")
    expect(planProject(project([pocket])).warnings).toEqual([])
    expect(planProject(project([pocket], '1mm-endmill', '6mm-endmill')).warnings).toContain('The detail bit must be smaller than the rough bit')
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
  it('through cut with tabs plus pocket; outside outlines go last', () => {
    const r = planProject(sample())
    expect(r.warnings).toEqual([])
    expect(r.ops.map((o) => [o.role, o.kind, o.shapeId])).toEqual([
      ['rough', 'pocket', 'b'],
      ['rough', 'outline', 'a'],
    ])
    const inside = { ...rect(20, 20), id: 'c', x: 150, y: 150, cut: { ...defaultCut(12), side: 'inside' as const } }
    const p = sample()
    p.shapes = [p.shapes[0], inside, p.shapes[1]]
    expect(planProject(p).ops.map((o) => o.shapeId)).toEqual(['c', 'b', 'a'])
    expect(r.timeSec.rough).toBeGreaterThan(0)
  })
  it('warns about nothing to carve, v-carve and out-of-stock shapes', () => {
    expect(planProject(project([])).warnings).toEqual(['Nothing to carve'])
    const w = planProject(project([{ ...rect(10, 10), x: -2, cut: { ...defaultCut(12), type: 'vcarve' } }, { ...rect(10, 10), id: 'z', x: -2, cut: defaultCut(12) }])).warnings
    expect(w).toEqual(['V-carve is not generated yet', 'Rect is partly outside the stock'])
  })
  it('keeps comments ASCII', () => {
    const p = { ...sample(), name: 'Café\n(test)' }
    expect(toGcode(planProject(p), 'rough', p).split('\n').slice(0, 5).join('\n')).toMatch(/^[ -~\n]*$/)
  })
  it('emits GRBL G-code', () => {
    const p = sample()
    const g = toGcode(planProject(p), 'rough', p)
    const lines = g.trim().split('\n')
    expect(lines).toContain('G21 G90 G17 G94')
    expect(lines.findIndex((l) => !l.startsWith(';'))).toBe(lines.indexOf('G21 G90 G17 G94'))
    expect(g).toContain('M3 S18000\nG4 P3')
    expect(lines.slice(-2)).toEqual(['M5', 'M2'])
    const g1 = lines.filter((l) => l.startsWith('G1'))
    for (const l of g1) {
      const z = l.match(/Z(-?[\d.]+)/)
      if (z) expect(Number(z[1])).toBeGreaterThanOrEqual(-12)
    }
    const s = p.cutSettings.rough
    const withF = g1.filter((l) => l.includes(' F'))
    expect(withF[0]).toMatch(new RegExp(`^G1 Z-?[\\d.]+ F${s.plunge}$`))
    expect(withF[1]).toMatch(new RegExp(`^G1 [XY].* F${s.feed}$`))
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
