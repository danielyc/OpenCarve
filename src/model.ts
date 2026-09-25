import { findBit, findMaterial, MACHINES, recommendedSettings } from './lib/library'
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

// Coordinates: XY origin is the stock's bottom-left corner, Y up; Z zero is the top of the stock there, Z down negative.

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
  flat?: number // tip flat diameter in mm, vbit only
}

export type BitOverride = Partial<Pick<Bit, 'diameter' | 'angle' | 'flat'>>

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
  stepover: number // fraction of bit diameter between pocket passes
  direction: 'climb' | 'conventional'
}

export type BitRole = 'rough' | 'detail'

export const MAX_STEPOVER = 0.5 // beyond this, successive pocket rings can leave a nub between them

// `side` (outline only) is relative to the shape's filled region: holes come from nesting/winding (fillRule),
// so "outside" cuts outside the outer contours and inside the holes, not outside every contour.
// Tabs are placed per contour (tabPositions on each polyline); tabHeight is measured up from the stock bottom.
// `tabs` is the user's choice; tabsActive() says whether it applies.
export interface Cut {
  type: 'outline' | 'pocket' | 'vcarve'
  side: 'outside' | 'inside' | 'on'
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
  // Rough bit cuts everything it fits in. The detail bit, when set, only rest-machines pockets (what the rough bit
  // can't reach); outlines use the rough bit. A V-carve uses whichever role holds a V-bit (detail preferred).
  bits: { rough: string; detail?: string }
  cutSettings: { rough: CutSettings; detail?: CutSettings } // detail present iff bits.detail
  cutSettingsCustom: Record<BitRole, boolean> // false = follow recommendedSettings
  bitOverrides?: Partial<Record<BitRole, BitOverride>> // only fields that differ from the library bit; see effectiveBit
  machine: { name: string; w: number; h: number; maxRpm: number }
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

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

// Open paths can only be followed.
export function validCut(s: Shape, cut: Cut, thickness: number): Cut {
  const open = isOpen(s)
  return {
    ...cut,
    type: open ? 'outline' : cut.type,
    side: open ? 'on' : cut.side,
    depth: clamp(cut.depth, 0.1, cut.type === 'vcarve' && !open ? thickness - 0.5 : thickness), // a V-carve's max depth, never through
    tabCount: Math.max(1, Math.round(cut.tabCount)),
    tabWidth: Math.max(0.1, cut.tabWidth),
    tabHeight: clamp(cut.tabHeight, 0.1, thickness - 0.1),
  }
}

export const tabsActive = (cut: Cut | undefined, thickness: number) => !!cut?.tabs && cut.type === 'outline' && cut.depth >= thickness

export const newId = () => crypto.randomUUID()

export const newProject = (): Project => ({
  id: newId(),
  name: 'Untitled',
  units: 'mm',
  stock: { w: 300, h: 200, thickness: 12 },
  materialId: 'mdf',
  bits: { rough: '1/8-endmill' },
  cutSettings: { rough: recommendedSettings(findMaterial('mdf'), findBit('1/8-endmill'), MACHINES[0].maxRpm) },
  cutSettingsCustom: { rough: false, detail: false },
  bitOverrides: {},
  machine: MACHINES[0],
  shapes: [],
})
