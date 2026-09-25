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
  fillRule?: 'evenodd' // shapes use non-zero unless flagged
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

// w/h mirror the glyph bounds (kept in sync by fitText) so bounds work before the font has loaded.
// Text only scales uniformly: resizing changes `size` by the dominant scale factor.
export interface TextShape extends ShapeBase {
  type: 'text'
  text: string
  font: string
  size: number
  w: number
  h: number
}

// Multi-subpath import (e.g. an SVG path with holes); points are relative to x, y.
export interface CompoundShape extends ShapeBase {
  type: 'compound'
  paths: Polyline[]
}

export type Shape = RectShape | EllipseShape | PolygonShape | PathShape | TextShape | CompoundShape

export type ShapePatch = Partial<
  Omit<RectShape, 'type'> & Omit<PolygonShape, 'type'> & Omit<PathShape, 'type'> & Omit<TextShape, 'type'>
>

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
