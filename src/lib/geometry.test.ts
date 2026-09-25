import { expect, test } from 'vitest'
import type { Shape } from '../model'
import { gridPath, gridSteps, scaleShape, shapeBounds, shapeToPolylines } from './geometry'

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

test('grid lines stay inside the stock and near the visible area', () => {
  const all = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity }
  expect(gridPath(30, 20, 10, all)).toBe('M10 0V20M20 0V20M0 10H30')
  expect(gridPath(100, 100, 10, { minX: 42, minY: 200, maxX: 58, maxY: 300 })).toBe('')
  // Visible 42..58 × 0..15, plus one step: x 32..68 → 40, 50, 60; y 0..25 → 10, 20.
  expect(gridPath(100, 100, 10, { minX: 42, minY: 0, maxX: 58, maxY: 15 })).toBe('M40 0V25M50 0V25M60 0V25M32 10H68M32 20H68')
})

test('a fine grid on a large stock is bounded by the viewport', () => {
  const [pxW, pxH, pxPerMm] = [1600, 1000, 12]
  const area = { minX: 400, minY: 400, maxX: 400 + pxW / pxPerMm, maxY: 400 + pxH / pxPerMm }
  const lines = gridPath(1000, 1000, 0.5, area).split('M').length - 1
  expect(lines).toBeLessThanOrEqual(2 * (Math.max(pxW, pxH) / 6))
})

test('grid steps adapt to the zoom', () => {
  const steps = (zoom: number, units: 'mm' | 'in' = 'mm', snap = 0) => {
    const { minor, major, label } = gridSteps(zoom, units, snap)
    return [+(minor / (units === 'in' ? 25.4 : 1)).toFixed(4), +(major / (units === 'in' ? 25.4 : 1)).toFixed(4), label]
  }
  expect(steps(0.1)).toEqual([200, 2000, '200 mm']) // nothing in the series is 5× 200 mm: 10×
  expect(steps(1)).toEqual([20, 100, '20 mm'])
  expect(steps(10)).toEqual([2, 10, '2 mm'])
  expect(steps(40)).toEqual([0.5, 5, '0.5 mm'])
  expect(steps(1, 'in')).toEqual([0.5, 5, '1/2″']) // 1/2" is 12.7 px
  expect(steps(5, 'in')).toEqual([0.125, 1, '1/8″'])
  expect(steps(40, 'in')).toEqual([0.0625, 0.5, '1/16″'])
  expect(steps(40, 'mm', 2)).toEqual([2, 10, '2 mm'])
  expect(steps(1, 'mm', 2)).toEqual([20, 100, '20 mm']) // snap lines under 6 px apart: the adaptive grid
  expect(steps(10, 'mm', 3)).toEqual([3, 30, '3 mm']) // no series value is a multiple of 3 mm: 10×
  expect(steps(40, 'in', 25.4 / 16)).toEqual([0.0625, 0.5, '1/16″'])
})
