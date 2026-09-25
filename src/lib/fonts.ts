import type { Font } from 'opentype.js'
import type { Polyline } from '../model'
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

// Glyphs are laid out one by one (advance + kerning) because opentype.js's shaping throws on some GSUB tables.
// ponytail: no ligatures or complex-script shaping; single line only.
export function glyphPolylines(font: Font, text: string, size: number): Polyline[] {
  const scale = size / font.unitsPerEm
  const out: Polyline[] = []
  let x = 0
  let prev = null
  for (const ch of text) {
    const glyph = font.charToGlyph(ch)
    if (prev) x += font.getKerningValue(prev, glyph) * scale
    // Glyph contours are always closed, but opentype.js doesn't always emit Z.
    const cmds = (glyph.getPath(x, 0, size).commands as PathCommand[]).flatMap((c): PathCommand[] => (c.type === 'M' ? [{ type: 'Z' }, c] : [c]))
    for (const { points } of commandsToPolylines([...cmds, { type: 'Z' }])) out.push({ closed: true, points: points.map(([px, py]) => [px, -py]) })
    x += (glyph.advanceWidth ?? 0) * scale
    prev = glyph
  }
  return out
}

// Flattened at the real size (mm) so the tolerance holds. Returns null (and starts loading) until the font is ready;
// a font that failed to load is only retried by an explicit loadFont().
export function textGlyphs(fontId: string, size: number, text: string): Polyline[] | null {
  const font = loaded.get(fontId)
  if (!font) {
    if (!pending.has(fontId) && !failed.has(fontId)) loadFont(fontId).catch(console.error)
    return null
  }
  const key = `${fontId}|${size}|${text}`
  let polys = glyphCache.get(key)
  if (!polys) {
    if (glyphCache.size >= CACHE_SIZE) glyphCache.delete(glyphCache.keys().next().value!)
    glyphCache.set(key, (polys = glyphPolylines(font, text, size)))
  }
  return polys
}
