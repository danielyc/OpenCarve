import { create } from 'zustand'
import type { CamResult } from './cam/toolpath'
import { onFontLoad } from './lib/fonts'
import { polylineBounds, shapeBounds, shapeToPolylines } from './lib/geometry'
import { findBit, findMaterial, recommendedSettings } from './lib/library'
import type { Units } from './lib/units'
import type { SimResult } from './preview/sim'
import { defaultCut, newId, newProject, validCut, type BitRole, type Cut, type CutSettings, type Project, type Shape, type ShapePatch } from './model'

export type Step = 'design' | 'simulate' | 'export'
export type Screen = 'home' | 'editor'
export type Tool = 'select' | 'rect' | 'ellipse' | 'polygon' | 'pen' | 'text'
export type Align = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'
export interface View {
  zoom: number
  panX: number
  panY: number
}

const MAX_HISTORY = 100
const FIT_MARGIN = 40

interface AppState {
  screen: Screen
  saveState: 'saved' | 'saving' | 'failed'
  step: Step
  project: Project
  selection: string[]
  tool: Tool
  view: View
  past: Project[]
  future: Project[]
  transientBase: Project | null
  fontsVersion: number
  status: string | null
  cam: CamResult | null
  camBusy: boolean
  sim: SimResult | null
  simBusy: boolean
  highlightOp: string | null // opKey of the op picked in the Simulate panel
  setStep: (step: Step) => void
  setScreen: (screen: Screen) => void
  newProject: () => void
  loadProject: (project: Project) => void
  setProjectName: (name: string) => void
  addShape: (shape: Shape) => void
  addShapes: (shapes: Shape[]) => void
  updateShapes: (ids: string[], patch: ShapePatch | ((s: Shape) => Shape)) => void
  deleteSelected: () => void
  duplicateSelected: () => void
  setSelection: (ids: string[]) => void
  setTool: (tool: Tool) => void
  align: (mode: Align) => void
  nudge: (dx: number, dy: number) => void
  undo: () => void
  redo: () => void
  setStock: (patch: Partial<Project['stock']>) => void
  setMaterialId: (id: string) => void
  setBits: (bits: Project['bits']) => void
  setCutSettings: (role: BitRole, patch: Partial<CutSettings>) => void
  resetCutSettings: (role: BitRole) => void
  setMachine: (machine: Project['machine']) => void
  setCut: (ids: string[], patch: Partial<Cut> | null) => void
  setUnits: (units: Units) => void
  setView: (patch: Partial<View>) => void
  fitView: (width: number, height: number) => void
  beginTransient: () => void
  commit: () => void
  cancelTransient: () => void
}

const pushHistory = (past: Project[], project: Project) => [...past, project].slice(-MAX_HISTORY)

const existing = (ids: string[], project: Project) => ids.filter((id) => project.shapes.some((s) => s.id === id))

// Recomputes each bit's settings unless the user customised them; detail settings exist only with a detail bit.
function recommended(p: Project): Project {
  const rec = (role: BitRole, id: string) =>
    (p.cutSettingsCustom[role] && p.cutSettings[role]) || recommendedSettings(findMaterial(p.materialId), findBit(id), p.machine.maxRpm)
  const { detail } = p.bits
  return {
    ...p,
    cutSettings: { rough: rec('rough', p.bits.rough), ...(detail && { detail: rec('detail', detail) }) },
    cutSettingsCustom: detail ? p.cutSettingsCustom : { ...p.cutSettingsCustom, detail: false },
  }
}

