import { del, get, set, update } from 'idb-keyval'
import type { Font } from 'opentype.js'
import type { Point, Polyline, TextShape } from '../model'
import { commandsToPolylines, type PathCommand } from './bezier'

export type FontCategory = 'sans-serif' | 'serif' | 'display' | 'handwriting' | 'monospace'
export const CATEGORIES: FontCategory[] = ['sans-serif', 'serif', 'display', 'handwriting', 'monospace']

export const FONTS: { id: string; name: string; file: string; category: FontCategory }[] = [
  { id: 'roboto', name: 'Roboto', file: 'Roboto-Regular.ttf', category: 'sans-serif' },
  { id: 'open-sans', name: 'Open Sans', file: 'OpenSans-Regular.ttf', category: 'sans-serif' },
  { id: 'montserrat', name: 'Montserrat', file: 'Montserrat-Regular.ttf', category: 'sans-serif' },
  { id: 'oswald', name: 'Oswald', file: 'Oswald-Regular.ttf', category: 'sans-serif' },
  { id: 'lora', name: 'Lora', file: 'Lora-Regular.ttf', category: 'serif' },
  { id: 'playfair-display', name: 'Playfair Display', file: 'PlayfairDisplay-Regular.ttf', category: 'serif' },
  { id: 'merriweather', name: 'Merriweather', file: 'Merriweather-Regular.ttf', category: 'serif' },
  { id: 'cinzel', name: 'Cinzel', file: 'Cinzel-Regular.ttf', category: 'serif' },
  { id: 'pacifico', name: 'Pacifico', file: 'Pacifico-Regular.ttf', category: 'handwriting' },
  { id: 'dancing-script', name: 'Dancing Script', file: 'DancingScript-Regular.ttf', category: 'handwriting' },
  { id: 'great-vibes', name: 'Great Vibes', file: 'GreatVibes-Regular.ttf', category: 'handwriting' },
  { id: 'caveat', name: 'Caveat', file: 'Caveat-Regular.ttf', category: 'handwriting' },
  { id: 'bebas', name: 'Bebas Neue', file: 'BebasNeue-Regular.ttf', category: 'display' },
  { id: 'alfa-slab-one', name: 'Alfa Slab One', file: 'AlfaSlabOne-Regular.ttf', category: 'display' },
  { id: 'righteous', name: 'Righteous', file: 'Righteous-Regular.ttf', category: 'display' },
  { id: 'allerta-stencil', name: 'Allerta Stencil', file: 'AllertaStencil-Regular.ttf', category: 'display' },
]

// Font ids: bundled ids are plain (`roboto`), uploads are `upload:<uuid>`, Fontsource fonts are `fs:<fontsource-id>`.
export type FontKind = 'bundled' | 'upload' | 'fontsource'
export interface FontSource {
  kind: FontKind
  label: string
  load(): Promise<ArrayBuffer>
}

export const MAX_FONT_BYTES = 5 * 1024 * 1024
const FS_ID = /^[a-z0-9-]+$/
// Display names of uploaded and Fontsource fonts, filled in as their lists load.
const labels = new Map<string, string>()

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`)
  return r.arrayBuffer()
}

export function fontSource(id: string): FontSource {
  if (id.startsWith('upload:')) {
    return {
      kind: 'upload',
      label: labels.get(id) ?? 'Uploaded font',
      load: async () => {
        const f = await get<StoredFont>(uploadKey(id))
        if (!f) throw new Error(`Font ${id} is not stored in this browser`)
        return f.data
      },
    }
  }
  if (id.startsWith('fs:')) {
    const fsId = id.slice(3)
    return {
      kind: 'fontsource',
      label: labels.get(id) ?? fsId.replace(/(^|-)([a-z])/g, (_, dash: string, c: string) => (dash && ' ') + c.toUpperCase()),
      load: async () => {
        if (!FS_ID.test(fsId)) throw new Error(`Bad Fontsource id ${fsId}`)
        const key = `opencarve:fscache:${fsId}`
        const cached = await get<ArrayBuffer>(key).catch(() => undefined)
        if (cached) return cached
        // Every indexed font has a latin subset (see filterFontsourceIndex), so the latin file always exists.
        const buf = await fetchBuffer(`https://cdn.jsdelivr.net/fontsource/fonts/${fsId}@latest/latin-400-normal.ttf`)
        set(key, buf).catch(console.error)
        return buf
      },
    }
  }
  const f = FONTS.find((f) => f.id === id) ?? FONTS[0]
  return { kind: 'bundled', label: f.name, load: () => fetchBuffer(`${import.meta.env.BASE_URL}fonts/${f.file}`) }
}

