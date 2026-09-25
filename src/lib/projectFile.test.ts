import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { defaultCut, newProject, type Project } from '../model'
import { parseProject, parseProjectFile, serializeProject } from './projectFile'

const sample = (): Project => ({
  ...newProject(),
  name: 'Sign',
  units: 'in',
  bits: { rough: '1/8-endmill', detail: '90-vbit' },
  cutSettings: { ...newProject().cutSettings, detail: { ...newProject().cutSettings.rough, feed: 900 } },
  cutSettingsCustom: { rough: false, detail: true },
  shapes: [
    { id: 'a', type: 'rect', name: 'Rect', x: 10, y: 20, rotation: 15, w: 30, h: 40, cut: defaultCut(12) },
    { id: 'b', type: 'text', name: 'Text', x: 50, y: 50, rotation: 0, text: 'Hi\nthere', font: 'lora', size: 20, w: 18, h: 14, letterSpacing: -1.5, lineHeight: 0.9, align: 'right', arc: -120, mirror: true },
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

const robotoBuf = () => {
  const b = readFileSync(new URL('../../public/fonts/Roboto-Regular.ttf', import.meta.url))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}
const textIn = (font: string, id = font) => ({ id, type: 'text' as const, name: 'T', x: 0, y: 0, rotation: 0, text: 'A', font, size: 10, w: 5, h: 7 })

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

test('fills text layout defaults for old files and rejects out-of-range values', () => {
  const text = { id: 't', type: 'text', x: 0, y: 0, text: 'A', font: 'roboto', size: 10, w: 5, h: 7 }
  expect(parseProject(file({ ...sample(), shapes: [text] })).shapes[0]).toMatchObject({ letterSpacing: 0, lineHeight: 1.2, align: 'center', arc: 0, mirror: false })
  for (const [key, bad] of [['letterSpacing', -6], ['lineHeight', 0.4], ['lineHeight', 3.5], ['arc', 400], ['arc', -361], ['align', 'justify'], ['mirror', 'yes']] as const) {
    expect(() => parseProject(file({ ...sample(), shapes: [{ ...text, [key]: bad }] }))).toThrow(new RegExp(`shapes\\[0\\].${key}`))
  }
})
