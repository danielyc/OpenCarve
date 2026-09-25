import type { Op, Pt3 } from '../cam/toolpath'
import type { Bit, BitRole, Project } from '../model'
import type { Move, Settings } from './timeline'

export interface SimInput {
  id: number
  stock: Project['stock']
  ops: Op[]
  bits: Partial<Record<BitRole, Bit>>
  resolution?: number // cell size in mm; default keeps the grid under MAX_CELLS
  settings?: Settings // feeds, for the animation timeline
}

// Heights (≤ 0, Z down) sampled at grid nodes: node (i, j) is at model (i·cellSize, j·cellSize), index j·width + i.
export interface SimResult {
  id: number
  width: number
  height: number
  cellSize: number
  stock: Project['stock']
  heights: Float32Array
  mesh?: SurfaceMesh // added by the sim worker
  progress?: boolean // a progressive-removal snapshot rather than the finished job
}

// Render-ready surface (three.js coordinates, see mesh.ts), built off the main thread.
export interface SurfaceMesh {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  index: Uint32Array
}

const MAX_CELLS = 1.2e6

export const gridCellSize = (w: number, h: number) => Math.max(0.05, Math.ceil(Math.sqrt((w * h) / MAX_CELLS) * 20) / 20) // rounded up to 0.05 mm

// Tool cross-section (flat = radius cut at tip height): height of the cutting surface above the tip at horizontal distance d from the axis.
function profile(bit: Bit) {
  const r = bit.diameter / 2
  if (bit.type === 'ballnose') return { r, slope: 0, flat: 0, dz: (d: number) => r - Math.sqrt(Math.max(0, r * r - d * d)) }
  if (bit.type === 'vbit') {
    const slope = Math.tan((((bit.angle ?? 90) / 2) * Math.PI) / 180)
    const flat = (bit.flat ?? 0) / 2
    return { r, slope, flat, dz: (d: number) => Math.max(0, d - flat) / slope }
  }
  return { r, slope: 0, flat: r, dz: () => 0 }
}

// A heightmap that tools are stamped into one move at a time.
export function createSim({ stock, bits, resolution }: Omit<SimInput, 'id' | 'ops'>) {
  const cell = resolution ?? gridCellSize(stock.w, stock.h)
  const width = Math.ceil(stock.w / cell - 1e-9) + 1
  const height = Math.ceil(stock.h / cell - 1e-9) + 1
  const heights = new Float32Array(width * height)
  const tools = { rough: bits.rough && profile(bits.rough), detail: bits.detail && profile(bits.detail) }

  // Lowers every node within reach of the tool swept at height z along (x0, y0)→(x1, y1), using the exact distance
  // to the segment; a zero-length sweep is a single plunge. Only the V-bit's reach depends on z.
  const sweep = (tool: ReturnType<typeof profile>, x0: number, y0: number, x1: number, y1: number, z: number) => {
    const reach = tool.slope ? Math.min(tool.r, tool.flat - z * tool.slope) : tool.r
    const flat = tool.flat * tool.flat
    const dx = x1 - x0
    const dy = y1 - y0
    const len2 = dx * dx + dy * dy
    const i0 = Math.max(0, Math.ceil((Math.min(x0, x1) - reach) / cell))
    const i1 = Math.min(width - 1, Math.floor((Math.max(x0, x1) + reach) / cell))
    const j0 = Math.max(0, Math.ceil((Math.min(y0, y1) - reach) / cell))
    const j1 = Math.min(height - 1, Math.floor((Math.max(y0, y1) + reach) / cell))
    const reach2 = reach * reach + 1e-9
    for (let j = j0; j <= j1; j++) {
      const py = j * cell - y0
      for (let i = i0; i <= i1; i++) {
        const px = i * cell - x0
        const t = len2 ? Math.min(1, Math.max(0, (px * dx + py * dy) / len2)) : 0
        const ex = px - t * dx
        const ey = py - t * dy
        const d2 = ex * ex + ey * ey
        if (d2 > reach2) continue
        const v = d2 <= flat ? z : z + tool.dz(Math.sqrt(d2))
        const idx = j * width + i
        if (v < heights[idx]) heights[idx] = v
      }
    }
  }

  // Cuts along one feed move (not a rapid) from a to b with the role's bit.
  const move = (role: BitRole, [x0, y0, z0]: Pt3, [x1, y1, z1]: Pt3) => {
    const tool = tools[role]
    if (!tool || (z0 >= 0 && z1 >= 0)) return
    const len = Math.hypot(x1 - x0, y1 - y0)
    if (z0 === z1) {
      // Long sweeps are chunked so their bounding boxes stay close to the swept area.
      const n = Math.ceil(len / Math.max(4 * tool.r, 8 * cell)) || 1
      for (let s = 0; s < n; s++) {
        const [a, b] = [s / n, (s + 1) / n]
        sweep(tool, x0 + (x1 - x0) * a, y0 + (y1 - y0) * a, x0 + (x1 - x0) * b, y0 + (y1 - y0) * b, z0)
      }
      return
    }
    // Plunges and ramps: stamp the tool every half cell along the move.
    const n = Math.max(1, Math.ceil(len / (cell / 2)))
    for (let s = 0; s <= n; s++) {
      const t = s / n
      const z = z0 + (z1 - z0) * t
      if (z < 0) sweep(tool, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z)
    }
  }

  // A snapshot, clamped to the stock bottom.
  const result = (id: number): SimResult => {
    const out = heights.slice()
    const floor = -stock.thickness
    for (let i = 0; i < out.length; i++) if (out[i] < floor) out[i] = floor
    return { id, width, height, cellSize: cell, stock, heights: out }
  }
  return { move, result }
}

export function simulate(input: SimInput): SimResult {
  const sim = createSim(input)
  // Like G-code, each point is a move from the previous one, across segment and op boundaries.
  let pos: Pt3 | null = null
  for (const op of input.ops)
    for (const seg of op.segments)
      for (const p of seg.points) {
        if (!seg.rapid) sim.move(op.role, pos ?? p, p)
        pos = p
      }
  return sim.result(input.id)
}

export interface UpTo {
  move: number // timeline moves before this one are done…
  frac: number // …and this fraction of it
}
export interface Progress {
  sim: ReturnType<typeof createSim>
  done: UpTo
}

// Progressive material removal: stamps only the timeline moves between the last call and upTo. Going backwards
// starts over from untouched stock.
export function progress(input: Omit<SimInput, 'id' | 'ops'>, moves: Move[], state: Progress | null, upTo: UpTo): Progress {
  const back = state && (upTo.move < state.done.move || (upTo.move === state.done.move && upTo.frac < state.done.frac))
  if (!state || back) state = { sim: createSim(input), done: { move: 0, frac: 0 } }
  const { sim, done } = state
  const end = Math.min(upTo.move, moves.length)
  for (let i = done.move; i < end; i++) if (moves[i].cut) sim.move(moves[i].role, moves[i].a, moves[i].b)
  const m = moves[end]
  if (m?.cut && upTo.frac > 0) sim.move(m.role, m.a, m.a.map((a, k) => a + (m.b[k] - a) * Math.min(1, upTo.frac)) as Pt3)
  state.done = { move: end, frac: m ? upTo.frac : 0 }
  return state
}
