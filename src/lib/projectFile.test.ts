import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { DEFAULT_TEXT_LAYOUT, defaultCut, newProject, type Project } from '../model'
import { scaleShape, textAtSize } from './geometry'
import { parseProject, parseProjectFile, serializeProject } from './projectFile'

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
    { id: 'b', type: 'text', name: 'Text', x: 50, y: 50, rotation: 0, text: 'Hi\nthere', font: 'lora', size: 20, w: 18, h: 14, letterSpacing: -1.5, lineHeight: 0.9, align: 'right', arc: -120, mirror: true },
    { id: 'c', type: 'compound', name: 'Logo', x: 0, y: 0, rotation: 0, fillRule: 'evenodd', paths: [{ closed: true, points: [[0, 0], [5, 0], [5, 5]] }] },
    { id: 'd', type: 'path', name: 'Path', x: 1, y: 1, rotation: 0, closed: false, points: [[0, 0], [9, 9]], cut: { ...defaultCut(12), type: 'outline', side: 'on' } },
  ],
})

const file = (project: unknown, extra = {}) => JSON.stringify({ format: 'opencarve', version: 2, project, ...extra })

// A fresh project with a detail bit and one carved shape of every type.
const everyShape = (): Project => {
  const p = newProject()
  const cut = defaultCut(p.stock.thickness)
  const base = { x: 10, y: 10, rotation: 0, cut }
  return {
    ...p,
    bits: { rough: '1/8-endmill', detail: '90-vbit' },
    cutSettings: { ...p.cutSettings, detail: p.cutSettings.rough },
    shapes: [
      { ...base, id: 'r', type: 'rect', name: 'Rect', w: 5, h: 5 },
      { ...base, id: 'e', type: 'ellipse', name: 'Ellipse', w: 5, h: 5 },
      { ...base, id: 'p', type: 'polygon', name: 'Polygon', w: 5, h: 5, sides: 6 },
      { ...base, id: 'l', type: 'path', name: 'Path', closed: true, points: [[0, 0], [5, 0], [5, 5]] },
      { ...base, id: 't', type: 'text', name: 'Text', text: 'A', font: 'roboto', size: 10, w: 5, h: 7, ...DEFAULT_TEXT_LAYOUT },
      { ...base, id: 'c', type: 'compound', name: 'Logo', paths: [{ closed: true, points: [[0, 0], [5, 0], [5, 5]] }] },
    ],
  }
}

test('round-trips a project', () => {
  for (const p of [sample(), everyShape()]) expect(parseProject(serializeProject(p))).toEqual(p)
})

// Deletes a field at a message-style path (e.g. shapes[4].font); top-level scalars are reported as project.<key>.
const without = (p: Project, path: string) => {
  const data = JSON.parse(serializeProject(p))
  const keys = path.replace(/^project\./, '').split(/[.[\]]+/).filter(Boolean)
  const parent = keys.slice(0, -1).reduce((o, k) => o[k], data.project)
  delete parent[keys.at(-1)!]
  return JSON.stringify(data)
}

test('a missing field is rejected with its path', () => {
  const paths = [
    'project.name', 'project.units', 'project.materialId', 'machine', 'bits', 'bitOverrides',
    'cutSettings', 'cutSettings.rough', 'cutSettings.detail', 'cutSettings.rough.feed', 'cutSettings.detail.direction',
    'cutSettingsCustom', 'cutSettingsCustom.rough', 'cutSettingsCustom.detail',
    'origin', 'origin.preset', 'origin.x', 'origin.y', 'origin.z',
    ...['name', 'rotation'].map((k) => `shapes[0].${k}`), 'shapes[2].sides', 'shapes[3].closed', 'shapes[5].paths[0].closed',
    ...['font', 'letterSpacing', 'lineHeight', 'align', 'arc', 'mirror'].map((k) => `shapes[4].${k}`),
    ...['type', 'side', 'depth', 'tabs', 'tabCount', 'tabWidth', 'tabHeight'].map((k) => `shapes[1].cut.${k}`),
  ]
  expect(() => parseProject(without(everyShape(), 'project.id'))).toThrow('Invalid project file: project.id is missing')
  for (const path of paths) expect(() => parseProject(without(everyShape(), path)), path).toThrow(`Invalid project file: ${path} is missing`)
  // cut and fillRule are optional by design: no cut means not carved, no fillRule means non-zero.
  const plain = parseProject(without(everyShape(), 'shapes[0].cut'))
  expect(plain.shapes[0]).not.toHaveProperty('cut')
  expect(plain.shapes[0]).not.toHaveProperty('fillRule')
  // cutSettings.detail exists exactly when there is a detail bit.
  expect(() => parseProject(without(everyShape(), 'bits.detail'))).toThrow('Invalid project file: cutSettings.detail is present without a detail bit')
})

