import type { Font } from 'opentype.js'
import type { Point, Polyline, TextShape } from '../model'
import { commandsToPolylines, type PathCommand } from './bezier'

export const FONTS = [
  { id: 'roboto', name: 'Roboto', file: 'Roboto-Regular.ttf' },
  { id: 'lora', name: 'Lora', file: 'Lora-Regular.ttf' },
  { id: 'pacifico', name: 'Pacifico', file: 'Pacifico-Regular.ttf' },
  { id: 'bebas', name: 'Bebas Neue', file: 'BebasNeue-Regular.ttf' },
]

const pending = new Map<string, Promise<Font>>()
const loaded = new Map<string, Font>()
const failed = new Set<string>()
const glyphCache = new Map<string, Polyline[]>()
const CACHE_SIZE = 200
let notify: (error?: string) => void = () => {}
export const onFontLoad = (fn: (error?: string) => void) => (notify = fn)

export function loadFont(id: string): Promise<Font> {
  let p = pending.get(id)
  if (!p) {
    const file = (FONTS.find((f) => f.id === id) ?? FONTS[0]).file
    p = fetch(`${import.meta.env.BASE_URL}fonts/${file}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load font ${file}`)
        return r.arrayBuffer()
      })
      .then(async (buf) => {
        const font = (await import('opentype.js')).parse(buf)
        loaded.set(id, font)
        failed.delete(id)
        notify()
        return font
      })
      .catch((e) => {
        pending.delete(id)
        failed.add(id)
        notify(`Could not load font ${file}`)
        throw e
      })
    pending.set(id, p)
  }
  return p
}

export type TextStyle = Pick<TextShape, 'letterSpacing' | 'lineHeight' | 'align' | 'arc' | 'mirror'>

// Glyphs are laid out one by one (advance + kerning) because opentype.js's shaping throws on some GSUB tables.
// ponytail: no ligatures or complex-script shaping.
// Lines stack down from the first baseline at y = 0 and align within the widest line's advance width. A bend maps
// each line's advance length onto an arc about a common centre (below for a positive bend, above for negative),
// each glyph turned about its advance centre so its baseline is tangent. The first baseline's radius is the widest
// line's length / bend; later lines nest at radius ∓ i × lineHeight × size, keeping their arc length.
export function glyphPolylines(font: Font, text: string, size: number, style: TextStyle = {}): Polyline[] {
  const { letterSpacing = 0, lineHeight = 1.2, align = 'center', mirror = false } = style
  const arc = Math.abs(style.arc ?? 0) < 0.5 ? 0 : style.arc! // a hair's bend would need an astronomically large radius
  const scale = size / font.unitsPerEm
  const lines = text.split(/\r?\n/).map((line) => {
    const glyphs: { polys: Polyline[]; center: number }[] = []
    let x = 0
    let prev = null
    for (const ch of line) {
      const glyph = font.charToGlyph(ch)
      if (prev) x += font.getKerningValue(prev, glyph) * scale + letterSpacing
      // Glyph contours are always closed, but opentype.js doesn't always emit Z.
      const cmds = (glyph.getPath(x, 0, size).commands as PathCommand[]).flatMap((c): PathCommand[] => (c.type === 'M' ? [{ type: 'Z' }, c] : [c]))
      const advance = (glyph.advanceWidth ?? 0) * scale
      glyphs.push({
        polys: commandsToPolylines([...cmds, { type: 'Z' }]).map(({ points }) => ({ closed: true, points: points.map(([px, py]): Point => [px, -py]) })),
        center: x + advance / 2,
      })
      x += advance
      prev = glyph
    }
    return { glyphs, length: x }
  })
  const width = Math.max(...lines.map((l) => l.length))
  const theta = (arc * Math.PI) / 180
  const sign = Math.sign(theta)
  // ponytail: an upward bend on several lines is limited so the innermost line keeps a radius of at least one text size
  // (smaller radii collapse its glyphs into the centre); the stored `arc` is untouched, only the layout uses less.
  const innermost = sign > 0 ? (lines.length - 1) * lineHeight * size : 0
  const radius = Math.max(0.1, width / Math.abs(theta), innermost && innermost + size)
  const out: Polyline[] = []
  lines.forEach(({ glyphs, length }, i) => {
    const offset = (align === 'left' ? 0 : align === 'right' ? width - length : (width - length) / 2) - width / 2
    const baseline = -i * lineHeight * size
    const r = Math.max(0.1, radius - sign * i * lineHeight * size)
    for (const { polys, center } of glyphs) {
      let place = ([px, py]: Point): Point => [px + offset, py + baseline]
      if (theta) {
        // On an arc, lines align by angle within the widest line's span so nested lines line up radially.
        const start = align === 'left' ? -Math.abs(theta) / 2 : align === 'right' ? Math.abs(theta) / 2 - length / r : -length / (2 * r)
        const phi = start + center / r
        const [c, s] = [Math.cos(-sign * phi), Math.sin(-sign * phi)]
        const [ox, oy] = [r * Math.sin(phi), sign * (r * Math.cos(phi) - radius)]
        place = ([px, py]) => [ox + (px - center) * c - py * s, oy + (px - center) * s + py * c]
      }
      for (const p of polys) out.push({ closed: true, points: p.points.map(place) })
    }
  })
  // Belt and braces: anything non-finite (a degenerate bend) falls back to the straight layout rather than NaN bounds.
  if (arc && !out.every((p) => p.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)))) return glyphPolylines(font, text, size, { ...style, arc: 0 })
  // Mirroring reverses each contour's point order so its winding (outer vs hole) survives the flip.
  if (mirror) {
    let [min, max] = [Infinity, -Infinity]
    for (const p of out) for (const [x] of p.points) [min, max] = [Math.min(min, x), Math.max(max, x)]
    const mid = (min + max) / 2
    return out.map((p) => ({ closed: true, points: p.points.map(([x, y]): Point => [2 * mid - x, y]).reverse() }))
  }
  return out
}

// Flattened at the real size (mm) so the tolerance holds. Returns null (and starts loading) until the font is ready;
// a font that failed to load is only retried by an explicit loadFont().
export function textGlyphs(t: Pick<TextShape, 'font' | 'size' | 'text'> & TextStyle): Polyline[] | null {
  const font = loaded.get(t.font)
  if (!font) {
    if (!pending.has(t.font) && !failed.has(t.font)) loadFont(t.font).catch(console.error)
    return null
  }
  const key = JSON.stringify([t.font, t.size, t.text, t.letterSpacing, t.lineHeight, t.align, t.arc, t.mirror])
  let polys = glyphCache.get(key)
  if (!polys) {
    if (glyphCache.size >= CACHE_SIZE) glyphCache.delete(glyphCache.keys().next().value!)
    glyphCache.set(key, (polys = glyphPolylines(font, t.text, t.size, t)))
  }
  return polys
}
