import { findBit, findMaterial } from '../lib/library'
import type { BitRole, CutSettings, Project } from '../model'
import type { CamResult, Op, Pt3, Segment } from './toolpath'

const RAPID_FEED = 2500 // mm/min, for the time estimate
const fmt = (n: number) => String(+n.toFixed(3))

function walk(ops: Op[], start: Pt3, fn: (seg: Segment, from: Pt3, to: Pt3) => void) {
  let pos = start
  for (const op of ops) for (const seg of op.segments) for (const p of seg.points) {
    fn(seg, pos, p)
    pos = p
  }
}

// Z-only moves down (plunges, stepping off a tab) use the plunge feed.
const feedFor = (seg: Segment, a: Pt3, b: Pt3, s: CutSettings) =>
  seg.rapid ? RAPID_FEED : seg.plunge || (a[0] === b[0] && a[1] === b[1] && b[2] < a[2]) ? s.plunge : s.feed

export function opsTime(ops: Op[], s: CutSettings): number {
  let sec = 0
  walk(ops, [0, 0, s.safeZ], (seg, a, b) => {
    sec += (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / feedFor(seg, a, b, s)) * 60
  })
  return sec
}

export function toGcode(result: CamResult, role: BitRole, project: Project): string {
  const s = project.cutSettings[role]!
  const oneLine = (t: string) => t.replace(/[\r\n]+/g, ' ')
  const lines = [
    '; OpenCarve',
    `; Project: ${oneLine(project.name)}`,
    `; Bit: ${findBit(project.bits[role]!).name}`,
    `; Material: ${findMaterial(project.materialId).name}`,
    '; Units: mm',
    'G21 G90 G17',
    `G0 Z${fmt(s.safeZ)}`,
    `M3 S${s.rpm}`,
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
