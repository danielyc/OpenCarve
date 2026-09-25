import { surfaceIndex, surfaceMesh, surfaceRows } from './mesh'
import { progress, simulate, type Progress, type SimInput, type UpTo } from './sim'
import { buildTimeline, type Move } from './timeline'

export type ProgressRequest = { id: number; kind: 'progress'; upTo: UpTo; full: boolean }

// Progressive removal replies with only the grid rows that changed since the last reply (none when nothing did), to be
// written in place into one persistent geometry. The first reply for a job, or one asked for with `full`, carries every
// row plus an index; that index keeps through-cut cells (holes show only on the finished surface).
export interface ProgressUpdate {
  id: number
  progress: true
  width: number
  r0: number // first row in the arrays
  positions?: Float32Array
  normals?: Float32Array
  colors?: Float32Array
  index?: Uint32Array
}

let base: SimInput | null = null
let moves: Move[] = []
let state: Progress | null = null

self.onmessage = (e: MessageEvent<SimInput | ProgressRequest>) => {
  const d = e.data
  if ('kind' in d) {
    if (!base) return
    const fresh = !state
    state = progress(base, moves, state, d.upTo)
    const { grid } = state.sim
    const dirty = state.sim.takeDirty()
    const full = fresh || d.full
    const reply: ProgressUpdate = { id: d.id, progress: true, width: grid.width, r0: 0 }
    if (!full && dirty.lo > dirty.hi) return self.postMessage(reply)
    // Normals look at neighbouring rows, so one row either side changes too.
    const [r0, r1] = full ? [0, grid.height - 1] : [Math.max(0, dirty.lo - 1), Math.min(grid.height - 1, dirty.hi + 1)]
    Object.assign(reply, { r0, ...surfaceRows(grid, r0, r1), ...(full && { index: surfaceIndex(grid, false) }) })
    const transfer = [reply.positions!, reply.normals!, reply.colors!, ...(reply.index ? [reply.index] : [])].map((a) => a.buffer)
    return self.postMessage(reply, { transfer })
  }
  base = d
  moves = buildTimeline(d.ops, d.settings ?? {}).moves
  state = null
  const result = simulate(d)
  const mesh = surfaceMesh(result)
  const transfer = [result.heights, mesh.positions, mesh.normals, mesh.colors, mesh.index].map((a) => a.buffer)
  self.postMessage({ ...result, mesh }, { transfer })
}
