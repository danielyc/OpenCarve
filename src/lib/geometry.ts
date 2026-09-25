import type { Point, Polyline, Shape, ShapeBase, TextShape } from '../model'
import { textGlyphs } from './fonts'
import type { Units } from './units'

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number }
type Placement = Pick<ShapeBase, 'x' | 'y' | 'rotation'>

const TOLERANCE = 0.02 // mm
const rad = (deg: number) => (deg * Math.PI) / 180

export function toWorld({ x, y, rotation }: Placement, [px, py]: Point): Point {
  const c = Math.cos(rad(rotation))
  const s = Math.sin(rad(rotation))
  return [x + px * c - py * s, y + px * s + py * c]
}

export function toLocal({ x, y, rotation }: Placement, [px, py]: Point): Point {
  const c = Math.cos(rad(rotation))
  const s = Math.sin(rad(rotation))
  const dx = px - x
  const dy = py - y
  return [dx * c + dy * s, -dx * s + dy * c]
}

export function polylineBounds(polys: Polyline[]): Bounds {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const { points } of polys) {
    for (const [x, y] of points) {
      b.minX = Math.min(b.minX, x)
      b.minY = Math.min(b.minY, y)
      b.maxX = Math.max(b.maxX, x)
      b.maxY = Math.max(b.maxY, y)
    }
  }
  return b
}

export function localPolylines(shape: Shape): Polyline[] {
  switch (shape.type) {
    case 'rect': {
      const x = shape.w / 2
      const y = shape.h / 2
      return [{ closed: true, points: [[-x, -y], [x, -y], [x, y], [-x, y]] }]
    }
    case 'ellipse': {
      const n = Math.max(8, Math.ceil(Math.PI / Math.acos(1 - TOLERANCE / Math.max(shape.w / 2, shape.h / 2))) || 8)
      return [
        {
          closed: true,
          points: Array.from({ length: n }, (_, i) => {
            const a = (i / n) * 2 * Math.PI
            return [(Math.cos(a) * shape.w) / 2, (Math.sin(a) * shape.h) / 2]
          }),
        },
      ]
    }
    case 'polygon': {
      const unit = Array.from({ length: shape.sides }, (_, i): Point => {
        const a = Math.PI / 2 + (i / shape.sides) * 2 * Math.PI
        return [Math.cos(a), Math.sin(a)]
      })
      const b = polylineBounds([{ points: unit, closed: true }])
      const sx = shape.w / (b.maxX - b.minX)
      const sy = shape.h / (b.maxY - b.minY)
      const cx = (b.minX + b.maxX) / 2
      const cy = (b.minY + b.maxY) / 2
      return [{ closed: true, points: unit.map(([x, y]) => [(x - cx) * sx, (y - cy) * sy]) }]
    }
    case 'path':
      return [{ closed: shape.closed, points: shape.points }]
    case 'compound':
      return shape.paths
    case 'text': {
      const polys = textGlyphs(shape) ?? []
      const b = polylineBounds(polys)
      const cx = (b.minX + b.maxX) / 2
      const cy = (b.minY + b.maxY) / 2
      return polys.map(({ closed, points }) => ({ closed, points: points.map(([x, y]) => [x - cx, y - cy]) }))
    }
  }
}

export const shapeToPolylines = (shape: Shape): Polyline[] =>
  localPolylines(shape).map(({ points, closed }) => ({ closed, points: points.map((p) => toWorld(shape, p)) }))

// A text shape whose font hasn't loaded yet has no polylines; its stored w × h box stands in.
export function shapeBounds(shape: Shape) {
  const polys = shapeToPolylines(shape)
  return polylineBounds(polys.length || shape.type !== 'text' ? polys : shapeToPolylines({ ...shape, type: 'rect' }))
}

export const localBounds = (shape: Shape): Bounds =>
  shape.type === 'text'
    ? { minX: -shape.w / 2, minY: -shape.h / 2, maxX: shape.w / 2, maxY: shape.h / 2 }
    : polylineBounds(localPolylines(shape))

