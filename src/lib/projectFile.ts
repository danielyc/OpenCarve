import { defaultCut, MAX_STEPOVER, newId, newProject, validCut, type Cut, type CutSettings, type Point, type Polyline, type Project, type Shape } from '../model'
import { FONTS } from './fonts'
import { BITS, findBit, findMaterial, MATERIALS, recommendedSettings } from './library'

// A self-contained, versioned document: the same JSON is the download format and the IndexedDB record,
// so a sync backend can store it verbatim later.
export const FILE_FORMAT = 'opencarve'
export const FILE_VERSION = 1

export const serializeProject = (project: Project): string =>
  JSON.stringify({ format: FILE_FORMAT, version: FILE_VERSION, project }, null, 2)

type Obj = Record<string, unknown>

const fail = (what: string): never => {
  throw new Error(`Invalid project file: ${what}`)
}
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const obj = (v: unknown, what: string): Obj => (isObj(v) ? v : fail(`${what} must be an object`))

function num(o: Obj, key: string, what: string, def?: number, min = -Infinity): number {
  const v = o[key] ?? def
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fail(`${what}.${key} must be a number${min > -Infinity ? ` ≥ ${min}` : ''}`)
}
function positive(o: Obj, key: string, what: string, def: number): number {
  const v = num(o, key, what, def)
  return v > 0 ? v : fail(`${what}.${key} must be > 0`)
}
function str(o: Obj, key: string, what: string, def?: string): string {
  const v = o[key] ?? def
  return typeof v === 'string' ? v : fail(`${what}.${key} must be a string`)
}
function oneOf<T extends string>(o: Obj, key: string, what: string, options: readonly T[], def?: T): T {
  const v = o[key] ?? def
  return options.includes(v as T) ? (v as T) : fail(`${what}.${key} must be one of ${options.join(', ')}`)
}
const bool = (o: Obj, key: string, what: string, def?: boolean): boolean => {
  const v = o[key] ?? def
  return typeof v === 'boolean' ? v : fail(`${what}.${key} must be true or false`)
}

function points(v: unknown, what: string): Point[] {
  if (!Array.isArray(v)) fail(`${what} must be an array`)
  return (v as unknown[]).map((p) =>
    Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)) ? ([p[0], p[1]] as Point) : fail(`${what} has a bad point`),
  )
}

function cut(v: unknown, what: string, thickness: number): Cut {
  const o = obj(v, what)
  const d = defaultCut(thickness)
  return {
    type: oneOf(o, 'type', what, ['outline', 'pocket', 'vcarve'] as const, d.type),
    side: oneOf(o, 'side', what, ['outside', 'inside', 'on'] as const, d.side),
    depth: num(o, 'depth', what, d.depth),
    tabs: bool(o, 'tabs', what, d.tabs),
    tabCount: num(o, 'tabCount', what, d.tabCount),
    tabWidth: num(o, 'tabWidth', what, d.tabWidth),
    tabHeight: num(o, 'tabHeight', what, d.tabHeight),
  }
}

function shape(v: unknown, i: number, thickness: number, warn: (msg: string) => void): Shape {
  const what = `shapes[${i}]`
  const o = obj(v, what)
  const type = oneOf(o, 'type', what, ['rect', 'ellipse', 'polygon', 'path', 'text', 'compound'] as const)
  const base = {
    id: str(o, 'id', what),
    name: str(o, 'name', what, type),
    x: num(o, 'x', what),
    y: num(o, 'y', what),
    rotation: num(o, 'rotation', what, 0),
    ...(o.fillRule === 'evenodd' && { fillRule: 'evenodd' as const }),
  }
  const size = () => ({ w: num(o, 'w', what, undefined, 0), h: num(o, 'h', what, undefined, 0) })
  let s: Shape
  switch (type) {
    case 'rect':
    case 'ellipse':
      s = { ...base, type, ...size() }
      break
    case 'polygon':
      s = { ...base, type, ...size(), sides: Math.min(64, Math.max(3, Math.round(num(o, 'sides', what, 6)))) }
      break
    case 'path':
      s = { ...base, type, points: points(o.points, `${what}.points`), closed: bool(o, 'closed', what, false) }
      break
    case 'text': {
      let font = str(o, 'font', what, FONTS[0].id)
      if (!FONTS.some((f) => f.id === font)) {
        warn(`Unknown font "${font}", using ${FONTS[0].name}.`)
        font = FONTS[0].id
      }
      s = { ...base, type, ...size(), text: str(o, 'text', what), font, size: num(o, 'size', what, undefined, 0) }
      break
    }
    case 'compound': {
      if (!Array.isArray(o.paths)) fail(`${what}.paths must be an array`)
      const paths = (o.paths as unknown[]).map((p, j): Polyline => {
        const po = obj(p, `${what}.paths[${j}]`)
        return { points: points(po.points, `${what}.paths[${j}].points`), closed: bool(po, 'closed', `${what}.paths[${j}]`, true) }
      })
      s = { ...base, type, paths }
    }
  }
  return o.cut === undefined ? s : { ...s, cut: validCut(s, cut(o.cut, `${what}.cut`, thickness), thickness) }
}

