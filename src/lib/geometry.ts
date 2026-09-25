import type { Point, Polyline, Shape, ShapeBase } from '../model'

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number }
type Placement = Pick<ShapeBase, 'x' | 'y' | 'rotation'>

const ELLIPSE_SEGMENTS = 64
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
    case 'ellipse':
      return [
        {
          closed: true,
          points: Array.from({ length: ELLIPSE_SEGMENTS }, (_, i) => {
            const a = (i / ELLIPSE_SEGMENTS) * 2 * Math.PI
            return [(Math.cos(a) * shape.w) / 2, (Math.sin(a) * shape.h) / 2]
          }),
        },
      ]
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
  }
}

export const shapeToPolylines = (shape: Shape): Polyline[] =>
  localPolylines(shape).map(({ points, closed }) => ({ closed, points: points.map((p) => toWorld(shape, p)) }))

export const shapeBounds = (shape: Shape) => polylineBounds(shapeToPolylines(shape))

export const localBounds = (shape: Shape) => polylineBounds(localPolylines(shape))

export function scaleShape(shape: Shape, sx: number, sy: number): Shape {
  if (shape.type === 'path') return { ...shape, points: shape.points.map(([x, y]) => [x * sx, y * sy]) }
  return { ...shape, w: shape.w * Math.abs(sx), h: shape.h * Math.abs(sy) }
}
