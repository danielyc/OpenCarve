import { findBit, findMaterial, recommendedSettings } from './lib/library'
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
  cut?: Cut // absent = design-only, not carved
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

export interface Bit {
  id: string
  name: string
  type: 'endmill' | 'ballnose' | 'vbit'
  diameter: number // mm
  angle?: number // included angle in degrees, vbit only
}

export interface Material {
  id: string
  name: string
  feed: number // mm/min
  plunge: number // mm/min
  stepdownFrac: number // of bit diameter per pass
  rpm: number
}

export interface CutSettings {
  feed: number // mm/min
  plunge: number // mm/min
  stepdown: number // mm
  rpm: number
  safeZ: number // mm
}

export interface Cut {
  type: 'outline' | 'pocket' | 'vcarve'
  side: 'outside' | 'inside' | 'on' // outline only
  depth: number // mm from top; >= stock.thickness means through
  tabs: boolean
  tabCount: number
  tabWidth: number
  tabHeight: number
}

export interface Project {
  id: string
  name: string
  units: Units
  stock: { w: number; h: number; thickness: number }
  materialId: string
  bits: { rough: string; detail?: string }
  cutSettings: CutSettings
  cutSettingsCustom: boolean // false = follow recommendedSettings
  machine: { name: string; w: number; h: number }
  shapes: Shape[]
}

export const isOpen = (s: Shape) => (s.type === 'path' ? !s.closed : s.type === 'compound' && s.paths.some((p) => !p.closed))

export const defaultCut = (thickness: number): Cut => ({
  type: 'outline',
  side: 'outside',
  depth: thickness,
  tabs: true,
  tabCount: 4,
  tabWidth: 6,
  tabHeight: 3,
})

// Open paths can only be followed; tabs only make sense on a through outline.
export function validCut(s: Shape, cut: Cut, thickness: number): Cut {
  const open = isOpen(s)
  const type = open ? 'outline' : cut.type
  const depth = Math.min(thickness, Math.max(0.1, cut.depth))
  return { ...cut, type, side: open ? 'on' : cut.side, depth, tabs: cut.tabs && type === 'outline' && depth >= thickness }
}

export const newId = () => crypto.randomUUID()

export const newProject = (): Project => ({
  id: newId(),
  name: 'Untitled',
  units: 'mm',
  stock: { w: 300, h: 200, thickness: 12 },
  materialId: 'mdf',
  bits: { rough: '1/8-endmill' },
  cutSettings: recommendedSettings(findMaterial('mdf'), findBit('1/8-endmill')),
  cutSettingsCustom: false,
  machine: { name: 'Generic GRBL', w: 300, h: 300 },
  shapes: [],
})