function settings(v: unknown, what: string, fallback: CutSettings): CutSettings {
  if (v === undefined) return fallback
  const o = obj(v, what)
  return {
    feed: positive(o, 'feed', what, fallback.feed),
    plunge: positive(o, 'plunge', what, fallback.plunge),
    stepdown: positive(o, 'stepdown', what, fallback.stepdown),
    rpm: positive(o, 'rpm', what, fallback.rpm),
    safeZ: num(o, 'safeZ', what, fallback.safeZ, 0.5),
    stepover: Math.min(MAX_STEPOVER, positive(o, 'stepover', what, fallback.stepover)),
    direction: oneOf(o, 'direction', what, ['climb', 'conventional'] as const, fallback.direction),
  }
}

// Recoverable problems (unknown material or font) fall back to defaults and are reported through `warnings`.
export function parseProject(text: string, warnings: string[] = []): Project {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    fail('not JSON')
  }
  const file = obj(data, 'file')
  if (file.format !== FILE_FORMAT) fail('not an OpenCarve project')
  if (file.version !== FILE_VERSION) fail(`unsupported version ${String(file.version)} (this app reads version ${FILE_VERSION})`)
  const p = obj(file.project, 'project')
  const d = newProject()

  const so = obj(p.stock, 'stock')
  const stock = { w: num(so, 'w', 'stock', undefined, 1), h: num(so, 'h', 'stock', undefined, 1), thickness: num(so, 'thickness', 'stock', undefined, 0.2) }
  let materialId = str(p, 'materialId', 'project', d.materialId)
  if (!MATERIALS.some((m) => m.id === materialId)) {
    warnings.push(`Unknown material "${materialId}", using ${findMaterial(d.materialId).name}.`)
    materialId = d.materialId
  }
  const mo = p.machine === undefined ? d.machine : obj(p.machine, 'machine')
  const machine = { name: str(mo, 'name', 'machine'), w: num(mo, 'w', 'machine', undefined, 1), h: num(mo, 'h', 'machine', undefined, 1), maxRpm: num(mo, 'maxRpm', 'machine', undefined, 1) }
  const bo = p.bits === undefined ? d.bits : obj(p.bits, 'bits')
  const detail = bo.detail === undefined ? undefined : str(bo, 'detail', 'bits')
  const bits = { rough: str(bo, 'rough', 'bits'), ...(detail && { detail }) }
  for (const id of [bits.rough, detail]) if (id !== undefined && !BITS.some((b) => b.id === id)) fail(`unknown bit ${id}`)
  const rec = (id: string) => recommendedSettings(findMaterial(materialId), findBit(id), machine.maxRpm)
  const co = p.cutSettings === undefined ? {} : obj(p.cutSettings, 'cutSettings')
  const custom = p.cutSettingsCustom === undefined ? {} : obj(p.cutSettingsCustom, 'cutSettingsCustom')
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
    name: str(p, 'name', 'project', d.name),
    units: oneOf(p, 'units', 'project', ['mm', 'in'] as const, d.units),
    stock,
    materialId,
    bits,
    cutSettings: {
      rough: settings(co.rough, 'cutSettings.rough', rec(bits.rough)),
      ...(detail && { detail: settings(co.detail, 'cutSettings.detail', rec(detail)) }),
    },
    cutSettingsCustom: {
      rough: bool(custom, 'rough', 'cutSettingsCustom', false),
      detail: !!detail && bool(custom, 'detail', 'cutSettingsCustom', false),
    },
    machine,
    shapes,
  }
}
