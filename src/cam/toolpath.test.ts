import { pointInPolygonD, PointInPolygonResult, type PathD, type PathsD } from 'clipper2-ts'
import { readFileSync } from 'node:fs'
import { parse } from 'opentype.js'
import { describe, expect, it } from 'vitest'
import { glyphPolylines } from '../lib/fonts'
import { shapeToPolylines, tabPositions } from '../lib/geometry'
import { findBit, findMaterial, recommendedSettings } from '../lib/library'
import { defaultCut, gcodeHeaderWarnings, newProject, type CompoundShape, type Point, type Project, type RectShape, type Shape } from '../model'
import { toGcode } from './gcode'
import { orient, outlinePaths, placeTabs, planProject, pocketRings, shapeRegion, withTabs, zLevels, type Op, type Pt3 } from './toolpath'

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

// Distance to the shape's boundary and a non-zero inside test.
function regionProbe(shape: Shape) {
  const region = shapeRegion(shape)
  const edges = region.flatMap((path) => path.map((a, i) => [a, path[(i + 1) % path.length]]))
  const dist = (x: number, y: number) =>
    Math.min(...edges.map(([a, b]) => {
      const dx = b.x - a.x, dy = b.y - a.y
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)))
      return Math.hypot(x - a.x - t * dx, y - a.y - t * dy)
    }))
  const insideRegion = (x: number, y: number) => region.reduce((w, path) => w + (pointInPolygonD({ x, y }, path) === PointInPolygonResult.IsInside ? Math.sign(area(path)) : 0), 0) > 0
  return { dist, insideRegion }
}

