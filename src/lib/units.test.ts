import { expect, test } from 'vitest'
import { formatLength, inToMm, mmToIn } from './units'

test('converts and formats lengths', () => {
  expect(inToMm(1)).toBe(25.4)
  expect(mmToIn(50.8)).toBe(2)
  expect(formatLength(12.346, 'mm')).toBe('12.35')
  expect(formatLength(25.4, 'in')).toBe('1.000')
})
