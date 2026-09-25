import type { Point, Polyline } from '../model'

const SEGMENTS = 12

export type PathCommand =
  | { type: 'M' | 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Z' }

export const flattenQuad = (a: Point, b: Point, c: Point, n = SEGMENTS) =>
  Array.from({ length: n }, (_, i): Point => {
    const t = (i + 1) / n
    const u = 1 - t
    return [u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], u * u * a[1] + 2 * u * t * b[1] + t * t * c[1]]
  })

export const flattenCubic = (a: Point, b: Point, c: Point, d: Point, n = SEGMENTS) =>
  Array.from({ length: n }, (_, i): Point => {
    const t = (i + 1) / n
    const u = 1 - t
    const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
    return [k[0] * a[0] + k[1] * b[0] + k[2] * c[0] + k[3] * d[0], k[0] * a[1] + k[1] * b[1] + k[2] * c[1] + k[3] * d[1]]
  })

const same = (a: Point, b: Point) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9

export function commandsToPolylines(cmds: PathCommand[]): Polyline[] {
  const out: Polyline[] = []
  let cur: Point[] = []
  const end = (closed: boolean) => {
    if (closed && cur.length > 1 && same(cur[0], cur.at(-1)!)) cur.pop()
    if (cur.length > 1) out.push({ points: cur, closed })
    cur = []
  }
  for (const c of cmds) {
    const last = cur.at(-1) ?? [0, 0]
    if (c.type === 'M') {
      end(false)
      cur = [[c.x, c.y]]
    } else if (c.type === 'L') cur.push([c.x, c.y])
    else if (c.type === 'Q') cur.push(...flattenQuad(last, [c.x1, c.y1], [c.x, c.y]))
    else if (c.type === 'C') cur.push(...flattenCubic(last, [c.x1, c.y1], [c.x2, c.y2], [c.x, c.y]))
    else {
      const start = cur[0]
      end(true)
      if (start) cur = [start]
    }
  }
  end(false)
  return out
}