test('work zero: round-trips, validates and clamps', () => {
  const p = { ...sample(), origin: { preset: 'custom' as const, x: 12.5, y: 40, z: 'bottom' as const } }
  expect(JSON.parse(serializeProject(p)).version).toBe(2)
  expect(parseProject(serializeProject(p))).toEqual(p)
  const old = sample()
  expect(() => parseProject(file(old, { version: 1 }))).toThrow('unsupported version 1')
  // Presets are re-derived from the stock.
  expect(parseProject(file({ ...old, origin: { preset: 'center', x: 1, y: 2, z: 'top' } })).origin).toMatchObject({ x: 150, y: 100 })
  const warnings: string[] = []
  expect(parseProject(file({ ...old, origin: { preset: 'custom', x: -5, y: 900, z: 'top' } }), warnings).origin).toMatchObject({ x: 0, y: 200 })
  expect(warnings).toEqual(['Work zero was outside the stock; moved to (0, 200) mm.'])
  expect(() => parseProject(file({ ...old, origin: { preset: 'middle' } }))).toThrow(/origin.preset/)
  expect(() => parseProject(file({ ...old, origin: { preset: 'custom', x: 'a' } }))).toThrow(/origin.x/)
  const full = { preset: 'custom', x: 1, y: 2, z: 'top' }
  expect(() => parseProject(file({ ...old, origin: { ...full, z: 'side' } }))).toThrow(/origin.z/)
  expect(() => parseProject(file({ ...old, origin: { ...full, x: null } }))).toThrow('Invalid project file: origin.x must be a number')
  expect(() => parseProject(file({ ...old, origin: null }))).toThrow(/origin must be an object/)
})

test('rejects garbage', () => {
  expect(() => parseProject('not json')).toThrow(/not JSON/)
  expect(() => parseProject('{"format":"svg"}')).toThrow(/not an OpenCarve project/)
  expect(() => parseProject(file(sample(), { version: 3 }))).toThrow('Invalid project file: unsupported version 3 (this app reads version 2)')
  expect(() => parseProject(file({ ...sample(), shapes: 'x' }))).toThrow(/shapes must be an array/)
  expect(() => parseProject(file({ ...sample(), stock: { w: NaN, h: 1, thickness: 1 } }))).toThrow(/stock.w/)
  expect(() => parseProject(file({ ...sample(), shapes: [{ id: 'z', type: 'blob', x: 0, y: 0 }] }))).toThrow(/shapes\[0\].type/)
  expect(() => parseProject(file({ ...sample(), shapes: [{ id: 'z', type: 'rect', name: 'R', x: 0, y: 0, rotation: 0, w: 1, h: -1 }] }))).toThrow(/shapes\[0\].h must be a number ≥ 0/)
})

test('validates cuts', () => {
  const rect = { id: 'a', type: 'rect', name: 'R', x: 0, y: 0, rotation: 0, w: 5, h: 5, cut: { ...defaultCut(6), type: 'pocket', depth: 99, tabCount: 0 } }
  const p = parseProject(file({ ...sample(), stock: { w: 100, h: 80, thickness: 6 }, shapes: [rect] }))
  expect(p.shapes[0]).toMatchObject({ cut: { type: 'pocket', depth: 6, tabCount: 1 } })
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
  const text = { ...textIn('comic', 't') }
  const p = parseProject(file({ ...sample(), materialId: 'unobtainium', shapes: [text, { ...text, id: 'u' }] }), warnings)
  expect(p.materialId).toBe('mdf')
  expect(p.shapes.map((s) => s.type === 'text' && s.font)).toEqual(['roboto', 'roboto'])
  expect(warnings).toEqual([expect.stringMatching(/unobtainium/), expect.stringMatching(/comic/)])
})

test('clamps polygon sides and renames duplicate shape ids', () => {
  const poly = { id: 'p', type: 'polygon', name: 'P', x: 0, y: 0, rotation: 0, w: 5, h: 5 }
  const p = parseProject(file({ ...sample(), shapes: [{ ...poly, sides: 1 }, { ...poly, sides: 500 }] }))
  expect(p.shapes.map((s) => s.type === 'polygon' && s.sides)).toEqual([3, 64])
  expect(p.shapes[0].id).toBe('p')
  expect(p.shapes[1].id).not.toBe('p')
})

const robotoBuf = () => {
  const b = readFileSync(new URL('../../public/fonts/Roboto-Regular.ttf', import.meta.url))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}
const textIn = (font: string, id = font) => ({ id, type: 'text' as const, name: 'T', x: 0, y: 0, rotation: 0, text: 'A', font, size: 10, w: 5, h: 7, ...DEFAULT_TEXT_LAYOUT })

test('embeds only the uploaded fonts text shapes use, and round-trips them', async () => {
  const data = robotoBuf()
  const p = { ...sample(), shapes: [textIn('upload:a'), textIn('fs:lora', 'f')] }
  const text = serializeProject(p, { 'upload:a': { name: 'Mine', data }, 'upload:b': { name: 'Unused', data } })
  expect(Object.keys(JSON.parse(text).fonts)).toEqual(['upload:a'])
  expect(JSON.parse(serializeProject(sample(), { 'upload:a': { name: 'Mine', data } })).fonts).toBeUndefined()
  const warnings: string[] = []
  const { project, fonts } = await parseProjectFile(text, warnings)
  expect(warnings).toEqual([])
  expect(project.shapes.map((s) => s.type === 'text' && s.font)).toEqual(['upload:a', 'fs:lora'])
  expect(fonts['upload:a'].name).toBe('Mine')
  expect(new Uint8Array(fonts['upload:a'].data)).toEqual(new Uint8Array(data))
})