// Validates font data (size cap, must parse) and returns its family name.
export async function fontFamily(data: ArrayBuffer): Promise<string> {
  if (data.byteLength > MAX_FONT_BYTES) throw new Error('font is larger than 5 MB')
  const font = (await import('opentype.js')).parse(data)
  if (!font.unitsPerEm || !font.glyphs.length) throw new Error('not a usable font')
  return font.getEnglishName('fontFamily')?.trim() || 'Custom font'
}

// Uploaded fonts: one IndexedDB record per font plus an index list of { id, name }.
export interface StoredFont {
  id: string
  name: string
  data: ArrayBuffer
}
export type FontEntry = Pick<StoredFont, 'id' | 'name'>
const UPLOADS = 'opencarve:fonts'
const uploadKey = (id: string) => `opencarve:font:${id}`

export async function listUploadedFonts(): Promise<FontEntry[]> {
  const list = (await get<FontEntry[]>(UPLOADS)) ?? []
  for (const f of list) labels.set(f.id, f.name)
  return list
}
export const getUploadedFont = (id: string) => get<StoredFont>(uploadKey(id))

export async function storeUploadedFont(f: StoredFont) {
  await set(uploadKey(f.id), f)
  await update<FontEntry[]>(UPLOADS, (list = []) => [...list.filter((e) => e.id !== f.id), { id: f.id, name: f.name }])
  labels.set(f.id, f.name)
}

export async function uploadFont(file: File): Promise<FontEntry> {
  const data = await file.arrayBuffer()
  const entry = { id: `upload:${crypto.randomUUID()}`, name: await fontFamily(data) }
  await storeUploadedFont({ ...entry, data })
  return entry
}

export async function removeUploadedFont(id: string) {
  await del(uploadKey(id))
  await update<FontEntry[]>(UPLOADS, (list = []) => list.filter((e) => e.id !== id))
}

// Fontsource index (https://api.fontsource.org/v1/fonts), cached in IndexedDB for a week.
export interface FsFont {
  id: string
  family: string
  category: string
  license: string
}
const FS_LICENSES = ['OFL-1.1', 'Apache-2.0', 'UFL-1.0']
const INDEX_KEY = 'opencarve:fsindex'
const INDEX_TTL = 7 * 24 * 3600 * 1000

// Keeps fonts with a latin subset, a regular weight and a permissive licence.
export function filterFontsourceIndex(raw: unknown): FsFont[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((f): FsFont[] => {
    if (typeof f !== 'object' || f === null) return []
    const { id, family, category, license, subsets, weights } = f as Record<string, unknown>
    const ok =
      typeof id === 'string' &&
      FS_ID.test(id) &&
      typeof family === 'string' &&
      typeof license === 'string' &&
      FS_LICENSES.includes(license) &&
      Array.isArray(subsets) &&
      subsets.includes('latin') &&
      Array.isArray(weights) &&
      weights.includes(400)
    return ok ? [{ id, family, category: typeof category === 'string' ? category : 'other', license }] : []
  })
}

let fsIndex: Promise<FsFont[]> | null = null
export function fontsourceIndex(): Promise<FsFont[]> {
  fsIndex ??= (async () => {
    const cached = await get<{ at: number; fonts: FsFont[] }>(INDEX_KEY).catch(() => undefined)
    let fonts = cached?.fonts
    if (!cached || Date.now() - cached.at > INDEX_TTL) {
      try {
        const r = await fetch('https://api.fontsource.org/v1/fonts')
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        fonts = filterFontsourceIndex(await r.json())
        set(INDEX_KEY, { at: Date.now(), fonts }).catch(console.error)
      } catch (e) {
        if (!fonts) throw e // offline: a stale cache still beats nothing
      }
    }
    for (const f of fonts!) labels.set(`fs:${f.id}`, f.family)
    return fonts!
  })().catch((e) => {
    fsIndex = null
    throw e
  })
  return fsIndex
}

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
    const source = fontSource(id)
    p = source
      .load()
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
        notify(`Could not load font ${source.label}`)
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
  const { letterSpacing = 0, lineHeight = 1.2, align = 'center', arc = 0, mirror = false } = style
  const scale = size / font.unitsPerEm
  const lines = text.split('\n').map((line) => {
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
  const radius = Math.max(0.1, width / Math.abs(theta))
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
