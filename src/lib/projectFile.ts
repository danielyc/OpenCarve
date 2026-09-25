import { fitOrigin, gcodeBlockError, LIMITS, MAX_STEPOVER, newId, newProject, validCut, type BitOverride, type BitRole, type Cut, type CutSettings, type Origin, type Point, type Polyline, type Project, type Shape } from '../model'
import { FONTS, fontFamily, MAX_FONT_BYTES, type StoredFont } from './fonts'
import { BITS, differingFields, findBit, findMaterial, MATERIALS, overrideError } from './library'

// A self-contained, versioned document: the same JSON is the download format and the IndexedDB record,
// so a sync backend can store it verbatim later.
export const FILE_FORMAT = 'opencarve'
// Only the current version is read: the format is still changing and there is no compatibility promise yet.
export const FILE_VERSION = 2

export type EmbeddedFonts = Record<string, Omit<StoredFont, 'id'>>

export const uploadedFontIds = (p: Project) => [...new Set(p.shapes.flatMap((s) => (s.type === 'text' && s.font.startsWith('upload:') ? [s.font] : [])))]

// Uploaded fonts travel inside the file (base64) so it opens on another browser; only those the text shapes use.
export function serializeProject(project: Project, fonts: EmbeddedFonts = {}): string {
  const used = uploadedFontIds(project).filter((id) => fonts[id])
  const embedded = Object.fromEntries(used.map((id) => [id, { name: fonts[id].name, data: toBase64(fonts[id].data) }]))
  return JSON.stringify({ format: FILE_FORMAT, version: FILE_VERSION, project, ...(used.length && { fonts: embedded }) }, null, 2)
}

const toBase64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
const fromBase64 = (b64: string): ArrayBuffer => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer

type Obj = Record<string, unknown>

const fail = (what: string): never => {
  throw new Error(`Invalid project file: ${what}`)
}
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const obj = (v: unknown, what: string): Obj => (isObj(v) ? v : fail(v === undefined ? `${what} is missing` : `${what} must be an object`))
// Every field the app writes is required: a missing one is reported by its path rather than guessed.
const field = (o: Obj, key: string, what: string): unknown => (o[key] === undefined ? fail(`${what}.${key} is missing`) : o[key])

function num(o: Obj, key: string, what: string, min = -Infinity): number {
  const v = field(o, key, what)
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fail(`${what}.${key} must be a number${min > -Infinity ? ` ≥ ${min}` : ''}`)
}
function positive(o: Obj, key: string, what: string): number {
  const v = num(o, key, what)
  return v > 0 ? v : fail(`${what}.${key} must be > 0`)
}
function str(o: Obj, key: string, what: string): string {
  const v = field(o, key, what)
  return typeof v === 'string' ? v : fail(`${what}.${key} must be a string`)
}
function oneOf<T extends string>(o: Obj, key: string, what: string, options: readonly T[]): T {
  const v = field(o, key, what)
  return options.includes(v as T) ? (v as T) : fail(`${what}.${key} must be one of ${options.join(', ')}`)
}
const bool = (o: Obj, key: string, what: string): boolean => {
  const v = field(o, key, what)
  return typeof v === 'boolean' ? v : fail(`${what}.${key} must be true or false`)
}

function points(v: unknown, what: string): Point[] {
  if (!Array.isArray(v)) fail(`${what} must be an array`)
  return (v as unknown[]).map((p) =>
    Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)) ? ([p[0], p[1]] as Point) : fail(`${what} has a bad point`),
  )
}

function cut(v: unknown, what: string): Cut {
  const o = obj(v, what)
  return {
    type: oneOf(o, 'type', what, ['outline', 'pocket', 'vcarve'] as const),
    side: oneOf(o, 'side', what, ['outside', 'inside', 'on'] as const),
    depth: num(o, 'depth', what),
    tabs: bool(o, 'tabs', what),
    tabCount: num(o, 'tabCount', what),
    tabWidth: num(o, 'tabWidth', what),
    tabHeight: num(o, 'tabHeight', what),
  }
}

