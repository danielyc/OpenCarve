import { del, get, set, update } from 'idb-keyval'
import { newId, type Project } from '../model'
import { useAppStore } from '../store'
import { parseProject, serializeProject } from './projectFile'

// IndexedDB layout: an index of entries, one record per project (the same versioned JSON as a .opencarve file,
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

export const listProjects = async () => ((await get<ProjectEntry[]>(INDEX)) ?? []).sort((a, b) => b.updatedAt - a.updatedAt)

export async function readProject(id: string): Promise<Project | null> {
  const text = await get<string>(key(id))
  return text ? parseProject(text) : null
}

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

function write(p: Project) {
  clearTimeout(timer)
  timer = undefined
  saved = p
  writing = writing
    .then(() => saveProject(p))
    .catch((e) => {
      saved = null // retried on the next change
      useAppStore.setState({ status: `Could not save: ${(e as Error).message}` })
    })
}

export function flush(): Promise<void> {
  clearTimeout(timer)
  timer = undefined
  const s = useAppStore.getState()
  const p = s.transientBase ?? s.project
  if (s.screen === 'editor' && p !== saved) write(p)
  return writing.then(() => {
    if (!timer) useAppStore.setState({ saving: false })
  })
}

export function startAutosave() {
  useAppStore.subscribe((s, prev) => {
    if (s.project.id !== prev.project.id || s.screen !== prev.screen) {
      if (timer) write(prev.transientBase ?? prev.project) // don't lose a pending save when switching away
      saved = s.project
      useAppStore.setState({ saving: false })
      set(LAST_OPEN, s.screen === 'editor' ? s.project.id : null).catch(console.error)
      return
    }
    if (s.project === prev.project && s.transientBase === prev.transientBase) return
    if (s.screen !== 'editor' || s.transientBase || s.project === saved) return
    clearTimeout(timer)
    timer = setTimeout(flush, AUTOSAVE_MS)
    if (!s.saving) useAppStore.setState({ saving: true })
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

// Opened files get a fresh id so they never overwrite a stored project, and are stored right away.
export async function openFile(file: File | undefined) {
  if (!file) return
  try {
    const p = { ...parseProject(await file.text()), id: newId() }
    useAppStore.getState().loadProject(p)
    await saveProject(p)
  } catch (e) {
    alert(`Could not open ${file.name}: ${(e as Error).message}`)
  }
}

export function downloadProject(p: Project) {
  const url = URL.createObjectURL(new Blob([serializeProject(p)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${p.name || 'Untitled'}.opencarve`.replace(/[\\/:*?"<>|]/g, '_')
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
