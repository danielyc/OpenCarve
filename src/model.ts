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
  letterSpacing: number // mm between glyphs, >= -size/2
  lineHeight: number // × size, 0.5–3
  align: 'left' | 'center' | 'right'
  arc: number // bend in degrees; positive arches up (centre below), negative down; -360..360
  mirror: boolean // horizontal flip
}

// Coordinates: shapes and toolpaths live in stock coordinates — XY from the stock's bottom-left corner, Y up; Z zero is
// the top of the stock, Z down negative. The work zero (Project.origin) only shifts what is displayed and emitted in G-code.

// Multi-subpath import (e.g. an SVG path with holes); points are relative to x, y.
export interface CompoundShape extends ShapeBase {
  type: 'compound'
  paths: Polyline[]
}

export const DEFAULT_TEXT_LAYOUT: Pick<TextShape, 'letterSpacing' | 'lineHeight' | 'align' | 'arc' | 'mirror'> = {
  letterSpacing: 0,
  lineHeight: 1.2,
  align: 'center',
  arc: 0,
  mirror: false,
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

// Smallest values the app accepts; the store clamps edits to them and the loader rejects anything below.
export const LIMITS = { stockSize: 1, thickness: 1, travel: 1, maxRpm: 1, safeZ: 0.5 }

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

export type OriginPreset = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right' | 'center'
// x/y: the zero's position in stock coordinates. z: whether Z zero is the stock top or its bottom (the spoilboard).
export interface Origin {
  preset: OriginPreset | 'custom'
  x: number
  y: number
  z: 'top' | 'bottom'
}

export function originXY(stock: { w: number; h: number }, preset: OriginPreset): [number, number] {
  if (preset === 'center') return [stock.w / 2, stock.h / 2]
  return [preset.endsWith('right') ? stock.w : 0, preset.startsWith('top') ? stock.h : 0]
}

// Keeps a preset zero on its corner/centre and a custom one inside the stock.
export function fitOrigin(o: Origin, stock: { w: number; h: number }): Origin {
  if (o.preset !== 'custom') {
    const [x, y] = originXY(stock, o.preset)
    return { ...o, x, y }
  }
  return { ...o, x: clamp(o.x, 0, stock.w), y: clamp(o.y, 0, stock.h) }
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
  bitOverrides: Partial<Record<BitRole, BitOverride>> // only fields that differ from the library bit; see effectiveBit
  machine: { name: string; w: number; h: number; maxRpm: number }
  origin: Origin
  gcode: GcodeBlocks
  shapes: Shape[]
}

// User G-code emitted before and after the toolpaths; replaceDefaults drops the standard setup and end lines.
export interface GcodeBlocks {
  header: string
  footer: string
  replaceDefaults: boolean
}

export const MAX_GCODE_BLOCK = 20_000

// G-code without its comments: `(...)` and everything after `;`.
const gcodeWords = (text: string) => text.replace(/\([^)\n]*\)?/g, ' ').replace(/;.*/g, ' ')
// True if the code has this word, e.g. hasWord(code, 'G', '21') matches G21, g021 and G21.0 but not G21.1 (a distinct word), G210 or XG21.
const hasWord = (code: string, letter: string, num: string) => new RegExp(`(?<![a-z])${letter}\\s*0*${num}(?:\\.0+)?(?![\\d.])`, 'i').test(code)

// Printable ASCII, tabs and line breaks only, so the file is plain for any controller. The header may not switch to
// inches (G20), incremental moves (G91) or inverse-time feeds (G93): OpenCarve's moves are absolute millimetres at
// mm/min feeds. The footer may (parking moves).
export function gcodeBlockError(text: string, header = false) {
  if (text.length > MAX_GCODE_BLOCK) return `must be at most ${MAX_GCODE_BLOCK} characters`
  if (/[^\x20-\x7e\t\r\n]/.test(text)) return 'may only contain printable ASCII characters, tabs and line breaks'
  const code = gcodeWords(text)
  if (header && ['20', '91', '93'].some((n) => hasWord(code, 'G', n))) return "can't switch to inches (G20), incremental moves (G91) or inverse-time feeds (G93); the toolpaths are absolute millimetres at mm/min"
  return null
}

// With replaceDefaults the user's header must do what the standard lines did.
export function gcodeHeaderWarnings(g: GcodeBlocks): string[] {
  if (!g.replaceDefaults) return []
  const code = gcodeWords(g.header)
  return [
    ...(hasWord(code, 'M', '3') || hasWord(code, 'M', '4') ? [] : ["Custom G-code header doesn't start the spindle (M3/M4)"]),
    ...(hasWord(code, 'G', '21') && hasWord(code, 'G', '90') ? [] : ["Custom G-code header doesn't set G21 G90"]),
  ]
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
  origin: { preset: 'bottom-left', x: 0, y: 0, z: 'top' },
  gcode: { header: '', footer: '', replaceDefaults: false },
  shapes: [],
})
