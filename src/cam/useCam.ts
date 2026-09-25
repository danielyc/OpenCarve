import { useEffect } from 'react'
import { localPolylines } from '../lib/geometry'
import type { Project, Shape } from '../model'
import { useAppStore } from '../store'
import type { CamResult } from './toolpath'

const DEBOUNCE_MS = 300
let worker: Worker | null = null
let latest = 0

// Fonts only load on the main thread, so text is flattened to a compound shape before it goes to the worker.
const flattenText = (p: Project): Project => ({
  ...p,
  shapes: p.shapes.map((s) => (s.type === 'text' ? ({ ...s, type: 'compound', paths: localPolylines(s) } as Shape) : s)),
})

function plan(project: Project) {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; result?: CamResult; error?: string }>) => {
      const { id, result, error } = e.data
      if (id !== latest) return
      const cam = result ?? { ops: [], warnings: [`Toolpath error: ${error}`], timeSec: { rough: 0, detail: 0 }, version: id }
      useAppStore.setState({ cam, camBusy: false })
    }
  }
  worker.postMessage({ id: ++latest, project: flattenText(project) })
}

export function useCam() {
  const project = useAppStore((s) => s.project)
  const fontsVersion = useAppStore((s) => s.fontsVersion)
  useEffect(() => {
    useAppStore.setState({ camBusy: true })
    const t = setTimeout(() => plan(project), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [project, fontsVersion])
}
