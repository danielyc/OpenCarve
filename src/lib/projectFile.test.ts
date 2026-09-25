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
  expect(p.machine.maxRpm).toBeGreaterThan(0)
  expect(p.shapes[0]).toMatchObject({ name: 'rect', rotation: 0, cut: { type: 'pocket', depth: 6, tabs: true, tabCount: 4 } })
})
