import { expect, test } from 'vitest'
import type { Point, Shape } from '../model'
import { scaleShape, shapeBounds, shapeToPolylines, tabPositions } from './geometry'

const base = { id: 'a', name: 'a', x: 50, y: 20, rotation: 0 }

const close = (b: ReturnType<typeof shapeBounds>, e: typeof b, digits = 2) =>
  (Object.keys(e) as (keyof typeof e)[]).forEach((k) => expect(b[k]).toBeCloseTo(e[k], digits))

test('rect bounds', () => {
  close(shapeBounds({ ...base, type: 'rect', w: 40, h: 10 }), { minX: 30, minY: 15, maxX: 70, maxY: 25 })
})

test('rotated rect bounds', () => {
  close(shapeBounds({ ...base, type: 'rect', w: 40, h: 10, rotation: 90 }), { minX: 45, minY: 0, maxX: 55, maxY: 40 })
  const b = shapeBounds({ ...base, type: 'rect', w: 10, h: 10, rotation: 45 })
  expect(b.maxX - b.minX).toBeCloseTo(10 * Math.SQRT2)
})

test('rotation is counter-clockwise', () => {
  const [pl] = shapeToPolylines({ ...base, x: 0, y: 0, type: 'path', points: [[10, 0]], closed: false, rotation: 90 })
  expect(pl.points[0][0]).toBeCloseTo(0)
  expect(pl.points[0][1]).toBeCloseTo(10)
})

test('polygon is inscribed in w × h', () => {
  const shape: Shape = { ...base, type: 'polygon', sides: 5, w: 30, h: 20 }
  close(shapeBounds(shape), { minX: 35, minY: 10, maxX: 65, maxY: 30 })
  expect(shapeToPolylines(shape)[0].points).toHaveLength(5)
})

test('ellipse bounds and segments', () => {
  const shape: Shape = { ...base, type: 'ellipse', w: 20, h: 10 }
  close(shapeBounds(shape), { minX: 40, minY: 15, maxX: 60, maxY: 25 }, 1)
  expect(shapeToPolylines(shape)[0].points).toHaveLength(50)
})

test('path bounds and scaling', () => {
  const shape: Shape = { ...base, type: 'path', points: [[-5, 0], [5, 10], [0, -10]], closed: true }
  close(shapeBounds(shape), { minX: 45, minY: 10, maxX: 55, maxY: 30 })
  close(shapeBounds(scaleShape(shape, 2, 0.5)), { minX: 40, minY: 15, maxX: 60, maxY: 25 })
})

test('tab positions are evenly spaced along the outline', () => {
  const polys = shapeToPolylines({ ...base, x: 0, y: 0, type: 'rect', w: 100, h: 50 })
  const tabs = tabPositions(polys, 4)
  expect(tabs).toHaveLength(4)
  // Arc length from the rect's first corner (-50, -25), going counter-clockwise.
  const on = (a: number, b: number) => Math.abs(a - b) < 1e-9
  const arc = ([x, y]: Point) =>
    on(y, -25) ? x + 50 : on(x, 50) ? 125 + y : on(y, 25) ? 200 - x : on(x, -50) ? 275 - y : NaN
  tabs.forEach(({ point, tangent }, i) => {
    expect(arc(point)).toBeCloseTo(37.5 + 75 * i)
    expect(Math.hypot(...tangent)).toBeCloseTo(1)
  })
  expect(tabPositions([{ closed: false, points: [[0, 0], [10, 0]] }], 2).map((t) => t.point[0])).toEqual([2.5, 7.5])
})
