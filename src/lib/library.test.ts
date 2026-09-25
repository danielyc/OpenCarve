import { expect, test } from 'vitest'
import { BITS, differingFields, effectiveBit, findBit, findMaterial, MACHINES, MATERIALS, overrideError, recommendedSettings } from './library'

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
  expect(recommendedSettings(mdf, { ...findBit('60-vbit'), flat: 0.5 }, 24000).stepdown).toBe(1)
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

test('effectiveBit merges the role override and marks it custom', () => {
  const bits = { rough: '1/8-endmill', detail: '60-vbit' }
  expect(effectiveBit({ bits, bitOverrides: {} }, 'rough')).toBe(findBit('1/8-endmill'))
  expect(effectiveBit({ bits, bitOverrides: { rough: {} } }, 'rough')).toBe(findBit('1/8-endmill'))
  expect(effectiveBit({ bits, bitOverrides: { rough: { diameter: 6 } } }, 'rough').name).toBe('1/8" (3.175 mm) endmill (custom 6 mm)')
  expect(effectiveBit({ bits, bitOverrides: { detail: { angle: 30, flat: 1 } } }, 'detail')).toEqual({
    ...findBit('60-vbit'),
    name: '60° V-bit, 1/2" (12.7 mm) (custom 12.7 mm, 30°, flat 1 mm)',
    angle: 30,
    flat: 1,
  })
})

test('overrideError enforces ranges and V-bit-only fields', () => {
  const end = findBit('1/8-endmill')
  const v = findBit('90-vbit')
  expect(overrideError(end, { diameter: 6 })).toBeNull()
  expect(overrideError(end, { diameter: 0.05 })).toMatch(/Diameter/)
  expect(overrideError(end, { diameter: 51 })).toMatch(/Diameter/)
  expect(overrideError(end, { diameter: NaN })).toMatch(/diameter must be a number/)
  expect(overrideError(v, { flat: null as unknown as number })).toMatch(/flat must be a number/)
  expect(overrideError(end, { angle: 60 })).toMatch(/V-bits/)
  expect(overrideError(v, { angle: 10, flat: 0 })).toBeNull()
  expect(overrideError(v, { angle: 171 })).toMatch(/Angle/)
  expect(overrideError(v, { flat: -1 })).toMatch(/Flat/)
  expect(overrideError(v, { diameter: 2, flat: 2 })).toMatch(/Flat/)
})

test('machine presets have unique names and include the TTC450', () => {
  expect(new Set(MACHINES.map((m) => m.name)).size).toBe(MACHINES.length)
  expect(MACHINES).toContainEqual({ name: 'TwoTrees TTC450 (500 W)', w: 460, h: 460, maxRpm: 12000 })
})

test('differingFields drops values within display rounding of the library bit', () => {
  expect(differingFields(findBit('1/8-endmill'), { diameter: 3.17 })).toEqual({})
  expect(differingFields(findBit('1/8-endmill'), { diameter: 3.16 })).toEqual({ diameter: 3.16 })
  expect(differingFields(findBit('90-vbit'), { angle: 90.0001, flat: 0.001 })).toEqual({})
  expect(differingFields(findBit('90-vbit'), { angle: 90.001, flat: 0.01 })).toEqual({ angle: 90.001, flat: 0.01 })
})