export const useAppStore = create<AppState>()((set, get) => {
  // During a transient gesture, edits replace the project without recording history; commit() records one entry.
  const setProject = (fn: (p: Project) => Project) =>
    set((s) => {
      const project = fn(s.project)
      if (s.transientBase) return { project }
      if (JSON.stringify(project) === JSON.stringify(s.project)) return {}
      return { project, past: pushHistory(s.past, s.project), future: [] }
    })

  const selected = () => {
    const { project, selection } = get()
    return project.shapes.filter((s) => selection.includes(s.id))
  }

  return {
    screen: 'home',
    saveState: 'saved',
    step: 'design',
    project: newProject(),
    selection: [],
    tool: 'select',
    view: { zoom: 2, panX: 0, panY: 0 },
    past: [],
    future: [],
    transientBase: null,
    fontsVersion: 0,
    status: null,
    cam: null,
    camBusy: false,
    sim: null,
    simBusy: false,
    highlightOp: null,
    setStep: (step) => set({ step }),
    setScreen: (screen) => set({ screen }),
    newProject: () => get().loadProject(newProject()),
    // Opens a project in the editor with fresh history and editor state (the editor remounts per project id, refitting the view).
    loadProject: (project) =>
      set({ project, screen: 'editor', step: 'design', tool: 'select', selection: [], past: [], future: [], transientBase: null, cam: null, sim: null }),
    setProjectName: (name) => setProject((p) => ({ ...p, name })),

    addShape: (shape) => get().addShapes([shape]),
    addShapes: (shapes) => {
      setProject((p) => {
        const t = p.stock.thickness
        return { ...p, shapes: [...p.shapes, ...shapes.map((s) => (s.cut ? s : { ...s, cut: validCut(s, defaultCut(t), t) }))] }
      })
      set({ selection: shapes.map((s) => s.id) })
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
      const { w, h } = get().project.stock
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

    // Units are a display preference: kept out of history and preserved across undo/redo.
    undo: () =>
      set((s) => {
        const prev = s.past.at(-1)
        if (!prev) return {}
        const project = { ...prev, units: s.project.units }
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
        const [next, ...future] = s.future
        if (!next) return {}
        const project = { ...next, units: s.project.units }
        return {
          project,
          past: pushHistory(s.past, s.project),
          future,
          selection: existing(s.selection, project),
          transientBase: null,
        }
      }),

    // Through cuts stay through when the stock gets thicker; deeper cuts are clamped when it gets thinner.
    setStock: (patch) =>
      setProject((p) => {
        const stock = { ...p.stock, ...patch }
        const t = stock.thickness
        const shapes = p.shapes.map((s) =>
          s.cut ? { ...s, cut: validCut(s, { ...s.cut, depth: s.cut.depth >= p.stock.thickness ? t : s.cut.depth }, t) } : s,
        )
        return { ...p, stock, shapes }
      }),
    setMaterialId: (materialId) => setProject((p) => recommended({ ...p, materialId })),
    setBits: (bits) =>
      setProject((p) =>
        recommended({
          ...p,
          bits,
          cutSettingsCustom: {
            rough: p.cutSettingsCustom.rough && bits.rough === p.bits.rough,
            detail: p.cutSettingsCustom.detail && bits.detail === p.bits.detail,
          },
        }),
      ),
    setCutSettings: (role, patch) =>
      setProject((p) =>
        p.cutSettings[role]
          ? { ...p, cutSettings: { ...p.cutSettings, [role]: { ...p.cutSettings[role], ...patch } }, cutSettingsCustom: { ...p.cutSettingsCustom, [role]: true } }
          : p,
      ),
    resetCutSettings: (role) => setProject((p) => recommended({ ...p, cutSettingsCustom: { ...p.cutSettingsCustom, [role]: false } })),
    setMachine: (machine) => setProject((p) => recommended({ ...p, machine })),
    setCut: (ids, patch) =>
      setProject((p) => {
        const t = p.stock.thickness
        return {
          ...p,
          shapes: p.shapes.map((s) =>
            !ids.includes(s.id) ? s : { ...s, cut: patch ? validCut(s, { ...(s.cut ?? defaultCut(t)), ...patch }, t) : undefined },
          ),
        }
      }),
    setUnits: (units) => set((s) => ({ project: { ...s.project, units } })),
    setView: (patch) => set((s) => ({ view: { ...s.view, ...patch } })),

    fitView: (width, height) => {
      const { w, h } = get().project.stock
      const zoom = Math.max(0.05, Math.min((width - 2 * FIT_MARGIN) / w, (height - 2 * FIT_MARGIN) / h))
      set({ view: { zoom, panX: (width - w * zoom) / 2, panY: (height + h * zoom) / 2 } })
    },

    beginTransient: () => set((s) => ({ transientBase: s.project })),
    commit: () =>
      set((s) => {
        const base = s.transientBase
        if (!base || JSON.stringify(base) === JSON.stringify(s.project)) return { transientBase: null }
        return { past: pushHistory(s.past, base), future: [], transientBase: null }
      }),
    cancelTransient: () =>
      set((s) => (s.transientBase ? { project: s.transientBase, transientBase: null } : {})),
  }
})

onFontLoad((error) => useAppStore.setState((s) => ({ fontsVersion: s.fontsVersion + 1, status: error ?? null })))