function shape(v: unknown, i: number, thickness: number, warn: (msg: string) => void): Shape {
  const what = `shapes[${i}]`
  const o = obj(v, what)
  const type = oneOf(o, 'type', what, ['rect', 'ellipse', 'polygon', 'path', 'text', 'compound'] as const)
  const base = {
    id: str(o, 'id', what),
    name: str(o, 'name', what),
    x: num(o, 'x', what),
    y: num(o, 'y', what),
    rotation: num(o, 'rotation', what),
    ...(o.fillRule === 'evenodd' && { fillRule: 'evenodd' as const }),
  }
  const size = () => ({ w: num(o, 'w', what, 0), h: num(o, 'h', what, 0) })
  let s: Shape
  switch (type) {
    case 'rect':
    case 'ellipse':
      s = { ...base, type, ...size() }
      break
    case 'polygon':
      s = { ...base, type, ...size(), sides: Math.min(64, Math.max(3, Math.round(num(o, 'sides', what)))) }
      break
    case 'path':
      s = { ...base, type, points: points(o.points, `${what}.points`), closed: bool(o, 'closed', what) }
      break
    case 'text': {
      let font = str(o, 'font', what)
      // Fontsource fonts load on demand; uploaded fonts are checked by parseProjectFile.
      const known = font.startsWith('upload:') || /^fs:[a-z0-9-]+$/.test(font) || FONTS.some((f) => f.id === font)
      if (!known) {
        warn(`Unknown font "${font}", using ${FONTS[0].name}.`)
        font = FONTS[0].id
      }
      const sz = num(o, 'size', what, 0)
      const range = (key: string, min: number, max: number) => {
        const v = num(o, key, what, min)
        return v <= max ? v : fail(`${what}.${key} must be ≤ ${max}`)
      }
      // w/h are a cache of the glyph bounds; a missing or broken one (e.g. NaN saved as null) is estimated, not fatal.
      const text = str(o, 'text', what)
      const box = (key: string, estimate: number) => {
        const v = o[key]
        return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : estimate
      }
      s = {
        ...base,
        type,
        w: box('w', 0.6 * sz * Math.max(...text.split(/\r?\n/).map((l) => l.length))),
        h: box('h', sz),
        text,
        font,
        size: sz,
        letterSpacing: num(o, 'letterSpacing', what, -sz / 2),
        lineHeight: range('lineHeight', 0.5, 3),
        align: oneOf(o, 'align', what, ['left', 'center', 'right'] as const),
        arc: range('arc', -360, 360),
        mirror: bool(o, 'mirror', what),
      }
      break
    }
    case 'compound': {
      if (!Array.isArray(o.paths)) fail(`${what}.paths must be an array`)
      const paths = (o.paths as unknown[]).map((p, j): Polyline => {
        const po = obj(p, `${what}.paths[${j}]`)
        return { points: points(po.points, `${what}.paths[${j}].points`), closed: bool(po, 'closed', `${what}.paths[${j}]`) }
      })
      s = { ...base, type, paths }
    }
  }
  return o.cut === undefined ? s : { ...s, cut: validCut(s, cut(o.cut, `${what}.cut`), thickness) }
}

function settings(v: unknown, what: string): CutSettings {
  const o = obj(v, what)
  return {
    feed: positive(o, 'feed', what),
    plunge: positive(o, 'plunge', what),
    stepdown: positive(o, 'stepdown', what),
    rpm: positive(o, 'rpm', what),
    safeZ: num(o, 'safeZ', what, LIMITS.safeZ),
    stepover: Math.min(MAX_STEPOVER, positive(o, 'stepover', what)),
    direction: oneOf(o, 'direction', what, ['climb', 'conventional'] as const),
  }
}

// Overrides for unknown or empty roles, or with bad values, are dropped with a warning.
function overrides(v: unknown, bits: Project['bits'], warnings: string[]): Project['bitOverrides'] {
  const out: Project['bitOverrides'] = {}
  for (const [role, ov] of Object.entries(obj(v, 'bitOverrides'))) {
    const id = role === 'rough' || role === 'detail' ? bits[role] : undefined
    const o: BitOverride = isObj(ov) ? Object.fromEntries(['diameter', 'angle', 'flat'].filter((k) => ov[k] !== undefined).map((k) => [k, ov[k]])) : {}
    const error = !id ? `no ${role} bit` : !isObj(ov) ? 'not an object' : overrideError(findBit(id), o)
    if (error) warnings.push(`Ignored the ${role} bit override: ${error}.`)
    else {
      const d = differingFields(findBit(id!), o)
      if (Object.keys(d).length) out[role as BitRole] = d
    }
  }
  return out
}

// Presets follow the stock; a custom zero outside the stock is pulled back onto it with a warning.
function origin(v: unknown, stock: Project['stock'], warnings: string[]): Origin {
  const o = obj(v, 'origin')
  const raw: Origin = {
    preset: oneOf(o, 'preset', 'origin', ['bottom-left', 'bottom-right', 'top-left', 'top-right', 'center', 'custom'] as const),
    x: num(o, 'x', 'origin'),
    y: num(o, 'y', 'origin'),
    z: oneOf(o, 'z', 'origin', ['top', 'bottom'] as const),
  }
  const fit = fitOrigin(raw, stock)
  if (raw.preset === 'custom' && (fit.x !== raw.x || fit.y !== raw.y)) warnings.push(`Work zero was outside the stock; moved to (${fit.x}, ${fit.y}) mm.`)
  return fit
}

function gcode(v: unknown): Project['gcode'] {
  const o = obj(v, 'gcode')
  const block = (key: string) => {
    const t = str(o, key, 'gcode')
    const error = gcodeBlockError(t)
    return error ? fail(`gcode.${key} ${error}`) : t
  }
  return { header: block('header'), footer: block('footer'), replaceDefaults: bool(o, 'replaceDefaults', 'gcode') }
}