test('uploaded fonts must be embedded validly or already stored, else fall back to Roboto', async () => {
  const shapes = [textIn('upload:bad'), textIn('upload:big'), textIn('upload:stored'), textIn('upload:gone')]
  const big = 'A'.repeat(7_000_000 + 4)
  const text = file({ ...sample(), shapes }, { fonts: { 'upload:bad': { name: 'Bad', data: btoa('not a font') }, 'upload:big': { name: 'Big', data: big } } })
  const warnings: string[] = []
  const { project, fonts } = await parseProjectFile(text, warnings, async (id) => id === 'upload:stored')
  expect(fonts).toEqual({})
  expect(project.shapes.map((s) => s.type === 'text' && s.font)).toEqual(['roboto', 'roboto', 'upload:stored', 'roboto'])
  expect(warnings).toEqual([expect.stringMatching(/"Bad"/), expect.stringMatching(/"Big".*5 MB/), expect.stringMatching(/3 uploaded fonts are missing/)])
})

test('fontsource ids are kept; malformed ones fall back', () => {
  const warnings: string[] = []
  const p = parseProject(file({ ...sample(), shapes: [textIn('fs:great-vibes'), textIn('fs:../x', 'y')] }), warnings)
  expect(p.shapes.map((s) => s.type === 'text' && s.font)).toEqual(['fs:great-vibes', 'roboto'])
  expect(warnings).toEqual([expect.stringMatching(/fs:\.\.\/x/)])
})

test('rejects out-of-range text layout values', () => {
  const text = textIn('roboto', 't')
  expect(parseProject(file({ ...sample(), shapes: [{ ...text, letterSpacing: -5 }] })).shapes[0]).toMatchObject({ letterSpacing: -5 })
  for (const [key, bad] of [['letterSpacing', -5.1], ['lineHeight', 0.4], ['lineHeight', 3.5], ['arc', 400], ['arc', -361], ['align', 'justify'], ['mirror', 'yes']] as const) {
    expect(() => parseProject(file({ ...sample(), shapes: [{ ...text, [key]: bad }] }))).toThrow(new RegExp(`shapes\\[0\\].${key}`))
  }
})

test('a text with a broken bounds cache (NaN saved as null) still opens, with an estimate', () => {
  const text = { ...textIn('roboto', 't'), text: 'Hi', w: null, h: null, arc: 1e-320 }
  const p = parseProject(file({ ...sample(), shapes: [text] }))
  expect(p.shapes[0]).toMatchObject({ w: 12, h: 10, arc: 1e-320 })
  expect(parseProject(serializeProject(p))).toEqual(p)
})

test('validates bit overrides, dropping bad ones with a warning', () => {
  const warnings: string[] = []
  const p = parseProject(
    file({
      ...sample(),
      bits: { rough: '1/8-endmill' },
      cutSettings: { rough: newProject().cutSettings.rough },
      bitOverrides: { rough: { diameter: 6, bogus: 1 }, detail: { diameter: 2 }, laser: { diameter: 1 } },
    }),
    warnings,
  )
  expect(p.bitOverrides).toEqual({ rough: { diameter: 6 } })
  expect(warnings).toEqual(['Ignored the detail bit override: no detail bit.', 'Ignored the laser bit override: no laser bit.'])
  for (const bad of [{ diameter: 'x' }, { diameter: 60 }, { angle: 5 }, { flat: 20 }, { flat: null }, 3]) {
    const w: string[] = []
    expect(parseProject(file({ ...sample(), bitOverrides: { detail: bad } }), w).bitOverrides).toEqual({})
    expect(w).toHaveLength(1)
  }
  expect(() => parseProject(file({ ...sample(), bitOverrides: [] }))).toThrow(/bitOverrides must be an object/)
  // Values equal to the library bit (within display rounding) aren't overrides.
  expect(parseProject(file({ ...sample(), bitOverrides: { rough: { diameter: 3.17 }, detail: { angle: 90, flat: 1 } } })).bitOverrides).toEqual({ detail: { flat: 1 } })
})

test('resizing text at the tightest letter spacing still saves a file that opens', () => {
  // (17.3, 31) is a pair where plain proportional scaling rounds below -size/2.
  for (const [from, to] of [[17.3, 31], [10, 25.4], [7, 6.35], [33.3, 4.1]]) {
    const t = { ...textIn('roboto', 't'), size: from, letterSpacing: -from / 2 }
    for (const s of [textAtSize(t, to), scaleShape(t, to / from, to / from)]) {
      const p = { ...sample(), shapes: [s] }
      expect(parseProject(serializeProject(p))).toEqual(p)
    }
  }
})
