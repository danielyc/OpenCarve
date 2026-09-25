/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { parse } from 'opentype.js'
import { expect, test } from 'vitest'
import type { TextShape } from '../model'
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