// Recoverable problems (unknown material or font) fall back to defaults and are reported through `warnings`.
export function parseProject(text: string, warnings: string[] = []): Project {
  return projectFromData(parseJson(text), warnings)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return fail('not JSON')
  }
}

// parseProject plus the embedded fonts: each must decode, stay under 5 MB and parse. An uploaded font that is
// neither validly embedded nor already stored (hasFont) falls back to Roboto with a warning.
export async function parseProjectFile(
  text: string,
  warnings: string[] = [],
  hasFont: (id: string) => Promise<boolean> = async () => false,
): Promise<{ project: Project; fonts: EmbeddedFonts }> {
  const data = parseJson(text)
  const project = projectFromData(data, warnings)
  const raw = isObj(data) && isObj(data.fonts) ? data.fonts : {}
  const fonts: EmbeddedFonts = {}
  const fallback = new Set<string>()
  for (const id of uploadedFontIds(project)) {
    const f = raw[id]
    if (isObj(f) && typeof f.data === 'string') {
      try {
        if (f.data.length > (MAX_FONT_BYTES * 4) / 3 + 4) throw new Error('font is larger than 5 MB')
        const buf = fromBase64(f.data)
        const family = await fontFamily(buf)
        fonts[id] = { name: typeof f.name === 'string' && f.name ? f.name : family, data: buf }
        continue
      } catch (e) {
        warnings.push(`Embedded font "${String(f.name ?? id)}" is not usable (${(e as Error).message}).`)
      }
    }
    if (!(await hasFont(id))) fallback.add(id)
  }
  if (fallback.size) warnings.push(`${fallback.size} uploaded font${fallback.size > 1 ? 's are' : ' is'} missing, using ${FONTS[0].name}.`)
  const shapes = project.shapes.map((s) => (s.type === 'text' && fallback.has(s.font) ? { ...s, font: FONTS[0].id } : s))
  return { project: { ...project, shapes }, fonts }
}

function projectFromData(data: unknown, warnings: string[]): Project {
  const file = obj(data, 'file')
  if (file.format !== FILE_FORMAT) fail('not an OpenCarve project')
  if (file.version !== FILE_VERSION) fail(`unsupported version ${String(file.version)} (this app reads version ${FILE_VERSION})`)
  const p = obj(file.project, 'project')
  const defaultMaterial = newProject().materialId

  const so = obj(p.stock, 'stock')
  const stock = { w: num(so, 'w', 'stock', LIMITS.stockSize), h: num(so, 'h', 'stock', LIMITS.stockSize), thickness: num(so, 'thickness', 'stock', LIMITS.thickness) }
  let materialId = str(p, 'materialId', 'project')
  if (!MATERIALS.some((m) => m.id === materialId)) {
    warnings.push(`Unknown material "${materialId}", using ${findMaterial(defaultMaterial).name}.`)
    materialId = defaultMaterial
  }
  const mo = obj(p.machine, 'machine')
  const machine = { name: str(mo, 'name', 'machine'), w: num(mo, 'w', 'machine', LIMITS.travel), h: num(mo, 'h', 'machine', LIMITS.travel), maxRpm: num(mo, 'maxRpm', 'machine', LIMITS.maxRpm) }
  const bo = obj(p.bits, 'bits')
  const detail = bo.detail === undefined ? undefined : str(bo, 'detail', 'bits')
  const bits = { rough: str(bo, 'rough', 'bits'), ...(detail && { detail }) }
  for (const id of [bits.rough, detail]) if (id !== undefined && !BITS.some((b) => b.id === id)) fail(`unknown bit ${id}`)
  const bitOverrides = overrides(p.bitOverrides, bits, warnings)
  const co = obj(p.cutSettings, 'cutSettings')
  if (!detail && co.detail !== undefined) fail('cutSettings.detail is present without a detail bit')
  const custom = obj(p.cutSettingsCustom, 'cutSettingsCustom')
  if (!Array.isArray(p.shapes)) fail('shapes must be an array')
  const ids = new Set<string>()
  const shapes = (p.shapes as unknown[]).map((v, i) => {
    const s = shape(v, i, stock.thickness, (msg) => warnings.includes(msg) || warnings.push(msg))
    if (ids.has(s.id)) s.id = newId() // ids must be unique for selection and toolpath ops
    ids.add(s.id)
    return s
  })

  return {
    id: str(p, 'id', 'project'),
    name: str(p, 'name', 'project'),
    units: oneOf(p, 'units', 'project', ['mm', 'in'] as const),
    stock,
    materialId,
    bits,
    cutSettings: {
      rough: settings(co.rough, 'cutSettings.rough'),
      ...(detail && { detail: settings(co.detail, 'cutSettings.detail') }),
    },
    cutSettingsCustom: {
      rough: bool(custom, 'rough', 'cutSettingsCustom'),
      detail: bool(custom, 'detail', 'cutSettingsCustom') && !!detail,
    },
    bitOverrides,
    machine,
    origin: origin(p.origin, stock, warnings),
    gcode: gcode(p.gcode),
    shapes,
  }
}
