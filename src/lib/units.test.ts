import { expect, test } from 'vitest'
import { formatLength, inToMm, mmToIn, parseLength } from './units'

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