// Call only once the font is loaded (see loadFont).
export function fitText(shape: TextShape): TextShape {
  const b = polylineBounds(localPolylines(shape))
  return b.minX > b.maxX ? { ...shape, w: 0, h: 0 } : { ...shape, w: b.maxX - b.minX, h: b.maxY - b.minY }
}

// Letter spacing scales with the size; the clamp absorbs rounding so it never drops below -size/2 (the loader's limit).
export const textAtSize = (t: TextShape, size: number): TextShape => ({ ...t, size, letterSpacing: Math.max(-size / 2, (t.letterSpacing * size) / t.size) })

export const dominantScale = (sx: number, sy: number) =>
  Math.abs(Math.log(Math.abs(sx))) >= Math.abs(Math.log(Math.abs(sy))) ? Math.abs(sx) : Math.abs(sy)

export function scaleShape(shape: Shape, sx: number, sy: number): Shape {
  const scale = (points: Point[]) => points.map(([x, y]): Point => [x * sx, y * sy])
  switch (shape.type) {
    case 'path':
      return { ...shape, points: scale(shape.points) }
    case 'compound':
      return { ...shape, paths: shape.paths.map((p) => ({ ...p, points: scale(p.points) })) }
    case 'text': {
      const f = dominantScale(sx, sy)
      return { ...textAtSize(shape, shape.size * f), w: shape.w * f, h: shape.h * f }
    }
    default:
      return { ...shape, w: shape.w * Math.abs(sx), h: shape.h * Math.abs(sy) }
  }
}

// Grid lines every `step` mm strictly inside a w × h stock, limited to the visible area plus one step, so the
// line count is bounded by the viewport rather than the stock.
export function gridPath(w: number, h: number, step: number, area: Bounds) {
  const d: string[] = []
  const [x0, x1] = [Math.max(0, area.minX - step), Math.min(w, area.maxX + step)]
  const [y0, y1] = [Math.max(0, area.minY - step), Math.min(h, area.maxY + step)]
  if (x0 >= x1 || y0 >= y1) return ''
  for (let i = Math.max(1, Math.ceil(x0 / step)); i * step <= x1 && i * step < w; i++) d.push(`M${i * step} ${y0}V${y1}`)
  for (let i = Math.max(1, Math.ceil(y0 / step)); i * step <= y1 && i * step < h; i++) d.push(`M${x0} ${i * step}H${x1}`)
  return d.join('')
}

const GRID_SERIES: Record<Units, number[]> = {
  mm: [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500],
  in: [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 5, 10].map((v) => v * 25.4),
}
const isMultiple = (v: number, of: number) => Math.abs(v / of - Math.round(v / of)) < 1e-9

export const gridLabel = (mm: number, units: Units) => {
  if (units === 'mm') return `${mm} mm`
  const inches = mm / 25.4
  return inches < 1 ? `1/${Math.round(1 / inches)}″` : `${+inches.toFixed(3)}″`
}

// Grid steps (mm) for a zoom in px per mm. The minor step is the snap size (snap in mm, 0 = off) while its lines
// are at least 6 px apart, otherwise the smallest series value at least 12 px apart; the major step is the next
// series value of at least 5 minor steps and 60 px (a multiple of the snap size while snapping), else 10 minor steps.
export function gridSteps(zoom: number, units: Units, snap: number) {
  const series = GRID_SERIES[units]
  const snapping = snap > 0 && snap * zoom >= 6
  const minor = snapping ? snap : (series.find((v) => v * zoom >= 12) ?? series.at(-1)!)
  const major =
    series.find((v) => v >= 5 * minor - 1e-9 && v * zoom >= 60 && (!snapping || isMultiple(v, minor))) ??
    [10, 20, 50, 100, 200, 500, 1000].map((k) => k * minor).find((v) => v * zoom >= 60)!
  return { minor, major, label: gridLabel(minor, units) }
}
