// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { DEFAULT_TEXT_LAYOUT, newProject, type TextShape } from '../model'
import { useAppStore } from '../store'
import { getUploadedFont, loadFont, storeUploadedFont, textGlyphs } from './fonts'
import { createProject, deleteProject, downloadProject, flush, importFonts, listProjects, openFile, readProject, removeFont, saveProject, startAutosave } from './persist'
import { serializeProject } from './projectFile'

const db = new Map<string, unknown>()
let failures = 0
let failKey = ''
vi.mock('idb-keyval', () => ({
  get: async (k: string) => db.get(k),
  set: async (k: string, v: unknown) => {
    if (k.startsWith('opencarve:project:') && failures-- > 0) throw new Error('quota')
    if (k === failKey) throw new Error('quota')
    db.set(k, v)
  },
  del: async (k: string) => void db.delete(k),
  update: async (k: string, fn: (v: unknown) => unknown) => void db.set(k, fn(db.get(k))),
}))

afterEach(() => vi.useRealTimers())

test('a failed save shows as failed and retries with backoff until it succeeds', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  startAutosave()
  const st = useAppStore.getState
  st().loadProject(newProject())
  const id = st().project.id
  failures = 2
  st().setProjectName('Draft')
  expect(st().saveState).toBe('saving')

  await vi.advanceTimersByTimeAsync(1000) // autosave → first failure
  expect(st().saveState).toBe('failed')
  await vi.advanceTimersByTimeAsync(5000) // retry after 5 s → second failure
  expect(st().saveState).toBe('failed')
  await vi.advanceTimersByTimeAsync(9999) // backoff doubled to 10 s
  expect(db.has(`opencarve:project:${id}`)).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(st().saveState).toBe('saved')
  expect(db.get(`opencarve:project:${id}`)).toContain('"Draft"')
})

// Uses the autosave subscription started by the test above.
test('a new project is stored at once; reopening it does not bump updatedAt', async () => {
  await createProject()
  expect(useAppStore.getState().step).toBe('settings')
  const id = useAppStore.getState().project.id
  const entry = (await listProjects()).find((e) => e.id === id)!
  expect(entry).toBeDefined()
  useAppStore.getState().setScreen('home')
  await new Promise((r) => setTimeout(r, 5)) // a rewrite would get a later timestamp
  useAppStore.getState().loadProject((await readProject(id))!)
  expect(useAppStore.getState().step).toBe('design')
  await flush()
  expect((await listProjects()).find((e) => e.id === id)!.updatedAt).toBe(entry.updatedAt)
})

const fontBuf = (file: string) => {
  const b = readFileSync(`public/fonts/${file}`) // jsdom: import.meta.url is not a file URL
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}
const textIn = (font: string, id = 't'): TextShape => ({ id, type: 'text', name: 'T', x: 0, y: 0, rotation: 0, text: 'Hi', font, size: 10, w: 5, h: 7, ...DEFAULT_TEXT_LAYOUT })
const fontOf = (i = 0) => (useAppStore.getState().project.shapes[i] as TextShape).font

test('removing an uploaded font is refused while another saved project uses it; afterwards undo shows it unavailable', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const st = useAppStore.getState
  await storeUploadedFont({ id: 'upload:x', name: 'Mine', data: fontBuf('Lora-Regular.ttf') })
  const other = { ...newProject(), name: 'Other sign', shapes: [textIn('upload:x')] }
  await saveProject(other)
  st().loadProject({ ...newProject(), shapes: [textIn('upload:x')] })
  await loadFont('upload:x')
  expect(textGlyphs(textIn('upload:x'))).not.toBeNull()

  expect(await removeFont('upload:x')).toEqual({ blockedBy: ['Other sign'], fellBack: 0 })
  expect(await getUploadedFont('upload:x')).toBeDefined()

  await deleteProject(other.id)
  expect(await removeFont('upload:x')).toEqual({ blockedBy: [], fellBack: 1 })
  expect(await getUploadedFont('upload:x')).toBeUndefined()
  expect(fontOf()).toBe('roboto')
  st().undo()
  expect(fontOf()).toBe('upload:x')
  expect(textGlyphs(textIn('upload:x'))).toBeNull() // not drawn from a stale cache
})

test('saving a file refuses when a used uploaded font is missing', async () => {
  await expect(downloadProject({ ...newProject(), shapes: [textIn('upload:gone')] })).rejects.toThrow(/missing/)
})

test('two files embedding different fonts under the same id both keep their own font', async () => {
  vi.spyOn(window, 'alert').mockImplementation(() => {})
  const [lora, roboto] = [fontBuf('Lora-Regular.ttf'), fontBuf('Roboto-Regular.ttf')]
  const fileWith = (data: ArrayBuffer, name: string) =>
    new File([serializeProject({ ...newProject(), shapes: [textIn('upload:shared')] }, { 'upload:shared': { name, data } })], `${name}.oc`)
  await openFile(fileWith(lora, 'Lora'))
  expect(fontOf()).toBe('upload:shared')
  await openFile(fileWith(roboto, 'Roboto'))
  const renamed = fontOf()
  expect(renamed).toMatch(/^upload:/)
  expect(renamed).not.toBe('upload:shared')
  expect((await getUploadedFont('upload:shared'))!.data.byteLength).toBe(lora.byteLength)
  expect((await getUploadedFont(renamed))!.data.byteLength).toBe(roboto.byteLength)
  await openFile(fileWith(lora, 'Lora')) // identical bytes: reuses the stored font
  expect(fontOf()).toBe('upload:shared')
})

test('a font that cannot be stored (quota) falls back to Roboto with a warning', async () => {
  failKey = 'opencarve:font:upload:q'
  const warnings: string[] = []
  const p = await importFonts({ ...newProject(), shapes: [textIn('upload:q')] }, { 'upload:q': { name: 'Q', data: fontBuf('Lora-Regular.ttf') } }, warnings)
  failKey = ''
  expect((p.shapes[0] as TextShape).font).toBe('roboto')
  expect(warnings).toEqual([expect.stringMatching(/Could not store the font "Q"/)])
})
