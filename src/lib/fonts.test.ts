import { readFileSync } from 'node:fs'
import { parse } from 'opentype.js'
import { expect, test } from 'vitest'
import type { TextShape } from '../model'
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
