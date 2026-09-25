import { surfaceMesh } from './mesh'
import { progress, simulate, type Progress, type SimInput, type SimResult, type UpTo } from './sim'
import { buildTimeline, type Move } from './timeline'

export type ProgressRequest = { id: number; kind: 'progress'; upTo: UpTo }

// Progress requests stamp into the timeline of the last full simulation.
let base: SimInput | null = null
let moves: Move[] = []
let state: Progress | null = null

function post(result: SimResult) {
  const mesh = surfaceMesh(result)
  const transfer = [result.heights, mesh.positions, mesh.normals, mesh.colors, mesh.index].map((a) => a.buffer)
  self.postMessage({ ...result, mesh }, { transfer })
}

self.onmessage = (e: MessageEvent<SimInput | ProgressRequest>) => {
  const d = e.data
  if ('kind' in d) {
    if (!base) return
    state = progress(base, moves, state, d.upTo)
    return post({ ...state.sim.result(d.id), progress: true })
  }
  base = d
  moves = buildTimeline(d.ops, d.settings ?? {}).moves
  state = null
  post(simulate(d))
}
