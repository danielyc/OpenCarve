import { expect, test } from 'vitest'
import { defaultCut, newProject, type Project } from '../model'
import { parseProject, serializeProject } from './projectFile'

const sample = (): Project => ({
  ...newProject(),
  name: 'Sign',
  units: 'in',
  bits: { rough: '1/8-endmill', detail: '90-vbit' },
  cutSettings: { ...newProject().cutSettings, detail: { ...newProject().cutSettings.rough, feed: 900 } },
  cutSettingsCustom: { rough: false, detail: true },
  bitOverrides: { rough: { diameter: 3 }, detail: { angle: 60, flat: 0.5 } },
  shapes: [
    { id: 'a', type: 'rect', name: 'Rect', x: 10, y: 20, rotation: 15, w: 30, h: 40, cut: defaultCut(12) },
    { id: 'b', type: 'text', name: 'Text', x: 50, y: 50, rotation: 0, text: 'Hi', font: 'lora', size: 20, w: 18, h: 14 },
    { id: 'c', type: 'compound', name: 'Logo', x: 0, y: 0, rotation: 0, fillRule: 'evenodd', paths: [{ closed: true, points: [[0, 0], [5, 0], [5, 5]] }] },
    { id: 'd', type: 'path', name: 'Path', x: 1, y: 1, rotation: 0, closed: false, points: [[0, 0], [9, 9]], cut: { ...defaultCut(12), type: 'outline', side: 'on' } },
  ],
})

const file = (project: unknown, extra = {}) => JSON.stringify({ format: 'opencarve', version: 1, project, ...extra })

test('round-trips a project', () => {
  const p = sample()
  expect(parseProject(serializeProject(p))).toEqual(p)
})

test('rejects garbage', () => {
  expect(() => parseProject('not json')).toThrow(/not JSON/)
  expect(() => parseProject('{"format":"svg"}')).toThrow(/not an OpenCarve project/)
  expect(() => parseProject(file(sample(), { version: 2 }))).toThrow(/unsupported version 2/)
  expect(() => parseProject(file({ ...sample(), shapes: 'x' }))).toThrow(/shapes must be an array/)
  expect(() => parseProject(file({ ...sample(), stock: { w: NaN, h: 1, thickness: 1 } }))).toThrow(/stock.w/)
  expect(() => parseProject(file({ ...sample(), shapes: [{ id: 'z', type: 'blob', x: 0, y: 0 }] }))).toThrow(/shapes\[0\].type/)
  expect(() => parseProject(file({ ...sample(), shapes: [{ id: 'z', type: 'rect', x: 0, y: 0, w: 1 }] }))).toThrow(/shapes\[0\].h/)
})

test('fills defaults for missing optional fields and validates cuts', () => {
  const p = parseProject(
    file({
      id: 'old',
      stock: { w: 100, h: 80, thickness: 6 },
      bits: { rough: '1/8-endmill' },
      shapes: [{ id: 'a', type: 'rect', x: 0, y: 0, w: 5, h: 5, cut: { type: 'pocket', depth: 99 } }],
    }),
  )
  expect(p.name).toBe('Untitled')
  expect(p.units).toBe('mm')
  expect(p.cutSettings.rough.feed).toBeGreaterThan(0)
  expect(p.cutSettingsCustom).toEqual({ rough: false, detail: false })
  expect(p.bitOverrides).toEqual({})
  expect(p.machine.maxRpm).toBeGreaterThan(0)
  expect(p.shapes[0]).toMatchObject({ name: 'rect', rotation: 0, cut: { type: 'pocket', depth: 6, tabs: true, tabCount: 4 } })
})

test('rejects unknown bits and invalid cut settings', () => {
  expect(() => parseProject(file({ ...sample(), bits: { rough: 'laser' } }))).toThrow(/unknown bit laser/)
  expect(() => parseProject(file({ ...sample(), bits: { rough: '1/8-endmill', detail: 'nope' } }))).toThrow(/unknown bit nope/)
  const rough = newProject().cutSettings.rough
  for (const key of ['feed', 'plunge', 'stepdown', 'rpm']) {
    expect(() => parseProject(file({ ...sample(), cutSettings: { rough: { ...rough, [key]: 0 } } }))).toThrow(new RegExp(`${key} must be > 0`))
  }
  expect(() => parseProject(file({ ...sample(), cutSettings: { rough: { ...rough, safeZ: 0.2 } } }))).toThrow(/safeZ/)
})

test('maps unknown material and font ids to defaults with warnings', () => {
  const warnings: string[] = []
  const text = { id: 't', type: 'text', x: 0, y: 0, text: 'A', font: 'comic', size: 10, w: 5, h: 7 }
  const p = parseProject(file({ ...sample(), materialId: 'unobtainium', shapes: [text, { ...text, id: 'u' }] }), warnings)
  expect(p.materialId).toBe('mdf')
  expect(p.shapes.map((s) => s.type === 'text' && s.font)).toEqual(['roboto', 'roboto'])
  expect(warnings).toEqual([expect.stringMatching(/unobtainium/), expect.stringMatching(/comic/)])
})

test('clamps polygon sides and renames duplicate shape ids', () => {
  const poly = { id: 'p', type: 'polygon', x: 0, y: 0, w: 5, h: 5 }
  const p = parseProject(file({ ...sample(), shapes: [{ ...poly, sides: 1 }, { ...poly, sides: 500 }] }))
  expect(p.shapes.map((s) => s.type === 'polygon' && s.sides)).toEqual([3, 64])
  expect(p.shapes[0].id).toBe('p')
  expect(p.shapes[1].id).not.toBe('p')
})

test('validates bit overrides, dropping bad ones with a warning', () => {
  const warnings: string[] = []
  const p = parseProject(
    file({
      ...sample(),
      bits: { rough: '1/8-endmill' },
      cutSettings: undefined,
      cutSettingsCustom: undefined,
      bitOverrides: { rough: { diameter: 6, bogus: 1 }, detail: { diameter: 2 }, laser: { diameter: 1 } },
    }),
    warnings,
  )
  expect(p.bitOverrides).toEqual({ rough: { diameter: 6 } })
  expect(p.cutSettings.rough.stepdown).toBe(3) // recommended from the effective bit
  expect(warnings).toEqual(['Ignored the detail bit override: no detail bit.', 'Ignored the laser bit override: no laser bit.'])
  for (const bad of [{ diameter: 'x' }, { diameter: 60 }, { angle: 5 }, { flat: 20 }, 3]) {
    const w: string[] = []
    expect(parseProject(file({ ...sample(), bitOverrides: { detail: bad } }), w).bitOverrides).toEqual({})
    expect(w).toHaveLength(1)
  }
  expect(() => parseProject(file({ ...sample(), bitOverrides: [] }))).toThrow(/bitOverrides must be an object/)
})
