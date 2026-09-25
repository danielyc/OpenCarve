import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { opKey, type Op, type Pt3 } from '../cam/toolpath'
import { icons } from '../icons'
import { FONTS, loadFont } from '../lib/fonts'
import { dominantScale, fitText, gridPath, localBounds, polylineBounds, scaleShape, shapeBounds, shapeToPolylines, toLocal, toWorld, type Bounds } from '../lib/geometry'
import { formatLength, nearestSnap, SNAP_SIZES, snapDelta, snapPoint } from '../lib/units'
import { DEFAULT_TEXT_LAYOUT, newId, tabsActive, type Point, type Polyline, type Shape } from '../model'
import { TOOL_KEYS, useAppStore, type Align, type Tool } from '../store'

type Frame = { x: number; y: number; rotation: number; b: Bounds }
type Drag =
  | { kind: 'pan'; cx: number; cy: number; panX: number; panY: number }
  | { kind: 'transform'; ids: string[]; apply: (p: Point, shift: boolean, grid: number) => Shape[] } // grid: snap size in mm, 0 = off
  | { kind: 'marquee' | 'create'; start: Point; current: Point; shift: boolean; keep: string[] }

const PX_PER_MM_AT_100 = 96 / 25.4
const HANDLE = 8
const ROTATE_OFFSET = 24
const CLOSE_PX = 8
const MIN_SIZE = 0.1
const HANDLES = [-1, 0, 1].flatMap((hx) => [-1, 0, 1].filter((hy) => hx || hy).map((hy): Point => [hx, hy]))
const ALIGNS: { mode: Align; label: string }[] = [
  { mode: 'left', label: 'Align left' },
  { mode: 'centerX', label: 'Align centre horizontally' },
  { mode: 'right', label: 'Align right' },
  { mode: 'top', label: 'Align top' },
  { mode: 'centerY', label: 'Align centre vertically' },
  { mode: 'bottom', label: 'Align bottom' },
]
const NAMES = { rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon' }

const pathD = (polys: Polyline[]) =>
  polys.map((p) => 'M' + p.points.map((q) => q.join(' ')).join('L') + (p.closed ? 'Z' : '')).join('')

function toolpathD(ops: Op[]) {
  const d = { rough: '', detail: '', vcarve: '', rapid: '' }
  let last: Pt3 | null = null
  for (const op of ops) {
    for (const seg of op.segments) {
      const key = seg.rapid ? 'rapid' : op.kind === 'vcarve' ? 'vcarve' : op.role
      const [first, ...rest] = last ? [last, ...seg.points] : seg.points
      d[key] += `M${first[0]} ${first[1]}` + rest.map((p) => `L${p[0]} ${p[1]}`).join('')
      last = seg.points.at(-1)!
    }
  }
  return d
}

const signedArea = (pts: Point[]) => pts.reduce((sum, q, i) => sum + q[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * q[1], 0) / 2

// A short arrow from a quarter of the way along the first edge (clear of tabs and handles) towards the side the bit
// runs on. Drawn on the largest contour, which is always an outer whatever the fill rule.
function sideArrow(polys: Polyline[], outside: boolean, len: number) {
  const pts = polys
    .filter((p) => p.closed && p.points.length > 2)
    .map((p) => ({ pts: p.points, area: signedArea(p.points) }))
    .reduce<{ pts: Point[]; area: number } | null>((best, c) => (!best || Math.abs(c.area) > Math.abs(best.area) ? c : best), null)
  const d = pts ? dist(pts.pts[0], pts.pts[1]) : 0
  if (!pts || !d) return ''
  const [a, b] = pts.pts
  const { area } = pts
  const sgn = area > 0 === outside ? 1 : -1 // the right-hand normal points out of a CCW contour
  const nx = (sgn * (b[1] - a[1])) / d
  const ny = (-sgn * (b[0] - a[0])) / d
  const m: Point = [a[0] + (b[0] - a[0]) / 4, a[1] + (b[1] - a[1]) / 4]
  const tip: Point = [m[0] + nx * len, m[1] + ny * len]
  const h = len * 0.35
  return `M${m.join(' ')}L${tip.join(' ')}M${tip[0] - (nx + ny) * h} ${tip[1] - (ny - nx) * h}L${tip.join(' ')}L${tip[0] - (nx - ny) * h} ${tip[1] - (ny + nx) * h}`
}

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1])
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const handleLocal = ({ b }: Frame, [hx, hy]: Point): Point => [lerp(b.minX, b.maxX, (hx + 1) / 2), lerp(b.minY, b.maxY, (hy + 1) / 2)]
const overlaps = (a: Bounds, b: Bounds) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY
const rectBounds = ([ax, ay]: Point, [bx, by]: Point): Bounds => ({
  minX: Math.min(ax, bx),
  minY: Math.min(ay, by),
  maxX: Math.max(ax, bx),
  maxY: Math.max(ay, by),
})

