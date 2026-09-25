import { create } from 'zustand'
import { polylineBounds, shapeBounds, shapeToPolylines } from './lib/geometry'
import type { Units } from './lib/units'
import { newId, newProject, type Project, type Shape, type ShapePatch } from './model'

export type Step = 'design' | 'simulate' | 'export'
export type Tool = 'select' | 'rect' | 'ellipse' | 'polygon' | 'pen'
export type Align = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'
export interface View {
  zoom: number
  panX: number
  panY: number
}

const MAX_HISTORY = 100
const FIT_MARGIN = 40

interface AppState {
  step: Step
  project: Project
  selection: string[]
  tool: Tool
  view: View
  past: Project[]
  future: Project[]
  transientBase: Project | null
  setStep: (step: Step) => void
  addShape: (shape: Shape) => void
  updateShapes: (ids: string[], patch: ShapePatch | ((s: Shape) => Shape)) => void
  deleteSelected: () => void
  duplicateSelected: () => void
  setSelection: (ids: string[]) => void
  setTool: (tool: Tool) => void
  align: (mode: Align) => void
  nudge: (dx: number, dy: number) => void
  undo: () => void
  redo: () => void
  setMaterial: (patch: Partial<Project['material']>) => void
  setUnits: (units: Units) => void
  setView: (patch: Partial<View>) => void
  fitView: (width: number, height: number) => void
  beginTransient: () => void
  commit: () => void
}

const pushHistory = (past: Project[], project: Project) => [...past, project].slice(-MAX_HISTORY)

const existing = (ids: string[], project: Project) => ids.filter((id) => project.shapes.some((s) => s.id === id))

export const useAppStore = create<AppState>()((set, get) => {
  // During a transient gesture, edits replace the project without recording history; commit() records one entry.
  const setProject = (fn: (p: Project) => Project) =>
    set((s) => {
      const project = fn(s.project)
      if (s.transientBase) return { project }
      return { project, past: pushHistory(s.past, s.project), future: [] }
    })

  const selected = () => {
    const { project, selection } = get()
    return project.shapes.filter((s) => selection.includes(s.id))
  }

  return {
    step: 'design',
    project: newProject(),
    selection: [],
    tool: 'select',
    view: { zoom: 2, panX: 0, panY: 0 },
    past: [],
    future: [],
    transientBase: null,
    setStep: (step) => set({ step }),

    addShape: (shape) => {
      setProject((p) => ({ ...p, shapes: [...p.shapes, shape] }))
      set({ selection: [shape.id] })
    },

    updateShapes: (ids, patch) =>
      setProject((p) => ({
        ...p,
        shapes: p.shapes.map((s) =>
          ids.includes(s.id) ? (typeof patch === 'function' ? patch(s) : ({ ...s, ...patch } as Shape)) : s,
        ),
      })),

    deleteSelected: () => {
      const { selection } = get()
      if (!selection.length) return
      setProject((p) => ({ ...p, shapes: p.shapes.filter((s) => !selection.includes(s.id)) }))
      set({ selection: [] })
    },

    duplicateSelected: () => {
      const copies = selected().map((s) => ({ ...s, id: newId(), x: s.x + 5, y: s.y + 5 }))
      if (!copies.length) return
      setProject((p) => ({ ...p, shapes: [...p.shapes, ...copies] }))
      set({ selection: copies.map((s) => s.id) })
    },

    setSelection: (selection) => set({ selection }),
    setTool: (tool) => set({ tool }),

    align: (mode) => {
      const shapes = selected()
      if (!shapes.length) return
      const { w, h } = get().project.material
      const ref =
        shapes.length > 1
          ? polylineBounds(shapes.flatMap(shapeToPolylines))
          : { minX: 0, minY: 0, maxX: w, maxY: h }
      get().updateShapes(
        shapes.map((s) => s.id),
        (s) => {
          const b = shapeBounds(s)
          const dx = { left: ref.minX - b.minX, right: ref.maxX - b.maxX, centerX: (ref.minX + ref.maxX - b.minX - b.maxX) / 2 }
          const dy = { bottom: ref.minY - b.minY, top: ref.maxY - b.maxY, centerY: (ref.minY + ref.maxY - b.minY - b.maxY) / 2 }
          return mode in dx
            ? { ...s, x: s.x + dx[mode as keyof typeof dx] }
            : { ...s, y: s.y + dy[mode as keyof typeof dy] }
        },
      )
    },

    nudge: (dx, dy) => {
      const { selection } = get()
      if (selection.length) get().updateShapes(selection, (s) => ({ ...s, x: s.x + dx, y: s.y + dy }))
    },

    undo: () =>
      set((s) => {
        const project = s.past.at(-1)
        if (!project) return {}
        return {
          project,
          past: s.past.slice(0, -1),
          future: [s.project, ...s.future],
          selection: existing(s.selection, project),
          transientBase: null,
        }
      }),

    redo: () =>
      set((s) => {
        const [project, ...future] = s.future
        if (!project) return {}
        return {
          project,
          past: pushHistory(s.past, s.project),
          future,
          selection: existing(s.selection, project),
          transientBase: null,
        }
      }),

    setMaterial: (patch) => setProject((p) => ({ ...p, material: { ...p.material, ...patch } })),
    setUnits: (units) => setProject((p) => ({ ...p, units })),
    setView: (patch) => set((s) => ({ view: { ...s.view, ...patch } })),

    fitView: (width, height) => {
      const { w, h } = get().project.material
      const zoom = Math.max(0.05, Math.min((width - 2 * FIT_MARGIN) / w, (height - 2 * FIT_MARGIN) / h))
      set({ view: { zoom, panX: (width - w * zoom) / 2, panY: (height + h * zoom) / 2 } })
    },

    beginTransient: () => set((s) => ({ transientBase: s.project })),
    commit: () =>
      set((s) => {
        const base = s.transientBase
        if (!base || base === s.project) return { transientBase: null }
        return { past: pushHistory(s.past, base), future: [], transientBase: null }
      }),
  }
})
