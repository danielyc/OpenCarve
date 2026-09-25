import type { Units } from './lib/units'

export type Point = [number, number]
export type Polyline = { points: Point[]; closed: boolean }

export interface ShapeBase {
  id: string
  type: string
  name: string
  x: number
  y: number
  rotation: number
}

export interface RectShape extends ShapeBase {
  type: 'rect'
  w: number
  h: number
}

export interface EllipseShape extends ShapeBase {
  type: 'ellipse'
  w: number
  h: number
}

export interface PolygonShape extends ShapeBase {
  type: 'polygon'
  sides: number
  w: number
  h: number
}

export interface PathShape extends ShapeBase {
  type: 'path'
  points: Point[]
  closed: boolean
}

export type Shape = RectShape | EllipseShape | PolygonShape | PathShape

export type ShapePatch = Partial<Omit<RectShape, 'type'> & Omit<PolygonShape, 'type'> & Omit<PathShape, 'type'>>

export interface Project {
  id: string
  name: string
  units: Units
  material: { w: number; h: number; thickness: number }
  shapes: Shape[]
}

export const newId = () => crypto.randomUUID()

export const newProject = (): Project => ({
  id: newId(),
  name: 'Untitled',
  units: 'mm',
  material: { w: 300, h: 200, thickness: 12 },
  shapes: [],
})
