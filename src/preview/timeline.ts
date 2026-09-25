import { moveTime, SPINUP_SEC } from '../cam/gcode'
import type { Op, Pt3 } from '../cam/toolpath'
import type { BitRole, CutSettings } from '../model'

export interface Move {
  a: Pt3
  b: Pt3
  t0: number // seconds from the start of the job
  t1: number
  op: number // index into the ops passed to buildTimeline
  role: BitRole
  cut: boolean // false for rapids and the spin-up dwell
}

export interface Timeline {
  moves: Move[]
  total: number
}

export type Settings = Partial<Record<BitRole, CutSettings>>

// Every move in G-code order (the rough file, then the detail file), timed like gcode.ts: each file starts at
// (0, 0, safe Z) with the spin-up dwell, which counts as a zero-length move.
export function buildTimeline(ops: Op[], settings: Settings): Timeline {
  const moves: Move[] = []
  let t = 0
  const push = (a: Pt3, b: Pt3, sec: number, op: number, role: BitRole, cut: boolean) => {
    moves.push({ a, b, t0: t, t1: t + sec, op, role, cut })
    t += sec
  }
  for (const role of ['rough', 'detail'] as const) {
    const s = settings[role]
    const mine = ops.flatMap((o, i) => (o.role === role ? [i] : []))
    if (!s || !mine.length) continue
    let pos: Pt3 = [0, 0, s.safeZ]
    push(pos, pos, SPINUP_SEC, mine[0], role, false)
    for (const i of mine)
      for (const seg of ops[i].segments)
        for (const p of seg.points) {
          push(pos, p, moveTime(seg, pos, p, s), i, role, !seg.rapid)
          pos = p
        }
  }
  return { moves, total: t }
}

// Index of the move running at time t: the last one starting at or before t (clamped to the timeline).
export function moveAt({ moves }: Timeline, t: number): number {
  let lo = 0
  let hi = moves.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (moves[mid].t0 <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

// Fraction of move i done at time t, 0..1.
export function fracAt(m: Move, t: number) {
  const d = m.t1 - m.t0
  return d > 0 ? Math.min(1, Math.max(0, (t - m.t0) / d)) : 1
}

// Tool tip at time t, written into out (no allocation, for the animation loop).
export function positionAt(tl: Timeline, t: number, out: Pt3 = [0, 0, 0]): Pt3 {
  const m = tl.moves[moveAt(tl, t)]
  if (!m) return out
  const f = fracAt(m, t)
  for (let k = 0; k < 3; k++) out[k] = m.a[k] + (m.b[k] - m.a[k]) * f
  return out
}

// One timeline per (ops, settings) pair, shared by the preview and the playback bar.
let cache: { ops: Op[]; settings: Settings; tl: Timeline } | null = null
export function timelineFor(ops: Op[], settings: Settings): Timeline {
  if (cache?.ops !== ops || cache.settings !== settings) cache = { ops, settings, tl: buildTimeline(ops, settings) }
  return cache.tl
}