function selectionFrame(shapes: Shape[]): Frame | null {
  if (!shapes.length) return null
  if (shapes.length === 1) {
    const [s] = shapes
    return { x: s.x, y: s.y, rotation: s.rotation, b: localBounds(s) }
  }
  return { x: 0, y: 0, rotation: 0, b: polylineBounds(shapes.flatMap(shapeToPolylines)) }
}

// ponytail: a rotated shape inside a multi-selection gets the frame's scale projected onto its own axes
// instead of a true skew; exact for a single shape, unrotated shapes, or uniform scaling.
function scaleFn(base: Shape[], frame: Frame, [hx, hy]: Point) {
  const { b } = frame
  const w0 = b.maxX - b.minX
  const h0 = b.maxY - b.minY
  const anchor = handleLocal(frame, [-hx, -hy])
  return (p: Point, shift: boolean, grid: number) => {
    const [px, py] = toLocal(frame, snapPoint(p, grid))
    let { minX, maxX, minY, maxY } = b
    if (hx > 0) maxX = Math.max(px, minX + MIN_SIZE)
    if (hx < 0) minX = Math.min(px, maxX - MIN_SIZE)
    if (hy > 0) maxY = Math.max(py, minY + MIN_SIZE)
    if (hy < 0) minY = Math.min(py, maxY - MIN_SIZE)
    let sx = w0 ? (maxX - minX) / w0 : 1
    let sy = h0 ? (maxY - minY) / h0 : 1
    if (base.length === 1 && base[0].type === 'text') sx = sy = dominantScale(sx, sy)
    else if (shift && hx && hy) sx = sy = Math.max(sx, sy)
    return base.map((s) => {
      const [cx, cy] = toLocal(frame, [s.x, s.y])
      const [x, y] = toWorld(frame, [anchor[0] + (cx - anchor[0]) * sx, anchor[1] + (cy - anchor[1]) * sy])
      const r = ((s.rotation - frame.rotation) * Math.PI) / 180
      const c = Math.cos(r)
      const n = Math.sin(r)
      return { ...scaleShape(s, Math.hypot(sx * c, sy * n), Math.hypot(sx * n, sy * c)), x, y }
    })
  }
}

function rotateFn(base: Shape[], frame: Frame, start: Point) {
  const [ox, oy] = toWorld(frame, handleLocal(frame, [0, 0]))
  const a0 = Math.atan2(start[1] - oy, start[0] - ox)
  return (p: Point, shift: boolean, grid: number) => {
    let deg = ((Math.atan2(p[1] - oy, p[0] - ox) - a0) * 180) / Math.PI
    if (shift || grid) deg = Math.round(deg / 15) * 15
    return base.map((s) => {
      const [x, y] = toWorld({ x: ox, y: oy, rotation: deg }, [s.x - ox, s.y - oy])
      return { ...s, x, y, rotation: (((s.rotation + deg) % 360) + 360) % 360 }
    })
  }
}