// Samples every XY feed move at depth: all of it must stay at least r inside the pocket.
function assertInsideWall(shape: Shape, bit: string) {
  const p = project([{ ...shape, cut: { ...defaultCut(12), type: 'pocket', depth: 3 } }], bit)
  const r = findBit(bit).diameter / 2
  const { dist, insideRegion } = regionProbe(shape)
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
    // A square the bit fits in, with a slot too narrow for it.
    const points: Point[] = [[-10, -10], [10, -10], [10, 10], [1.25, 10], [1.25, 30], [-1.25, 30], [-1.25, 10], [-10, 10]]
    const keyhole: CompoundShape = { id: 'k', type: 'compound', name: 'Rect', x: 50, y: 50, rotation: 0, paths: [{ closed: true, points }], cut: { ...defaultCut(12), type: 'pocket', depth: 3 } }
    expect(planProject(project([keyhole])).warnings).toEqual(["The rough bit can't reach all of Rect; add a smaller detail bit"])
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
  it('uses the overridden bit diameter', () => {
    const width = (p: Project) => {
      const xs = planProject(p).ops.find((o) => o.shapeId === 'a')!.segments.flatMap((g) => g.points.filter((q) => q[2] < 0).map((q) => q[0]))
      return Math.max(...xs) - Math.min(...xs)
    }
    const p = { ...sample(), bitOverrides: { rough: { diameter: 6 } } }
    expect(width(sample())).toBeCloseTo(103.175, 2)
    expect(width(p)).toBeCloseTo(106, 2)
    expect(toGcode(planProject(p), 'rough', p)).toContain('; Bit: 1/8" (3.175 mm) endmill (custom 6 mm)')
  })
  it('per-op times sum to each bit time', () => {
    const p = project([...sample().shapes, { ...rect(50, 50), id: 'd', x: 150, y: 150, cut: { ...defaultCut(12), type: 'pocket', depth: 3 } }], '6mm-endmill', '1mm-endmill')
    const r = planProject(p)
    for (const role of ['rough', 'detail'] as const) {
      const ops = r.ops.filter((o) => o.role === role)
      expect(ops.length).toBeGreaterThan(0)
      expect(ops.every((o) => o.timeSec! > 0)).toBe(true)
      expect(ops.reduce((a, o) => a + o.timeSec!, 0)).toBeCloseTo(r.timeSec[role], 6)
    }
  })
  it('warns when the stock is larger than the machine work area', () => {
    const p = { ...sample(), machine: { name: '3018', w: 300, h: 180, maxRpm: 10000 } }
    expect(planProject(p).warnings).toContain('Stock (300×200 mm) is larger than the machine work area (300×180 mm)')
    expect(planProject(sample()).warnings).toEqual([])
    expect(planProject({ ...p, units: 'in' }).warnings).toContain('Stock (11.811×7.874 in) is larger than the machine work area (11.811×7.087 in)')
  })
  it('warns about nothing to carve, v-carve and out-of-stock shapes', () => {
    expect(planProject(project([])).warnings).toEqual([])
    const w = planProject(project([{ ...rect(10, 10), x: -2, cut: { ...defaultCut(12), type: 'vcarve' } }, { ...rect(10, 10), id: 'z', x: -2, cut: defaultCut(12) }])).warnings
    expect(w).toEqual(['V-carve needs a V-bit', 'Rect is partly outside the stock'])
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

describe('custom G-code blocks', () => {
  const p = (gcode: Partial<Project['gcode']>) => {
    const q = project([{ ...rect(20, 10), id: 'p', x: 30, y: 20, cut: { ...defaultCut(12), type: 'pocket', depth: 3 } }])
    return { ...q, gcode: { ...q.gcode, ...gcode } }
  }
  const lines = (q: Project) => toGcode(planProject(q), 'rough', q).split('\n')
  const code = (q: Project) => lines(q).filter((l) => !l.startsWith(';'))
  it('appends the header after the standard setup and the footer after the final retract', () => {
    const q = p({ header: '\n  M8\nG54  \n', footer: 'M9\r\nG0 X0 Y0' })
    const safe = `G0 Z${q.cutSettings.rough.safeZ}`
    const c = code(q)
    // The standard setup line is repeated after a header, in case it changed a mode.
    expect(c.slice(0, 7)).toEqual(['G21 G90 G17 G94', 'M8', 'G54', 'G21 G90 G17 G94', safe, 'M3 S18000', 'G4 P3'])
    expect(c.slice(-6)).toEqual([safe, 'M9', 'G0 X0 Y0', 'M5', 'M2', ''])
    const plain = code(p({}))
    expect(plain.slice(0, 4)).toEqual(['G21 G90 G17 G94', safe, 'M3 S18000', 'G4 P3'])
    expect(c.slice(7, -5)).toEqual(plain.slice(4, -3)) // the same moves
  })
  it('replace mode emits only the comments, the user blocks and the moves', () => {
    const q = p({ header: 'G21 G90\nM3 S9000', footer: 'M5\nM30', replaceDefaults: true })
    const all = lines(q)
    const c = code(q)
    const safe = `G0 Z${q.cutSettings.rough.safeZ}`
    expect(all[0]).toBe('; OpenCarve')
    expect(all.filter((l) => l.startsWith(';'))).toHaveLength(7)
    expect(c.slice(0, 3)).toEqual(['G21 G90', 'M3 S9000', safe])
    expect(c.slice(-4)).toEqual([safe, 'M5', 'M30', ''])
    for (const l of ['G21 G90 G17 G94', 'M3 S18000', 'G4 P3', 'M2']) expect(c).not.toContain(l)
    const moves = (x: string[]) => x.filter((l) => /^G[01] /.test(l))
    expect(moves(c)).toEqual(moves(code(p({}))))
    expect(code(p({ replaceDefaults: true })).slice(0, 1)).toEqual([safe])
  })
  it('warns when a replacing header misses the spindle start or G21 G90', () => {
    const spindle = "Custom G-code header doesn't start the spindle (M3/M4)"
    const units = "Custom G-code header doesn't set G21 G90"
    const w = (header: string, replaceDefaults = true) => gcodeHeaderWarnings({ header, footer: '', replaceDefaults })
    expect(w('', false)).toEqual([])
    expect(w('')).toEqual([spindle, units])
    expect(w('G21 G90\nM3 S9000')).toEqual([])
    expect(w('g21g90 m04 s9000')).toEqual([])
    expect(w('G21 (G90) ; M3\nM30')).toEqual([spindle, units])
    expect(w('G90 M3')).toEqual([units])
    expect(w('G21 G90.1 M3')).toEqual([units]) // G90.1 is a different word (arc centre mode)
  })
})

describe('work zero', () => {
  const small = (origin: Partial<Project['origin']>) => {
    const p = project([{ ...rect(20, 10), id: 'p', x: 30, y: 20, cut: { ...defaultCut(12), type: 'pocket', depth: 3 } }])
    return { ...p, stock: { w: 100, h: 50, thickness: 12 }, origin: { ...p.origin, ...origin } }
  }
  const words = (g: string, axis: string) => [...g.matchAll(new RegExp(`^G[01] .*${axis}(-?[\\d.]+)`, 'gm'))].map((m) => Number(m[1]))
  const gcode = (p: Project) => toGcode(planProject(p), 'rough', p)
  it('centre zero shifts every move by (-50, -25)', () => {
    const base = gcode(small({}))
    const centre = gcode(small({ preset: 'center', x: 50, y: 25 }))
    for (const axis of ['X', 'Y', 'Z']) {
      expect(words(base, axis).length).toBeGreaterThan(2)
      expect(words(centre, axis)).toHaveLength(words(base, axis).length)
    }
    words(centre, 'X').forEach((x, i) => expect(x).toBeCloseTo(words(base, 'X')[i] - 50, 3))
    words(centre, 'Y').forEach((y, i) => expect(y).toBeCloseTo(words(base, 'Y')[i] - 25, 3))
    expect(words(centre, 'Z')).toEqual(words(base, 'Z'))
    expect(centre).toContain('; XY zero: centre of stock')
    expect(centre).toContain('; Z zero: top of stock')
    expect(base).toContain('; XY zero: bottom-left corner')
    expect(gcode(small({ preset: 'custom', x: 12.5, y: 40 }))).toContain('; XY zero: custom (12.5, 40 mm from bottom-left)')
  })
  it('Z zero at the bottom adds the thickness to every Z, including safe Z', () => {
    const top = gcode(small({}))
    const bottom = gcode(small({ z: 'bottom' }))
    const safe = small({}).cutSettings.rough.safeZ
    expect(top.split('\n')).toContain(`G0 Z${safe}`)
    expect(bottom.split('\n')).toContain(`G0 Z${safe + 12}`)
    expect(bottom.split('\n')).not.toContain(`G0 Z${safe}`)
    const zt = words(top, 'Z')
    expect(zt.length).toBeGreaterThan(2)
    for (const axis of ['X', 'Y', 'Z']) expect(words(bottom, axis)).toHaveLength(words(top, axis).length)
    words(bottom, 'Z').forEach((z, i) => expect(z).toBeCloseTo(zt[i] + 12, 3))
    expect(words(bottom, 'X')).toEqual(words(top, 'X'))
    expect(bottom).toContain('; Z zero: bottom of stock (spoilboard)')
  })
})

describe('ordering and tab limits', () => {
  const pocket = { ...rect(50, 50), id: 'p', x: 200, y: 100, cut: { ...defaultCut(12), type: 'pocket' as const, depth: 3 } }
  const outline = (extra: Partial<Shape['cut'] & object> = {}) => ({ ...rect(20, 20), id: 'o', cut: { ...defaultCut(12), ...extra } })
  it('warns when a tabless part is freed before the detail pass', () => {
    const warn = 'Parts are cut free before the detail pass; keep tabs on'
    expect(planProject(project([outline({ tabs: false }), pocket], '6mm-endmill', '1mm-endmill')).warnings).toContain(warn)
    expect(planProject(project([outline({ tabs: false, side: 'on' }), pocket], '6mm-endmill', '1mm-endmill')).warnings).toContain(warn)
    expect(planProject(project([outline(), pocket], '6mm-endmill', '1mm-endmill')).warnings).not.toContain(warn)
    expect(planProject(project([outline({ tabs: false }), pocket], '6mm-endmill')).warnings).not.toContain(warn)
  })
  it('holds back through outlines on the line too, but not shallow ones', () => {
    expect(planProject(project([outline({ side: 'on' }), pocket])).ops.map((o) => o.shapeId)).toEqual(['p', 'o'])
    expect(planProject(project([outline({ depth: 2 }), pocket])).ops.map((o) => o.shapeId)).toEqual(['o', 'p'])
  })
  it('no "bit too large" when the detail bit pockets the shape', () => {
    const small = { ...rect(5, 5), cut: { ...defaultCut(12), type: 'pocket' as const, depth: 3 } }
    expect(planProject(project([small], '6mm-endmill')).warnings).toEqual(['Bit too large for Rect']) // not also "can't reach"
    const r = planProject(project([small], '6mm-endmill', '1mm-endmill'))
    expect(r.warnings).not.toContain('Bit too large for Rect')
    expect(r.ops.map((o) => o.kind)).toEqual(['pocket-detail'])
  })
  const tabSections = (op: Op, tabZ: number) => {
    const final = op.segments.filter((s) => !s.rapid).flatMap((s) => s.points)
    return final.filter((q, i) => q[2] === tabZ && final[i - 1]?.[2] !== tabZ)
  }
  it('outside cuts put no tabs on holes', () => {
    const ring: CompoundShape = { id: 'c', type: 'compound', name: 'C', x: 100, y: 100, rotation: 0, paths: [{ closed: true, points: [[-20, -20], [20, -20], [20, 20], [-20, 20]] }, { closed: true, points: [[-10, 10], [10, 10], [10, -10], [-10, -10]] }], cut: { ...defaultCut(12), tabCount: 8 } }
    const starts = tabSections(planProject(project([ring])).ops[0], -9)
    expect(starts.length).toBeGreaterThan(0)
    for (const [x, y] of starts) expect(Math.max(Math.abs(x - 100), Math.abs(y - 100))).toBeGreaterThan(15)
  })
  it('caps tabs at half of each loop', () => {
    // Loop about 40 + π·3.175 ≈ 50 mm: at most 4 tabs of 6 mm.
    const op = planProject(project([{ ...rect(10, 10), cut: { ...defaultCut(12), tabCount: 10 } }])).ops[0]
    const final = op.segments.filter((s) => s.points.length > 2).at(-1)!.points
    expect(final.filter((q, i) => q[2] === -9 && final[i - 1]?.[2] !== -9)).toHaveLength(4)
  })
})

describe('v-carve', () => {
  const vcarve = (w: number, h: number, depth: number) => ({ ...rect(w, h), x: 100, y: 100, cut: { ...defaultCut(12), type: 'vcarve' as const, depth } })
  const cutPoints = (op: Op) => op.segments.filter((s) => !s.rapid).flatMap((s) => s.points)
  it('60×20 rect, 90° V-bit, max depth 4, endmill clears the floor', () => {
    const shape = vcarve(60, 20, 4)
    const r = planProject(project([shape], '1/8-endmill', '90-vbit'))
    expect(r.ops.map((o) => [o.role, o.kind])).toEqual([
      ['rough', 'vcarve-clear'],
      ['detail', 'vcarve-clear'],
      ['detail', 'vcarve'],
    ])
    // The V-bit finishes only the floor corners the endmill can't reach, at the floor depth, inside the floor.
    const floorCorners = [[74, 94], [126, 94], [74, 106], [126, 106]]
    for (const [x, y, z] of cutPoints(r.ops[1])) {
      expect(Math.min(...floorCorners.map(([cx, cy]) => Math.max(Math.abs(x - cx), Math.abs(y - cy))))).toBeLessThan(3)
      expect(x > 74 - 1e-6 && x < 126 + 1e-6 && y > 94 - 1e-6 && y < 106 + 1e-6).toBe(true)
      expect(z).toBeGreaterThanOrEqual(-4 - 1e-9)
    }
    expect(r.warnings).toEqual([])
    const clear = cutPoints(r.ops[0])
    const b = bounds([clear.map(([x, y]) => ({ x, y }))])
    expect(b.w).toBeCloseTo(52 - 3.175, 1)
    expect(b.h).toBeCloseTo(12 - 3.175, 1)
    expect(Math.min(...clear.map((q) => q[2]))).toBeCloseTo(-4)
    const { dist, insideRegion } = regionProbe(shape)
    const pts = cutPoints(r.ops[2])
    for (const [x, y, z] of pts) {
      expect(z).toBeGreaterThanOrEqual(-4 - 1e-9)
      expect(Math.abs(z + Math.min(dist(x, y), 4))).toBeLessThan(0.06)
      expect(insideRegion(x, y) || dist(x, y) < 1e-6).toBe(true)
    }
    // The floor contour: a closed 52×12 loop at -4.
    const floor = r.ops[2].segments.find((s) => s.points.length > 3 && s.points.every((q) => q[2] === -4))!
    expect(bounds([floor.points.map(([x, y]) => ({ x, y }))])).toEqual({ w: expect.closeTo(52, 2), h: expect.closeTo(12, 2) })
  })
  it('never cuts through: max depth is clamped to thickness - 0.5', () => {
    const r = planProject({ ...project([vcarve(60, 40, 12)], '1/8-endmill', '90-vbit'), bitOverrides: { detail: { diameter: 30 } } })
    expect(r.warnings).toEqual([])
    const zs = r.ops.flatMap(cutPoints).map((q) => q[2])
    expect(Math.min(...zs)).toBeCloseTo(-11.5)
  })
  it('without an endmill the V-bit clears the floor, and warns', () => {
    const r = planProject(project([vcarve(60, 20, 4)], '60-vbit'))
    expect(r.ops.map((o) => [o.role, o.kind])).toEqual([
      ['rough', 'vcarve-clear'],
      ['rough', 'vcarve'],
    ])
    expect(r.warnings).toEqual(['Add a flat endmill for a smoother V-carve floor'])
  })
  it('an endmill too large for the floor leaves it to the V-bit', () => {
    const r = planProject(project([vcarve(60, 14, 4)], '1/4-endmill', '90-vbit'))
    expect(r.ops.map((o) => [o.role, o.kind])).toEqual([
      ['detail', 'vcarve-clear'],
      ['detail', 'vcarve'],
    ])
    expect(r.warnings).toEqual(['The endmill is too large for the floor of Rect; the V-bit clears it'])
  })
  it.each([3, 12])('5-point star, max depth %i: never deeper than the clearance allows', (depth) => {
    const points: Point[] = Array.from({ length: 10 }, (_, i) => {
      const a = Math.PI / 2 + (i * Math.PI) / 5
      return [(i % 2 ? 8 : 20) * Math.cos(a), (i % 2 ? 8 : 20) * Math.sin(a)]
    })
    const shape: Shape = { id: 's', type: 'path', name: 'Star', x: 100, y: 100, rotation: 0, closed: true, points, cut: { ...defaultCut(12), type: 'vcarve', depth } }
    const k = Math.tan(Math.PI / 6)
    const { dist } = regionProbe(shape)
    const op = planProject(project([shape], '1/8-endmill', '60-vbit')).ops.find((o) => o.kind === 'vcarve')!
    let prev: Pt3 | null = null
    for (const seg of op.segments) {
      for (const q of seg.points) {
        if (prev && !seg.rapid) {
          for (let i = 0; i <= 10; i++) {
            const [x, y, z] = [0, 1, 2].map((j) => prev![j] + ((q[j] - prev![j]) * i) / 10)
            expect(z).toBeGreaterThanOrEqual(-dist(x, y) / k - 0.03)
          }
        }
        prev = q
      }
    }
  })
  it('a flat-tipped V-bit never gouges the walls', () => {
    const shape = vcarve(60, 20, 4)
    const p = { ...project([shape], '90-vbit'), bitOverrides: { rough: { flat: 1 } } }
    const f = 0.5
    const { dist } = regionProbe(shape)
    const r = planProject(p)
    expect(r.warnings).toEqual(['Add a flat endmill for a smoother V-carve floor'])
    let checked = 0
    for (const op of r.ops) {
      let prev: Pt3 | null = null
      for (const seg of op.segments) {
        for (const q of seg.points) {
          if (prev && !seg.rapid) {
            for (let i = 0; i <= 10; i++) {
              const [x, y, z] = [0, 1, 2].map((j) => prev![j] + ((q[j] - prev![j]) * i) / 10)
              if (z < 0) expect(-z).toBeLessThanOrEqual(dist(x, y) - f + 0.03) // k = 1
              checked++
            }
          }
          prev = q
        }
      }
    }
    expect(checked).toBeGreaterThan(100)
    // The floor contour: the tool centre is f further in than for a sharp tip.
    const floor = r.ops[1].segments.find((s) => s.points.length > 3 && s.points.every((q) => q[2] === -4))!
    expect(bounds([floor.points.map(([x, y]) => ({ x, y }))])).toEqual({ w: expect.closeTo(51, 2), h: expect.closeTo(11, 2) })
  })
  it('warns about details narrower than the flat tip, not about corners', () => {
    const thin = { ...vcarve(30, 1.5, 2), id: 't', name: 'Thin' }
    const p = { ...project([thin], '1/8-endmill', '90-vbit'), bitOverrides: { detail: { flat: 2 } } }
    expect(planProject(p).warnings).toContain("Some details of Thin are narrower than the V-bit's flat tip")
    const wide = { ...p, shapes: [vcarve(60, 20, 2)] }
    expect(planProject(wide).warnings).toEqual([])
  })
  it("limits the depth to the V-bit's cone", () => {
    const p = { ...project([vcarve(60, 20, 2)], '1/8-endmill', '90-vbit'), bitOverrides: { detail: { diameter: 1 } } }
    const r = planProject(p)
    expect(r.warnings).toContain("Rect: max depth limited to 0.5 mm by the V-bit's diameter")
    expect(Math.min(...r.ops.filter((o) => o.role === 'detail').flatMap(cutPoints).map((q) => q[2]))).toBeCloseTo(-0.5)
  })
  it('without a V-bit: warning and no ops', () => {
    const r = planProject(project([vcarve(60, 20, 4)], '1/8-endmill', '1mm-endmill'))
    expect(r.warnings).toEqual(['V-carve needs a V-bit'])
    expect(r.ops).toEqual([])
  })
  it('emits simultaneous XYZ moves', () => {
    const p = project([vcarve(60, 20, 4)], '1/8-endmill', '90-vbit')
    const g = toGcode(planProject(p), 'detail', p)
    expect(g).toMatch(/^G1 X-?[\d.]+ Y-?[\d.]+ Z-?[\d.]+/m)
  })
})

function project(shapes: Shape[], rough = '1/8-endmill', detail?: string): Project {
  const p = newProject()
  const rec = (id: string) => recommendedSettings(findMaterial(p.materialId), findBit(id), p.machine.maxRpm)
  return { ...p, shapes, bits: { rough, ...(detail && { detail }) }, cutSettings: { rough: rec(rough), ...(detail && { detail: rec(detail) }) } }
}
