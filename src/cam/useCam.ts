import { useEffect } from 'react'
import { fontFailed, fontSource, missingGlyphs } from '../lib/fonts'
import { localPolylines } from '../lib/geometry'
import type { Project, Shape } from '../model'
import { useAppStore } from '../store'
import type { CamResult } from './toolpath'

const DEBOUNCE_MS = 300
let worker: Worker | null = null
let latest = 0
let latestShapes: Shape[] = []
let latestProject = '' // a result for a project that's no longer open is dropped even if its id is still the latest

// Fonts only load on the main thread, so text is flattened to a compound shape before it goes to the worker.
const flattenText = (p: Project): Project => ({
  ...p,
  shapes: p.shapes.map((s) => (s.type === 'text' ? ({ ...s, type: 'compound', paths: localPolylines(s) } as Shape) : s)),
})

// Font problems are only known on the main thread; they are merged into the worker's warnings. A font that failed
// replaces the worker's "still loading" note for that shape.
let fontNotes = { add: [] as string[], drop: new Set<string>() }
function fontWarnings(p: Project) {
  const notes = { add: [] as string[], drop: new Set<string>() }
  for (const s of p.shapes) {
    if (s.type !== 'text' || !s.cut) continue
    if (fontFailed(s.font)) {
      notes.drop.add(`Font still loading for ${s.name}`)
      notes.add.push(`Font could not be loaded for ${s.name}`)
    }
    const missing = missingGlyphs(s.font, s.text)
    if (missing.length) notes.add.push(`${fontSource(s.font).label} has no glyph for ${missing.map((c) => `'${c}'`).join(' ')} in ${s.name}`)
  }
  return notes
}
const withFontNotes = (r: CamResult): CamResult => ({ ...r, warnings: [...r.warnings.filter((w) => !fontNotes.drop.has(w)), ...fontNotes.add] })

const failed = (error?: string): CamResult => ({ ops: [], warnings: [`Toolpath error: ${error}`], timeSec: { rough: 0, detail: 0 } })

function plan(project: Project) {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; result?: CamResult; error?: string }>) => {
      const { id, result, error } = e.data
      if (id === latest && latestProject === useAppStore.getState().project.id) useAppStore.setState({ cam: result ? { ...withFontNotes(result), shapes: latestShapes } : failed(error), camBusy: false })
    }
    worker.onerror = (e) => useAppStore.setState({ cam: failed(e.message || 'worker failed'), camBusy: false })
  }
  latestProject = project.id
  latestShapes = project.shapes
  fontNotes = fontWarnings(project)
  worker.postMessage({ id: ++latest, project: flattenText(project) })
}

// The planner ignores the project name and the custom G-code, so editing them doesn't replan (or re-simulate).
const planningChanged = (a: Project, b: Project) =>
  (Object.keys(a) as (keyof Project)[]).some((k) => k !== 'gcode' && k !== 'name' && a[k] !== b[k])

export function useCam() {
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    const schedule = (project: Project) => {
      useAppStore.setState({ camBusy: true })
      clearTimeout(t)
      t = setTimeout(() => plan(project), DEBOUNCE_MS)
    }
    schedule(useAppStore.getState().project)
    const unsubscribe = useAppStore.subscribe((s, prev) => {
      if (s.fontsVersion !== prev.fontsVersion || (s.project !== prev.project && planningChanged(s.project, prev.project))) schedule(s.project)
    })
    return () => {
      unsubscribe()
      clearTimeout(t)
    }
  }, [])
}
