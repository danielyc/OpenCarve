import { expect, test } from 'vitest'
import { BITS, findBit, findMaterial, MATERIALS, recommendedSettings } from './library'

const mdf = findMaterial('mdf')

test('recommended settings scale with the bit and clamp stepdown', () => {
  expect(recommendedSettings(mdf, findBit('1/8-endmill'), 24000)).toEqual({
    feed: 1500,
    plunge: 500,
    stepdown: 1.6,
    rpm: 18000,
    safeZ: 5,
    stepover: 0.4,
    direction: 'conventional',
  })
  expect(recommendedSettings(findMaterial('aluminium'), findBit('1mm-endmill'), 24000).stepdown).toBe(0.2)
  expect(recommendedSettings({ ...mdf, stepdownFrac: 2 }, findBit('6mm-endmill'), 24000).stepdown).toBe(6)
  expect(recommendedSettings(mdf, findBit('60-vbit'), 24000)).toMatchObject({ stepdown: 1, feed: 1500 })
  expect(recommendedSettings(mdf, { ...findBit('60-vbit'), flat: 0.5 }, 24000).stepdown).toBe(0.5)
})

test('feed and plunge follow the bit diameter, rpm the machine', () => {
  expect(recommendedSettings(mdf, findBit('1mm-endmill'), 24000).feed).toBeLessThanOrEqual(600)
  expect(recommendedSettings(mdf, findBit('1/4-endmill'), 24000)).toMatchObject({ feed: 2250, plunge: 750 })
  expect(recommendedSettings(mdf, findBit('1/8-endmill'), 10000)).toMatchObject({ rpm: 10000, feed: 833 })
})

test('library ids are unique and every combination is sane', () => {
  expect(new Set(BITS.map((b) => b.id)).size).toBe(BITS.length)
  for (const m of MATERIALS)
    for (const b of BITS) {
      const s = recommendedSettings(m, b, 24000)
      expect(s.stepdown).toBeGreaterThan(0)
      expect(s.plunge).toBeLessThan(s.feed)
    }
})
