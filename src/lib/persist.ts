import { del, get, set, update } from 'idb-keyval'
import { newId, newProject, type Project, type TextShape } from '../model'
import { useAppStore } from '../store'
import { FONTS, forgetFont, getUploadedFont, loadFont, removeUploadedFont, storeUploadedFont } from './fonts'
import { fitText } from './geometry'
import { parseProjectFile, serializeProject, uploadedFontIds, type EmbeddedFonts } from './projectFile'

// IndexedDB layout: an index of entries, one record per project (the same versioned JSON as a .oc file,
// so records can later be synced verbatim), and the id of the project to reopen on load.
export interface ProjectEntry {
  id: string
  name: string
  updatedAt: number
  stock: Project['stock']
  units: Project['units']
}

const INDEX = 'opencarve:index'
const LAST_OPEN = 'opencarve:lastOpen'
const key = (id: string) => `opencarve:project:${id}`
const AUTOSAVE_MS = 1000
const RETRY_MS = 5000
const MAX_RETRY_MS = 60_000

export const listProjects = async () => ((await get<ProjectEntry[]>(INDEX)) ?? []).sort((a, b) => b.updatedAt - a.updatedAt)

export async function readProject(id: string): Promise<Project | null> {
  const text = await get<string>(key(id))
  return text ? (await parseProjectFile(text, [], hasFont)).project : null
}

const hasFont = async (id: string) => !!(await getUploadedFont(id))

export async function saveProject(p: Project) {
  await set(key(p.id), serializeProject(p))
  const entry: ProjectEntry = { id: p.id, name: p.name, updatedAt: Date.now(), stock: p.stock, units: p.units }
  await update<ProjectEntry[]>(INDEX, (list = []) => [entry, ...list.filter((e) => e.id !== p.id)])
}

export async function deleteProject(id: string) {
  await del(key(id))
  await update<ProjectEntry[]>(INDEX, (list = []) => list.filter((e) => e.id !== id))
  if ((await get(LAST_OPEN)) === id) await del(LAST_OPEN)
}

export async function duplicateProject(id: string) {
  const p = await readProject(id)
  if (p) await saveProject({ ...p, id: newId(), name: `${p.name} copy` })
}

// Autosave tracks the committed project (a drag in progress is not saved). Opening a project (new id or screen switch)
// marks it saved as-is, so merely opening one doesn't bump its updatedAt.
let saved: Project | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let writing: Promise<void> = Promise.resolve()
let retryMs = RETRY_MS

const committed = () => {
  const s = useAppStore.getState()
  return s.transientBase ?? s.project
}

// A failed write shows "Not saved" and retries with backoff; the retry writes the latest state of that project.
// ponytail: one pending save/retry slot; switching projects twice while a write keeps failing can drop the older retry.
function write(p: Project): Promise<void> {
  clearTimeout(timer)
  timer = undefined
  saved = p
  writing = writing
    .then(() => saveProject(p))
    .then(
      () => {
        retryMs = RETRY_MS
        if (!timer) useAppStore.setState({ saveState: 'saved' })
      },
      (e) => {
        console.error('Save failed', e)
        if (saved === p) saved = null
        useAppStore.setState({ saveState: 'failed' })
        clearTimeout(timer)
        timer = setTimeout(() => void write(committed().id === p.id ? committed() : p), retryMs)
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
      },
    )
  return writing
}

export function flush(): Promise<void> {
  const s = useAppStore.getState()
  const p = committed()
  if (s.screen === 'editor' && p !== saved) return write(p)
  if (s.saveState !== 'failed') {
    clearTimeout(timer)
    timer = undefined
  }
  return writing.then(() => {
    if (!timer) useAppStore.setState({ saveState: 'saved' })
  })
}

export function startAutosave() {
  useAppStore.subscribe((s, prev) => {
    if (s.project.id !== prev.project.id || s.screen !== prev.screen) {
      if (timer) write(prev.transientBase ?? prev.project) // don't lose a pending save when switching away
      saved = s.project
      set(LAST_OPEN, s.screen === 'editor' ? s.project.id : null).catch(console.error)
      return
    }
    if (s.project === prev.project && s.transientBase === prev.transientBase) return
    if (s.screen !== 'editor' || s.transientBase || s.project === saved) return
    clearTimeout(timer)
    timer = setTimeout(flush, AUTOSAVE_MS)
    if (s.saveState === 'saved') useAppStore.setState({ saveState: 'saving' })
  })
  // Best effort: a pending save gets written when the tab is hidden or closed.
  document.addEventListener('visibilitychange', () => document.hidden && void flush())
}

