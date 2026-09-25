import { effectiveBit, findMaterial } from '../lib/library'
import type { BitRole, CutSettings, Project } from '../model'
import type { CamResult, Op, Pt3, Segment } from './toolpath'

const RAPID_FEED = 2500 // mm/min, for the time estimate
export const SPINUP_SEC = 3
const fmt = (n: number) => String(+n.toFixed(3))

function walk(ops: Op[], start: Pt3, fn: (seg: Segment, from: Pt3, to: Pt3, op: number) => void) {
  let pos = start
  ops.forEach((op, i) => {
    for (const seg of op.segments) for (const p of seg.points) {
      fn(seg, pos, p, i)
      pos = p
    }
  })
}

// Z-only moves down (plunges, stepping off a tab) use the plunge feed.
const feedFor = (seg: Segment, a: Pt3, b: Pt3, s: CutSettings) =>
  seg.rapid ? RAPID_FEED : seg.plunge || (a[0] === b[0] && a[1] === b[1] && b[2] < a[2]) ? s.plunge : s.feed

// Seconds for one move, as the G-code runs it.
export const moveTime = (seg: Segment, a: Pt3, b: Pt3, s: CutSettings) =>
  (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / feedFor(seg, a, b, s)) * 60

// Seconds per op, run in this order; the spin-up and the move to each op's start count towards that op.
export function opTimes(ops: Op[], s: CutSettings): number[] {
  const sec = ops.map((_, i) => (i ? 0 : SPINUP_SEC))
  walk(ops, [0, 0, s.safeZ], (seg, a, b, i) => {
    sec[i] += moveTime(seg, a, b, s)
  })
  return sec
}

export function toGcode(result: CamResult, role: BitRole, project: Project): string {
  const s = project.cutSettings[role]!
  const comment = (t: string) => `; ${t.replace(/[^ -~]+/g, ' ')}`
  const lines = [
    comment('OpenCarve'),
    comment(`Project: ${project.name}`),
    comment(`Bit: ${effectiveBit(project, role).name}`),
    comment(`Material: ${findMaterial(project.materialId).name}`),
    comment('Units: mm'),
    'G21 G90 G17 G94',
    `G0 Z${fmt(s.safeZ)}`,
    `M3 S${s.rpm}`,
    `G4 P${SPINUP_SEC}`,
  ]
  let feed = 0
  let z = s.safeZ
  walk(
    result.ops.filter((o) => o.role === role),
    [NaN, NaN, s.safeZ],
    (seg, a, b) => {
      z = b[2]
      const words = ['X', 'Y', 'Z'].flatMap((axis, i) => (fmt(a[i]) === fmt(b[i]) ? [] : [axis + fmt(b[i])]))
      if (!words.length) return
      if (seg.rapid) return void lines.push(`G0 ${words.join(' ')}`)
      const f = feedFor(seg, a, b, s)
      if (f !== feed) words.push(`F${f}`)
      feed = f
      lines.push(`G1 ${words.join(' ')}`)
    },
  )
  if (z !== s.safeZ) lines.push(`G0 Z${fmt(s.safeZ)}`)
  lines.push('M5', 'M2', '')
  return lines.join('\n')
}
