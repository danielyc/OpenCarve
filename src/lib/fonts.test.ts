import { readFileSync } from 'node:fs'
import { parse } from 'opentype.js'
import { expect, test } from 'vitest'
import type { Point, Polyline, TextShape } from '../model'
import { cubicSegments, flattenCubic, flattenQuad } from './bezier'
import { glyphPolylines } from './fonts'
import { polylineBounds, scaleShape } from './geometry'

const buf = readFileSync(new URL('../../public/fonts/Roboto-Regular.ttf', import.meta.url))
const font = parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))

test('glyph outlines become closed polylines, one per contour', () => {
  const i = glyphPolylines(font, 'I', 20)
  const o = glyphPolylines(font, 'O', 20)
  expect(i).toHaveLength(1)
  expect(o).toHaveLength(2)
  expect([...i, ...o].every((p) => p.closed)).toBe(true)
  const b = polylineBounds(o)
  expect(b.maxX - b.minX).toBeGreaterThan(0)
  expect(b.maxY).toBeGreaterThan(10)
  expect(b.minY).toBeGreaterThan(-1)
})

test('text scales uniformly by the dominant factor', () => {
  const t: TextShape = { id: 't', name: 't', type: 'text', x: 0, y: 0, rotation: 0, text: 'A', font: 'roboto', size: 20, w: 10, h: 14 }
  expect(scaleShape(t, 0.5, 1)).toMatchObject({ size: 10, w: 5, h: 7 })
  expect(scaleShape(t, 1.5, 2)).toMatchObject({ size: 40, w: 20, h: 28 })
})

test('curve flattening stays within 0.02 mm and scales with curvature', () => {
  expect(cubicSegments([0, 0], [1, 0], [2, 0], [3, 0])).toBe(1)
  const ctrl: [number, number][] = [[50, 0], [50, 28], [28, 50], [0, 50]]
  const arc = flattenCubic(...(ctrl as [typeof ctrl[0], typeof ctrl[0], typeof ctrl[0], typeof ctrl[0]]))
  const fine = flattenCubic(ctrl[0], ctrl[1], ctrl[2], ctrl[3], arc.length * 2)
  const pts = [ctrl[0], ...arc]
  for (let i = 1; i < pts.length; i++) {
    const [a, b, m] = [pts[i - 1], pts[i], fine[2 * i - 2]]
    expect(Math.hypot((a[0] + b[0]) / 2 - m[0], (a[1] + b[1]) / 2 - m[1])).toBeLessThan(0.02)
  }
  expect(flattenQuad([0, 0], [50, 100], [100, 0]).length).toBeGreaterThan(flattenQuad([0, 0], [0.5, 1], [1, 0]).length)
})

const width = (polys: Polyline[]) => {
  const b = polylineBounds(polys)
  return b.maxX - b.minX
}
const area = ({ points }: Polyline) => points.reduce((a, [x, y], i) => a + x * points[(i + 1) % points.length][1] - points[(i + 1) % points.length][0] * y, 0) / 2
const center = (p: Polyline): Point => {
  const b = polylineBounds([p])
  return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]
}

test('letter spacing widens the text by (n − 1) × spacing', () => {
  const plain = width(glyphPolylines(font, 'HELLO', 20))
  expect(width(glyphPolylines(font, 'HELLO', 20, { letterSpacing: 3 }))).toBeCloseTo(plain + 4 * 3, 6)
  expect(width(glyphPolylines(font, 'HELLO', 20, { letterSpacing: -2 }))).toBeCloseTo(plain - 4 * 2, 6)
})

test('lines stack by lineHeight × size and align within the block', () => {
  const one = polylineBounds(glyphPolylines(font, 'H', 20))
  const two = polylineBounds(glyphPolylines(font, 'H\nH', 20, { lineHeight: 1.5 }))
  expect(two.maxY).toBeCloseTo(one.maxY, 6)
  expect(two.minY).toBeCloseTo(one.minY - 1.5 * 20, 6)
  for (const [align, edge] of [['right', 'maxX'], ['left', 'minX']] as const) {
    const polys = glyphPolylines(font, 'HHHH\nHH', 20, { align })
    const top = polylineBounds(polys.filter((p) => p.points[0][1] > -5))
    const bottom = polylineBounds(polys.filter((p) => p.points[0][1] < -5))
    expect(bottom[edge]).toBeCloseTo(top[edge], 6)
  }
  const centred = glyphPolylines(font, 'HHHH\nHH', 20)
  const [top, bottom] = [centred.filter((p) => p.points[0][1] > -5), centred.filter((p) => p.points[0][1] < -5)].map(polylineBounds)
  expect((bottom.minX + bottom.maxX) / 2).toBeCloseTo((top.minX + top.maxX) / 2, 6)
})

test('a bend puts glyphs on an arc whose length is the line length', () => {
  const text = 'I'.repeat(30)
  const [a, b2] = glyphPolylines(font, 'II', 10, { align: 'left' })
  const capHeight = polylineBounds([a]).maxY
  const advance = b2.points[0][0] - a.points[0][0]
  const r = (30 * advance) / Math.PI
  const bent = glyphPolylines(font, text, 10, { arc: 180 })
  expect(bent).toHaveLength(30)
  const b = polylineBounds(bent)
  expect(b.maxX - b.minX).toBeGreaterThan(2 * r)
  expect(b.maxX - b.minX).toBeLessThan(2 * (r + capHeight))
  expect(b.maxY - b.minY).toBeGreaterThan(r)
  expect(b.maxY - b.minY).toBeLessThan(r + capHeight + 1)
  // An I is a rectangle, so its bounds centre is its middle: capHeight / 2 out from the arc, centre (0, −r).
  for (const p of bent) expect(Math.abs(Math.hypot(center(p)[0], center(p)[1] + r) - (r + capHeight / 2))).toBeLessThan(0.5)
})

test('the bend sign decides which way the arc curves; glyphs stay upright', () => {
  const up = glyphPolylines(font, 'IIIII', 10, { arc: 90 }).map(center)
  const down = glyphPolylines(font, 'IIIII', 10, { arc: -90 }).map(center)
  expect(up[0][1]).toBeLessThan(up[2][1])
  expect(down[0][1]).toBeGreaterThan(down[2][1])
  expect(up[0][0]).toBeCloseTo(-up[4][0], 1)
  // Reading left to right the first glyph leans left over an upward arc and right under a downward one.
  const lean = (polys: Polyline[]) => {
    const pts = polys[0].points
    const topPt = pts.reduce((a, p) => (p[1] > a[1] ? p : a))
    return topPt[0] - center(polys[0])[0]
  }
  expect(lean(glyphPolylines(font, 'IIIII', 10, { arc: 90 }))).toBeLessThan(0)
  expect(lean(glyphPolylines(font, 'IIIII', 10, { arc: -90 }))).toBeGreaterThan(0)
})

test('mirror flips x about the block centre and keeps each contour winding', () => {
  const plain = glyphPolylines(font, 'Rob', 20)
  const mirrored = glyphPolylines(font, 'Rob', 20, { mirror: true })
  const [a, b] = [polylineBounds(plain), polylineBounds(mirrored)]
  expect(b).toEqual({ ...a })
  const mid = a.minX + a.maxX
  mirrored.forEach((p, i) => {
    expect(Math.sign(area(p))).toBe(Math.sign(area(plain[i])))
    const [x, y] = plain[i].points[0]
    expect(p.points.some(([px, py]) => Math.abs(px - (mid - x)) < 1e-9 && py === y)).toBe(true)
  })
})
