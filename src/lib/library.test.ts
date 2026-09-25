import { expect, test } from 'vitest'
import { BITS, findBit, findMaterial, MATERIALS, recommendedSettings } from './library'

test('recommended settings scale stepdown with the bit and clamp it', () => {
  const mdf = findMaterial('mdf')
  expect(recommendedSettings(mdf, findBit('1/8-endmill'))).toEqual({ feed: 1500, plunge: 500, stepdown: 1.6, rpm: 18000, safeZ: 5 })
  expect(recommendedSettings(findMaterial('aluminium'), findBit('1mm-endmill')).stepdown).toBe(0.2)
  expect(recommendedSettings({ ...mdf, stepdownFrac: 2 }, findBit('6mm-endmill')).stepdown).toBe(6)
  expect(recommendedSettings(mdf, findBit('60-vbit')).stepdown).toBe(1)
})

test('library ids are unique and every combination is sane', () => {
  expect(new Set(BITS.map((b) => b.id)).size).toBe(BITS.length)
  for (const m of MATERIALS)
    for (const b of BITS) {
      const s = recommendedSettings(m, b)
      expect(s.stepdown).toBeGreaterThan(0)
      expect(s.plunge).toBeLessThan(s.feed)
    }
})
