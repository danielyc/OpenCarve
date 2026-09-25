import { expect, test } from 'vitest'
import { formatLength, inToMm, mmToIn, nearestSnap, parseLength, SNAP_SIZES, snapDelta, snapPoint } from './units'

test('converts and formats lengths', () => {
  expect(inToMm(1)).toBe(25.4)
  expect(mmToIn(50.8)).toBe(2)
  expect(formatLength(12.346, 'mm')).toBe('12.35')
  expect(formatLength(25.4, 'in')).toBe('1.000')
})

test('parses lengths', () => {
  expect(parseLength('12.5', 'mm')).toBe(12.5)
  expect(parseLength('2', 'in')).toBe(50.8)
  expect(parseLength('abc', 'mm')).toBeNull()
  expect(parseLength(' ', 'mm')).toBeNull()
  expect(parseLength('12abc', 'mm')).toBeNull()
})

test('snaps points to the grid', () => {
  expect(snapPoint([12.4, 17.6], 5)).toEqual([10, 20])
  expect(snapPoint([-12.4, -17.6], 5)).toEqual([-10, -20])
  expect(snapPoint([0.74, 0.76], 0.5)).toEqual([0.5, 1])
  expect(snapPoint([2.5, -2.5], 5)).toEqual([5, 0]) // exact halves round up, never to -0
  expect(Object.is(snapPoint([-0.2, 0], 1)[0], 0)).toBe(true)
  expect(snapPoint([1.23, 4.56], 0)).toEqual([1.23, 4.56])
})

test('snaps a move so the corner lands on the grid', () => {
  expect(snapDelta([3, 7], [11, -1], 10)).toEqual([7, 3])
  expect(snapDelta([-3.25, 0.25], [0, 0], 0.5)).toEqual([0.25, 0.25]) // halves round up: -3.25 → -3, 0.25 → 0.5
})

test('picks the nearest snap size for the units', () => {
  expect(nearestSnap(1, 'in')).toBe(inToMm(1 / 16))
  expect(nearestSnap(10, 'in')).toBe(inToMm(1 / 2))
  expect(nearestSnap(inToMm(1 / 16), 'mm')).toBe(2)
  expect(nearestSnap(5, 'mm')).toBe(5)
  expect(SNAP_SIZES.in.map((s) => s.label)).toEqual(['1/16"', '1/8"', '1/4"', '1/2"', '1"'])
})