export async function boot() {
  startAutosave()
  try {
    const id = await get<string | null>(LAST_OPEN)
    const p = id && (await readProject(id))
    if (p) useAppStore.getState().loadProject(p)
  } catch (e) {
    console.error(e) // storage unavailable or a corrupt record: start on the home screen
  }
}

export async function goHome() {
  await flush()
  useAppStore.getState().setScreen('home')
}

// New projects are stored right away so they show up in the project list even before the first edit.
export async function createProject() {
  const p = newProject()
  useAppStore.getState().loadProject(p, 'settings')
  await write(p)
}

// Opened files get a fresh id so they never overwrite a stored project, and are stored right away.
export async function openFile(file: File | undefined) {
  if (!file) return
  try {
    const warnings: string[] = []
    const parsed = await parseProjectFile(await file.text(), warnings, hasFont)
    const p = { ...(await importFonts(parsed.project, parsed.fonts, warnings)), id: newId() }
    useAppStore.getState().loadProject(p)
    await saveProject(p)
    // Same pattern as SVG import: the canvas status line is cleared by font loads, so notes go in a dialog.
    if (warnings.length) alert(`Opened ${file.name} with changes:\n${warnings.join('\n')}`)
  } catch (e) {
    alert(`Could not open ${file.name}: ${(e as Error).message}`)
  }
}

const sameBytes = (a: ArrayBuffer, b: ArrayBuffer) => {
  if (a.byteLength !== b.byteLength) return false
  const [x, y] = [new Uint8Array(a), new Uint8Array(b)]
  return x.every((v, i) => v === y[i])
}

// Stores a file's embedded fonts in this browser. An id already stored with different bytes (another file's font)
// gets a fresh id; a font that can't be stored (e.g. quota) is dropped and its text falls back to Roboto.
export async function importFonts(project: Project, fonts: EmbeddedFonts, warnings: string[]): Promise<Project> {
  const remap = new Map<string, string>()
  for (const [id, f] of Object.entries(fonts)) {
    try {
      const stored = await getUploadedFont(id)
      if (stored && sameBytes(stored.data, f.data)) continue
      const newId = stored ? `upload:${crypto.randomUUID()}` : id
      await storeUploadedFont({ id: newId, ...f })
      if (newId !== id) remap.set(id, newId)
    } catch (e) {
      warnings.push(`Could not store the font "${f.name}" (${(e as Error).message}); its text uses ${FONTS[0].name}.`)
      remap.set(id, FONTS[0].id)
    }
  }
  if (!remap.size) return project
  return { ...project, shapes: project.shapes.map((s) => (s.type === 'text' && remap.has(s.font) ? { ...s, font: remap.get(s.font)! } : s)) }
}

// Names of stored projects (other than `exceptId`) whose text uses the font.
export async function fontUsers(fontId: string, exceptId?: string): Promise<string[]> {
  const needle = JSON.stringify(fontId)
  const users: string[] = []
  for (const e of await listProjects()) {
    if (e.id !== exceptId && (await get<string>(key(e.id)))?.includes(needle)) users.push(e.name)
  }
  return users
}

// Removes an uploaded font unless another saved project still uses it (those names are returned instead). Text in
// the open project switches to Roboto (undoable); undoing shows it unavailable rather than drawing it from memory.
export async function removeFont(fontId: string): Promise<{ blockedBy: string[]; fellBack: number }> {
  const st = useAppStore.getState()
  const blockedBy = await fontUsers(fontId, st.project.id)
  if (blockedBy.length) return { blockedBy, fellBack: 0 }
  await removeUploadedFont(fontId)
  forgetFont(fontId)
  const ids = st.project.shapes.filter((s) => s.type === 'text' && s.font === fontId).map((s) => s.id)
  if (ids.length) {
    const refit = (await loadFont(FONTS[0].id).then(() => true, () => false)) ? fitText : (t: TextShape) => t
    st.updateShapes(ids, (s) => (s.type === 'text' ? refit({ ...s, font: FONTS[0].id }) : s))
  }
  return { blockedBy, fellBack: ids.length }
}

// Every referenced uploaded font must be embedded, or the file wouldn't open elsewhere.
export async function downloadProject(p: Project) {
  const fonts: EmbeddedFonts = {}
  for (const id of uploadedFontIds(p)) {
    const f = await getUploadedFont(id).catch(() => undefined)
    if (!f) throw new Error(`a font it uses (${id}) is missing from this browser`)
    fonts[id] = { name: f.name, data: f.data }
  }
  const url = URL.createObjectURL(new Blob([serializeProject(p, fonts)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${p.name || 'Untitled'}.oc`.replace(/[\\/:*?"<>|]/g, '_')
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