function makeShape(tool: 'rect' | 'ellipse' | 'polygon', a: Point, b: Point, square: boolean, minSize: number, id = ''): Shape | null {
  let w = Math.abs(b[0] - a[0])
  let h = Math.abs(b[1] - a[1])
  if (square) w = h = Math.max(w, h)
  if (w < minSize || h < minSize) return null
  const shape = { id, name: NAMES[tool], rotation: 0, w, h, x: a[0] + ((b[0] >= a[0] ? 1 : -1) * w) / 2, y: a[1] + ((b[1] >= a[1] ? 1 : -1) * h) / 2 }
  return tool === 'polygon' ? { ...shape, type: 'polygon', sides: 6 } : { ...shape, type: tool }
}

const fitTo = (svg: SVGSVGElement | null) => {
  if (svg?.clientWidth) useAppStore.getState().fitView(svg.clientWidth, svg.clientHeight)
}

const keyTool = Object.fromEntries(Object.entries(TOOL_KEYS).map(([t, k]) => [k.toLowerCase(), t as Tool]))
const isTyping = (t: EventTarget | null) => t instanceof Element && !!t.closest('input, textarea, select, [contenteditable="true"]')

export default function Canvas() {
  const project = useAppStore((s) => s.project)
  const selection = useAppStore((s) => s.selection)
  const tool = useAppStore((s) => s.tool)
  const view = useAppStore((s) => s.view)
  const snap = useAppStore((s) => s.snap)
  useAppStore((s) => s.fontsVersion)
  const status = useAppStore((s) => s.status)
  const step = useAppStore((s) => s.step)
  const cam = useAppStore((s) => (s.step === 'simulate' ? s.cam : null))
  // Tab marks come from the planner: dimmed while a new plan is on its way, gone for shapes changed since the plan.
  const planned = useAppStore((s) => s.cam)
  const camBusy = useAppStore((s) => s.camBusy)
  const highlight = useAppStore((s) => s.highlightOp)
  const [showRapids, setShowRapids] = useState(false)
  const hl = cam?.ops.find((o) => opKey(o) === highlight && selection.includes(o.shapeId))
  const toolpaths = cam && toolpathD(cam.ops.filter((o) => o !== hl))
  const hlPaths = hl && toolpathD([hl])
  const svgRef = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [cursor, setCursor] = useState<Point | null>(null)
  const [space, setSpace] = useState(false)
  const [svgSize, setSvgSize] = useState<Point>([0, 0])
  const [pen, setPen] = useState<Point[]>([])
  if (tool !== 'pen' && pen.length) setPen([])

  const { zoom, panX, panY } = view
  const { stock, units } = project
  const snapSize = nearestSnap(snap.size, units)
  const gridFor = (e: { altKey: boolean }) => (snap.on && !e.altKey ? snapSize : 0) // Alt bypasses snapping
  const selected = project.shapes.filter((s) => selection.includes(s.id))
  const selecting = tool === 'select' || step !== 'design'
  const frame = selecting && drag?.kind !== 'marquee' ? selectionFrame(selected) : null
  const toScreen = ([x, y]: Point): Point => [panX + x * zoom, panY - y * zoom]
  const pts = (ps: Point[]) => ps.map((p) => toScreen(p).join(',')).join(' ')

  const eventPoint = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect()
    return [(e.clientX - r.left - panX) / zoom, (panY - (e.clientY - r.top)) / zoom]
  }

  const finishPen = (points: Point[], closed = false) => {
    points = points.filter((p, i) => i === 0 || dist(p, points[i - 1]) > 2 / zoom)
    if (!closed && points.length > 3 && dist(points.at(-1)!, points[0]) < CLOSE_PX / zoom) {
      closed = true
      points = points.slice(0, -1)
    }
    setPen([])
    if (points.length < (closed ? 3 : 2)) return
    const b = polylineBounds([{ points, closed }])
    const x = (b.minX + b.maxX) / 2
    const y = (b.minY + b.maxY) / 2
    const st = useAppStore.getState()
    st.addShape({ id: newId(), type: 'path', name: 'Path', x, y, rotation: 0, closed, points: points.map(([px, py]) => [px - x, py - y]) })
    st.setTool('select')
  }

  useEffect(() => fitTo(svgRef.current), [stock.w, stock.h])

  useEffect(() => {
    const svg = svgRef.current!
    const ro = new ResizeObserver(() => setSvgSize([svg.clientWidth, svg.clientHeight]))
    ro.observe(svg)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const svg = svgRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const { view, setView } = useAppStore.getState()
      if (e.shiftKey) return setView({ panX: view.panX - (e.deltaX || e.deltaY) })
      if (!e.ctrlKey && !e.metaKey) return setView({ panX: view.panX - e.deltaX, panY: view.panY - e.deltaY })
      const r = svg.getBoundingClientRect()
      const cx = e.clientX - r.left
      const cy = e.clientY - r.top
      const dy = e.ctrlKey ? Math.min(10, Math.max(-10, e.deltaY)) : e.deltaY // pinch deltas spike on some trackpads
      const zoom = Math.min(200, Math.max(0.05, view.zoom * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002))))
      const f = zoom / view.zoom
      setView({ zoom, panX: cx - (cx - view.panX) * f, panY: cy - (cy - view.panY) * f })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (isTyping(e.target)) return
    const st = useAppStore.getState()
    if (drag) {
      if (e.key !== 'Escape') return
      if (drag.kind === 'transform') st.cancelTransient()
      setDrag(null)
      e.preventDefault()
      return
    }
    const mod = e.metaKey || e.ctrlKey
    const key = e.key.toLowerCase()
    const editing = st.step === 'design'
    const step = e.shiftKey ? 10 : 1
    const arrows: Record<string, Point> = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, step], arrowdown: [0, -step] }
    if (key === ' ') {
      if (e.target instanceof Element && e.target.closest('button')) return
      setSpace(true)
    } else if (mod && key === 'z') st[e.shiftKey ? 'redo' : 'undo']()
    else if (mod && key === 'y') st.redo()
    else if (mod && key === 'd' && editing) st.duplicateSelected()
    else if ((key === 'delete' || key === 'backspace') && editing) st.deleteSelected()
    else if (key in arrows && !mod && editing) st.nudge(...arrows[key])
    else if (key === 'enter' && pen.length) finishPen(pen)
    else if (!mod && !e.altKey && key === 'g' && editing) st.setSnap({ on: !st.snap.on })
    else if (!mod && !e.altKey && keyTool[key] && editing) st.setTool(keyTool[key])
    else if (key === 'escape') {
      if (pen.length) setPen([])
      else st.setSelection([])
    } else return
    e.preventDefault()
  })

  useEffect(() => {
    const up = (e: KeyboardEvent) => e.key === ' ' && setSpace(false)
    const blur = () => setSpace(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    const st = useAppStore.getState()
    const raw = eventPoint(e)
    const p = snapPoint(raw, gridFor(e))
    if (e.button === 1 || (e.button === 0 && space)) {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      setDrag({ kind: 'pan', cx: e.clientX, cy: e.clientY, panX, panY })
      return
    }
    if (e.button !== 0) return
    // Simulate and Export only select: no drawing, moving or scaling.
    const design = step === 'design'
    if (design && tool === 'text') {
      const font = FONTS[0].id
      st.setTool('select')
      loadFont(font)
        .then(() => st.addShape(fitText({ id: newId(), type: 'text', name: 'Text', text: 'Text', font, size: 20, w: 0, h: 0, x: p[0], y: p[1], rotation: 0, ...DEFAULT_TEXT_LAYOUT })))
        .catch(console.error)
      return
    }
    if (design && tool === 'pen') {
      if (pen.length >= 3 && dist(raw, pen[0]) < CLOSE_PX / zoom) finishPen(pen, true)
      else setPen([...pen, p])
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    if (design && tool !== 'select') {
      setDrag({ kind: 'create', start: p, current: p, shift: e.shiftKey, keep: [] })
      return
    }
    const target = e.target as Element
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle')
    if (design && handle && frame) {
      st.beginTransient()
      const apply = handle === 'rotate' ? rotateFn(selected, frame, raw) : scaleFn(selected, frame, handle.split(',').map(Number) as Point)
      setDrag({ kind: 'transform', ids: selection, apply })
      return
    }
    const id = target.closest('[data-id]')?.getAttribute('data-id')
    if (!id) {
      if (!e.shiftKey) st.setSelection([])
      setDrag({ kind: 'marquee', start: raw, current: raw, shift: false, keep: e.shiftKey ? selection : [] })
      return
    }
    let ids = selection
    if (e.shiftKey) ids = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
    else if (!ids.includes(id)) ids = [id]
    st.setSelection(ids)
    if (!design || !ids.includes(id)) return
    const base = project.shapes.filter((s) => ids.includes(s.id))
    const bounds = base.map(shapeBounds)
    const corner: Point = [Math.min(...bounds.map((b) => b.minX)), Math.min(...bounds.map((b) => b.minY))]
    st.beginTransient()
    const apply = (q: Point, _shift: boolean, grid: number) => {
      let d: Point = [q[0] - raw[0], q[1] - raw[1]]
      // With snapping on, a click that jitters a pixel or two must not jump the selection onto the grid.
      if (grid) d = dist(q, raw) * zoom < 3 ? [0, 0] : snapDelta(corner, d, grid)
      return base.map((s) => ({ ...s, x: s.x + d[0], y: s.y + d[1] }))
    }
    setDrag({ kind: 'transform', ids, apply })
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = eventPoint(e)
    setCursor(p)
    if (!drag) {
      setHover(selecting ? ((e.target as Element).closest('[data-id]')?.getAttribute('data-id') ?? null) : null)
      return
    }
    if (drag.kind === 'pan') {
      useAppStore.getState().setView({ panX: drag.panX + e.clientX - drag.cx, panY: drag.panY + e.clientY - drag.cy })
    } else if (drag.kind === 'transform') {
      const next = new Map(drag.apply(p, e.shiftKey, gridFor(e)).map((s) => [s.id, s]))
      useAppStore.getState().updateShapes(drag.ids, (s) => next.get(s.id) ?? s)
    } else {
      setDrag({ ...drag, current: drag.kind === 'create' ? snapPoint(p, gridFor(e)) : p, shift: e.shiftKey })
    }
  }

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) return
    const st = useAppStore.getState()
    const p = eventPoint(e)
    if (drag.kind === 'transform') st.commit()
    if (drag.kind === 'marquee' && (p[0] !== drag.start[0] || p[1] !== drag.start[1])) {
      const box = rectBounds(drag.start, p)
      const hits = project.shapes.filter((s) => overlaps(box, shapeBounds(s))).map((s) => s.id)
      st.setSelection([...new Set([...drag.keep, ...hits])])
    }
    if (drag.kind === 'create' && tool !== 'select' && tool !== 'pen' && tool !== 'text') {
      const shape = makeShape(tool, drag.start, snapPoint(p, gridFor(e)), e.shiftKey, 3 / zoom, newId())
      if (shape) {
        st.addShape(shape)
        st.setTool('select')
      }
    }
    setDrag(null)
  }

  // Major lines every 50 mm or 1"; the minor grid is the snap grid while snapping (10 mm or 1/4" otherwise).
  // Lines under the major grid are harmless. Only the visible part is drawn, and not again on cursor-only renders.
  const [svgW, svgH] = svgSize
  const { minor, major } = useMemo(() => {
    const inch = units === 'in'
    const minorStep = snap.on ? nearestSnap(snap.size, units) : inch ? 6.35 : 10
    const area = { minX: -panX / zoom, maxX: (svgW - panX) / zoom, minY: (panY - svgH) / zoom, maxY: panY / zoom }
    return {
      minor: zoom * minorStep >= 6 ? gridPath(stock.w, stock.h, minorStep, area) : null,
      major: gridPath(stock.w, stock.h, inch ? 25.4 : 50, area),
    }
  }, [stock.w, stock.h, snap.on, snap.size, units, panX, panY, zoom, svgW, svgH])

  const preview =
    drag?.kind === 'create' && tool !== 'select' && tool !== 'pen' && tool !== 'text' ? makeShape(tool, drag.start, drag.current, drag.shift, 3 / zoom) : null
  const penPreview = pen.length && cursor ? [...pen, cursor] : pen
  const corner = toScreen([0, 0])
  const zero = toScreen([project.origin.x, project.origin.y])

  let overlay = null
  if (frame) {
    const { b } = frame
    const corners = ([[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]] as Point[]).map((c) => toWorld(frame, c))
    const top = toScreen(toWorld(frame, handleLocal(frame, [0, 1])))
    const r = (frame.rotation * Math.PI) / 180
    const rot: Point = [top[0] - Math.sin(r) * ROTATE_OFFSET, top[1] - Math.cos(r) * ROTATE_OFFSET]
    overlay = (
      <g className="selection-frame">
        <polygon points={pts(corners)} />
        {step === 'design' && (
          <>
            <line x1={top[0]} y1={top[1]} x2={rot[0]} y2={rot[1]} />
            <circle data-handle="rotate" className="handle rotate" cx={rot[0]} cy={rot[1]} r={HANDLE / 2 + 1} />
            {HANDLES.map((h) => {
              const [x, y] = toScreen(toWorld(frame, handleLocal(frame, h)))
              const cursor = !h[0] ? 'ns-resize' : !h[1] ? 'ew-resize' : h[0] * h[1] > 0 ? 'nesw-resize' : 'nwse-resize'
              return <rect key={h.join()} data-handle={h.join()} className="handle" style={{ cursor }} x={x - HANDLE / 2} y={y - HANDLE / 2} width={HANDLE} height={HANDLE} />
            })}
          </>
        )}
      </g>
    )
  }

  return (
    <section className="canvas2d">
      <div className="canvas-toolbar" role="toolbar" aria-label="Arrange">
        {ALIGNS.map(({ mode, label }) => (
          <button key={mode} className="icon-button" aria-label={label} title={label} disabled={!selection.length} onClick={() => useAppStore.getState().align(mode)}>
            {icons[mode]}
          </button>
        ))}
        <span className="toolbar-gap" />
        {cam && (
          <label className="toolbar-check">
            <input type="checkbox" checked={showRapids} onChange={(e) => setShowRapids(e.target.checked)} />
            Show rapids
          </label>
        )}
        {step === 'design' && (
          <>
            <button aria-pressed={snap.on} title="Snap to grid, anchored at the stock's bottom-left corner (G, hold Alt to bypass)" onClick={() => useAppStore.getState().setSnap({ on: !snap.on })}>
              Snap
            </button>
            <select className="snap-size" aria-label="Snap size" value={snapSize} onChange={(e) => useAppStore.getState().setSnap({ size: Number(e.target.value) })}>
              {SNAP_SIZES[units].map((o) => (
                <option key={o.mm} value={o.mm}>
                  {o.label}
                </option>
              ))}
            </select>
          </>
        )}
        <button onClick={() => fitTo(svgRef.current)}>Fit view</button>
        <output className="zoom" aria-label="Zoom">{Math.round((zoom / PX_PER_MM_AT_100) * 100)}%</output>
      </div>
      <svg
        ref={svgRef}
        className={`canvas-svg tool-${step === 'design' ? tool : 'select'}${space || drag?.kind === 'pan' ? ' panning' : ''}`}
        aria-label="Design canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        onDoubleClick={() => tool === 'pen' && finishPen(pen)}
        onAuxClick={(e) => e.preventDefault()}
      >
        <g transform={`translate(${panX} ${panY}) scale(${zoom} ${-zoom})`}>
          <rect className="material" width={stock.w} height={stock.h} />
          {minor !== null && <path className="grid-minor" d={minor} />}
          <path className="grid-major" d={major} />
          <rect className="material-edge" width={stock.w} height={stock.h} />
          {project.shapes.map((s) => {
            const polys = shapeToPolylines(s)
            const cls = selection.includes(s.id) ? 'selected' : hover === s.id ? 'hover' : ''
            const { cut } = s
            const current = planned?.shapes?.includes(s) && cut && tabsActive(cut, stock.thickness)
            const tabs = current ? planned!.ops.filter((o) => o.shapeId === s.id).flatMap((o) => o.tabs ?? []) : []
            return (
              <g key={s.id} data-id={s.id} data-cut={cut?.type ?? 'none'} data-side={cut?.type === 'outline' ? cut.side : undefined} className={`shape ${cls}`}>
                <path className="hit" d={pathD(polys)} />
                <path
                  d={pathD(polys)}
                  style={{
                    fill: polys.every((p) => p.closed) ? undefined : 'none',
                    fillOpacity: cut?.type === 'pocket' ? 0.1 + 0.7 * Math.min(1, cut.depth / stock.thickness) : undefined,
                    fillRule: s.fillRule,
                  }}
                />
                {tabs.map(({ x, y, angle, width }, i) => {
                  const [tx, ty] = [(Math.cos(angle) * width) / 2, (Math.sin(angle) * width) / 2]
                  return <path key={i} data-tab className="tab" opacity={camBusy ? 0.4 : undefined} d={`M${x - tx} ${y - ty}L${x + tx} ${y + ty}`} />
                })}
              </g>
            )
          })}
          {step === 'design' && (
            <path
              className="side-arrows"
              d={project.shapes
                .map((s) => (s.cut?.type === 'outline' && s.cut.side !== 'on' ? sideArrow(shapeToPolylines(s), s.cut.side === 'outside', 14 / zoom) : ''))
                .join('')}
            />
          )}
          {[toolpaths, hlPaths].map(
            (d, i) =>
              d && (
                <g key={i} className={i ? 'toolpaths highlight' : hlPaths ? 'toolpaths dimmed' : 'toolpaths'}>
                  {showRapids && <path className="toolpath-rapid" d={d.rapid} />}
                  <path className="toolpath-rough" d={d.rough} />
                  <path className="toolpath-detail" d={d.detail} />
                  <path className="toolpath-vcarve" d={d.vcarve} />
                </g>
              ),
          )}
          {preview && <path className="preview" d={pathD(shapeToPolylines(preview))} />}
          {penPreview.length > 1 && <path className="preview" fill="none" d={pathD([{ points: penPreview, closed: false }])} />}
        </g>
        <path className="corner-tick" d={`M${corner[0]} ${corner[1]}h8M${corner[0]} ${corner[1]}v-8`} />
        <g className="origin">
          <path className="axis-x" d={`M${zero[0]} ${zero[1]}h24`} />
          <path className="axis-y" d={`M${zero[0]} ${zero[1]}v-24`} />
          <circle cx={zero[0]} cy={zero[1]} r={3} />
        </g>
        {pen.length > 0 && <circle className="pen-start" cx={toScreen(pen[0])[0]} cy={toScreen(pen[0])[1]} r={CLOSE_PX / 2} />}
        {drag?.kind === 'marquee' && (
          <polygon className="marquee" points={pts([drag.start, [drag.current[0], drag.start[1]], drag.current, [drag.start[0], drag.current[1]]])} />
        )}
        {overlay}
      </svg>
      <div className="canvas-status" aria-live="off">
        {cursor ? `X ${formatLength(cursor[0] - project.origin.x, units)}  Y ${formatLength(cursor[1] - project.origin.y, units)} ${units}` : ' '}
        {status && (
          <span className="status-error" role="alert">
            {status}
          </span>
        )}
      </div>
    </section>
  )
}
