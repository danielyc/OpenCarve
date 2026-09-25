import svgpath from 'svgpath'
import { newId, type Point, type Polyline, type Shape } from '../model'
import { commandsToPolylines, type PathCommand } from './bezier'
import { polylineBounds } from './geometry'

const PX = 25.4 / 96
const UNIT_MM: Record<string, number> = { '': PX, px: PX, mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6 }
const ORIGIN = 10
const SKIP = 'defs, clipPath, mask, symbol, pattern, marker'

function lengthMm(value: string | null) {
  const m = /^\s*([-+\d.eE]+)\s*(px|mm|cm|in|pt|pc)?\s*$/.exec(value ?? '')
  return m ? parseFloat(m[1]) * UNIT_MM[m[2] ?? ''] : null
}

function toPathData(el: Element): string {
  const n = (name: string) => parseFloat(el.getAttribute(name) ?? '0') || 0
  switch (el.tagName) {
    case 'path':
      return el.getAttribute('d') ?? ''
    case 'rect':
      return `M${n('x')} ${n('y')}h${n('width')}v${n('height')}h${-n('width')}z`
    case 'circle':
    case 'ellipse': {
      const [rx, ry] = el.tagName === 'circle' ? [n('r'), n('r')] : [n('rx'), n('ry')]
      const [cx, cy] = [n('cx'), n('cy')]
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}z`
    }
    case 'line':
      return `M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`
    default: {
      const pts = el.getAttribute('points')?.trim() ?? ''
      return pts ? `M${pts}${el.tagName === 'polygon' ? 'z' : ''}` : ''
    }
  }
}

function toCommands(path: ReturnType<typeof svgpath>): PathCommand[] {
  const cmds: PathCommand[] = []
  path.iterate((seg, _i, x, y) => {
    const [type, ...a] = seg as [string, ...number[]]
    if (type === 'M' || type === 'L') cmds.push({ type, x: a[0], y: a[1] })
    else if (type === 'H') cmds.push({ type: 'L', x: a[0], y })
    else if (type === 'V') cmds.push({ type: 'L', x, y: a[0] })
    else if (type === 'Q') cmds.push({ type, x1: a[0], y1: a[1], x: a[2], y: a[3] })
    else if (type === 'C') cmds.push({ type, x1: a[0], y1: a[1], x2: a[2], y2: a[3], x: a[4], y: a[5] })
    else if (type === 'Z' || type === 'z') cmds.push({ type: 'Z' })
  })
  return cmds
}

// ponytail: preserveAspectRatio, CSS transforms/styles, <use> and nested <svg> viewports are ignored.
export function importSvg(svgText: string): Shape[] {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const root = doc.documentElement
  if (root.tagName !== 'svg' || doc.querySelector('parsererror')) throw new Error('Not a valid SVG file')

  const vb = root.getAttribute('viewBox')?.split(/[\s,]+/).map(Number)
  const [vw, vh] = vb?.length === 4 && vb[2] > 0 && vb[3] > 0 ? [vb[2], vb[3]] : [0, 0]
  const sx = vw ? (lengthMm(root.getAttribute('width')) ?? vw * PX) / vw : PX
  const sy = vh ? (lengthMm(root.getAttribute('height')) ?? vh * PX) / vh : PX

  const items: { name: string; polys: Polyline[] }[] = []
  for (const el of root.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon')) {
    if (el.closest(SKIP)) continue
    let path = svgpath(toPathData(el)).abs().unarc().unshort()
    for (let node: Element | null = el; node && node !== root; node = node.parentElement) {
      const t = node.getAttribute('transform')
      if (t) path = path.transform(t)
    }
    path = path.matrix([sx, 0, 0, -sy, 0, 0])
    const polys = commandsToPolylines(toCommands(path))
    if (polys.length) items.push({ name: el.id || el.tagName[0].toUpperCase() + el.tagName.slice(1), polys })
  }
  if (!items.length) return []

  const all = polylineBounds(items.flatMap((i) => i.polys))
  return items.map(({ name, polys }): Shape => {
    const b = polylineBounds(polys)
    const [cx, cy] = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]
    const rel = polys.map((p) => ({ closed: p.closed, points: p.points.map(([x, y]): Point => [x - cx, y - cy]) }))
    const base = { id: newId(), name, rotation: 0, x: cx - all.minX + ORIGIN, y: cy - all.minY + ORIGIN }
    return rel.length === 1 ? { ...base, type: 'path', ...rel[0] } : { ...base, type: 'compound', paths: rel }
  })
}
