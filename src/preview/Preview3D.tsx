import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Op, Pt3 } from '../cam/toolpath'
import { effectiveBit } from '../lib/library'
import type { Bit } from '../model'
import { useAppStore } from '../store'
import PlaybackBar from './PlaybackBar'
import type { SurfaceMesh } from './sim'
import { fracAt, moveAt, positionAt, timelineFor, type Timeline } from './timeline'
import { onProgress, requestProgress, useSim } from './useSim'

// Model → three: X → x, Y → −z, Z → y (three is Y-up with Z toward the viewer). The surface mesh is built in the sim worker.
const SIDES = 0xd8bd92
const LINE_COLORS = { rough: 0x2563eb, detail: 0x9333ea, vcarve: 0xea580c } // as the 2D overlay
const LINE_LIFT = 0.05 // mm, keeps toolpath lines out of the cut floor
const VIEW_DIR: [number, number, number] = [-0.5, 0.9, 1] // front-left-top
const CUTTER_LEN = 20 // mm, tool model
const SHANK_LEN = 15

interface View {
  T: typeof THREE
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  render: () => void
  materials: Record<'surface' | 'sides' | 'hidden' | 'lines' | 'linesDim' | 'cutter' | 'shank', THREE.Material>
  radius: number // of the stock's bounding sphere, for framing
  bar: number // px of canvas covered by the playback bar
  // The user moved the camera since the last frame(). Until then every resize re-frames, so a frame() made while the
  // preview was hidden or mid-transition (a tiny canvas) is redone at the real size; after that resizes keep their view.
  moved: boolean
}

const PLAYBACK_H = 64 // --playback-h in styles.css

// Fits the projection to the canvas part above the playback bar: the view centres there and the canvas strip under
// the bar shows extra scene, so the stock's front edge isn't hidden behind it.
function project(view: View) {
  const { camera, renderer } = view
  const { x: w, y: h } = renderer.getSize(new view.T.Vector2())
  if (!w || !h) return
  const above = Math.max(1, h - view.bar)
  camera.aspect = w / above
  if (view.bar) camera.setViewOffset(w, above, 0, 0, w, h)
  else camera.clearViewOffset()
  camera.updateProjectionMatrix()
}

// Looks at the stock centre from VIEW_DIR, far enough back that its bounding sphere fits the view.
let framing = false // set while frame() moves the camera, so its 'change' event isn't taken for the user's

function frame(view: View) {
  const { T, camera, controls } = view
  project(view)
  const vfov = (camera.fov * Math.PI) / 180
  const fov = Math.min(vfov, 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect))
  const dir = new T.Vector3(...VIEW_DIR).normalize()
  camera.position.copy(controls.target).addScaledVector(dir, (view.radius / Math.sin(fov / 2)) * 1.05)
  framing = true
  controls.update()
  framing = false
  view.moved = false
}

function surfaceGeometry(T: typeof THREE, mesh: SurfaceMesh) {
  const g = new T.BufferGeometry()
  g.setAttribute('position', new T.BufferAttribute(mesh.positions, 3))
  g.setAttribute('normal', new T.BufferAttribute(mesh.normals, 3))
  g.setAttribute('color', new T.BufferAttribute(mesh.colors, 3))
  g.setIndex(new T.BufferAttribute(mesh.index, 1))
  return g
}

// Feed moves as line segments in timeline order. starts[i] counts the segments before move i, so the part already
// travelled is a draw range.
function toolpathGeometry(T: typeof THREE, tl: Timeline, ops: Op[]) {
  const pos: number[] = []
  const col: number[] = []
  const colors = { rough: new T.Color(LINE_COLORS.rough), detail: new T.Color(LINE_COLORS.detail), vcarve: new T.Color(LINE_COLORS.vcarve) }
  const starts = new Uint32Array(tl.moves.length + 1)
  tl.moves.forEach(({ a, b, cut, op, role }, i) => {
    starts[i + 1] = starts[i] + (cut ? 1 : 0)
    if (!cut) return
    pos.push(a[0], a[2] + LINE_LIFT, -a[1], b[0], b[2] + LINE_LIFT, -b[1])
    const { r, g, b: bl } = colors[ops[op].kind === 'vcarve' ? 'vcarve' : role]
    col.push(r, g, bl, r, g, bl)
  })
  const g = new T.BufferGeometry()
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new T.Float32BufferAttribute(col, 3))
  return { g, starts }
}

// Tip at the origin: endmill = cylinder, ballnose = cylinder on a half sphere, V-bit = cone of the bit's angle; plus a shank.
function toolModel(T: typeof THREE, bit: Bit, m: View['materials']) {
  const group = new T.Group()
  const add = (geo: THREE.BufferGeometry, y: number, mat = m.cutter) => {
    const mesh = new T.Mesh(geo, mat)
    mesh.position.y = y
    group.add(mesh)
  }
  const r = bit.diameter / 2
  let top = CUTTER_LEN
  if (bit.type === 'vbit') {
    const flat = Math.min(r, (bit.flat ?? 0) / 2)
    top = Math.max(0.1, (r - flat) / Math.tan(((bit.angle ?? 90) * Math.PI) / 360))
    add(new T.CylinderGeometry(r, flat, top, 32), top / 2)
  } else if (bit.type === 'ballnose') {
    add(new T.SphereGeometry(r, 24, 12, 0, 2 * Math.PI, Math.PI / 2, Math.PI / 2), r)
    add(new T.CylinderGeometry(r, r, CUTTER_LEN - r, 32, 1, true), (CUTTER_LEN + r) / 2)
  } else add(new T.CylinderGeometry(r, r, CUTTER_LEN, 32), CUTTER_LEN / 2)
  const sr = Math.min(r, 3.175)
  add(new T.CylinderGeometry(sr, sr, SHANK_LEN, 24), top + SHANK_LEN / 2, m.shank)
  return group
}

// Replaces a named object in the scene, disposing the old one's geometry.
function replace(view: View, name: string, obj: THREE.Object3D | null) {
  const old = view.scene.getObjectByName(name)
  if (old) {
    view.scene.remove(old)
    old.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
  }
  if (obj) view.scene.add(Object.assign(obj, { name }))
  return obj
}

async function createView(host: HTMLElement): Promise<View> {
  const [T, { OrbitControls }] = await Promise.all([import('three'), import('three/examples/jsm/controls/OrbitControls.js')])
  const renderer = new T.WebGLRenderer({ antialias: true }) // throws without WebGL
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
  renderer.setClearColor(0xeceef1)
  const canvas = renderer.domElement
  canvas.setAttribute('aria-label', '3D carve preview')
  canvas.setAttribute('role', 'img')
  canvas.tabIndex = 0
  host.appendChild(canvas)
  const scene = new T.Scene()
  scene.add(new T.HemisphereLight(0xffffff, 0x8a7a66, 1.6))
  const sun = new T.DirectionalLight(0xffffff, 1.8)
  sun.position.set(-1, 3, 2)
  scene.add(sun)
  const camera = new T.PerspectiveCamera(35, 1, 1, 10000)
  const controls = new OrbitControls(camera, canvas)
  controls.listenToKeyEvents(canvas) // arrow keys pan while the canvas has focus…
  canvas.addEventListener('keydown', (e) => e.key.startsWith('Arrow') && e.stopPropagation()) // …instead of nudging shapes
  const materials = {
    surface: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
    sides: new T.MeshStandardMaterial({ color: SIDES, roughness: 0.9 }),
    hidden: new T.MeshBasicMaterial({ visible: false }),
    lines: new T.LineBasicMaterial({ vertexColors: true }),
    linesDim: new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35 }),
    cutter: new T.MeshStandardMaterial({ color: 0x0ea5e9, transparent: true, opacity: 0.55, depthWrite: false, roughness: 0.4 }),
    shank: new T.MeshStandardMaterial({ color: 0x9ca3af, transparent: true, opacity: 0.8, metalness: 0.5, roughness: 0.4 }),
  }
  const view: View = { T, renderer, scene, camera, controls, render: () => {}, materials, radius: 0, bar: 0, moved: false }
  // data-view-distance (camera distance / stock radius) lets tests check the framing.
  view.render = () => {
    renderer.render(scene, camera)
    canvas.dataset.viewDistance = (camera.position.distanceTo(controls.target) / (view.radius || 1)).toFixed(3)
  }
  controls.addEventListener('change', view.render)
  controls.addEventListener('change', () => (view.moved ||= !framing)) // drags, the wheel and arrow-key panning
  return view
}

export default function Preview3D() {
  useSim()
  const sim = useAppStore((s) => s.sim)
  const busy = useAppStore((s) => s.simBusy)
  const cam = useAppStore((s) => s.cam)
  const stock = useAppStore((s) => s.project.stock)
  const origin = useAppStore((s) => s.project.origin)
  const step = useAppStore((s) => s.step)
  const settings = useAppStore((s) => s.project.cutSettings)
  const bits = useAppStore((s) => s.project.bits)
  const bitOverrides = useAppStore((s) => s.project.bitOverrides)
  const playing = useAppStore((s) => s.anim.playing)
  const tl = useMemo(() => (cam ? timelineFor(cam.ops, settings) : null), [cam, settings])
  const [showLines, setShowLines] = useState(true)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const viewRef = useRef<View | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  // Animation state read by the frame loop; t lives here and is mirrored to the store at ~10 Hz.
  const tRef = useRef(0)
  const tlRef = useRef<Timeline | null>(null)
  const objs = useRef<{
    tool?: THREE.Object3D | null
    lines?: { bright: THREE.LineSegments; dim: THREE.LineSegments; starts: Uint32Array }
    surface?: THREE.Object3D | null
    progress?: THREE.Object3D | null
    idx: number // move the highlight was split at
  }>({ idx: -1 })
  const tip = useRef<Pt3>([0, 0, 0])
  // sync draws at most once per frame: one change fans out to several effects (lines, tool, timeline, surface), and
  // a synchronous draw each is costly with a million-triangle surface (seconds in software WebGL).
  const drawFrame = useRef(0)
  useEffect(() => () => cancelAnimationFrame(drawFrame.current), [])

  // Puts the tool, the travelled path and the removed material at tRef, all from the same timeline index.
  const sync = useCallback(() => {
    const view = viewRef.current
    if (!view) return
    const { anim, step } = useAppStore.getState()
    const o = objs.current
    const tl = tlRef.current
    const t = tRef.current
    const idx = tl?.moves.length ? moveAt(tl, t) : -1
    const atEnd = !tl || t >= tl.total
    if (o.tool) {
      o.tool.visible = idx >= 0
      if (tl && idx >= 0) {
        const [x, y, z] = positionAt(tl, t, tip.current)
        o.tool.position.set(x, z, -y)
        const role = tl.moves[idx].role
        for (const c of o.tool.children) c.visible = c.name === role
      }
    }
    const canvas = view.renderer.domElement
    const shown = o.tool?.visible ? 'true' : 'false' // for tests
    if (canvas.dataset.toolVisible !== shown) canvas.dataset.toolVisible = shown
    if (o.lines && (idx !== o.idx || atEnd)) {
      const { bright, dim, starts } = o.lines
      const done = 2 * (atEnd ? starts[starts.length - 1] : starts[Math.max(0, idx)])
      bright.geometry.setDrawRange(0, done)
      dim.geometry.setDrawRange(done, Infinity)
    }
    o.idx = idx
    const progressive = step === 'simulate' && anim.removal && idx >= 0 && !(atEnd && !anim.playing)
    if (progressive) requestProgress(idx, fracAt(tl!.moves[idx], t))
    else requestProgress(-1, 0)
    const showProgress = progressive && !!o.progress
    if (o.progress) o.progress.visible = showProgress
    if (o.surface) o.surface.visible = !showProgress
    drawFrame.current ||= requestAnimationFrame(() => {
      drawFrame.current = 0
      viewRef.current?.render()
    })
  }, [])

  useEffect(() => {
    const host = hostRef.current!
    let cancelled = false
    let cleanup = () => {}
    createView(host).then(
      (v) => {
        if (cancelled) {
          v.renderer.dispose()
          v.renderer.forceContextLoss()
          v.renderer.domElement.remove()
          return
        }
        const { renderer, scene, controls, materials } = v
        // A hidden preview (0×0 on the Settings step) is left alone; see View.moved for when a resize re-frames.
        const resize = () => {
          const { clientWidth: w, clientHeight: h } = host
          if (!w || !h) return
          renderer.setSize(w, h, false)
          if (v.moved) project(v)
          else frame(v)
          v.render()
        }
        resize()
        const ro = new ResizeObserver(resize)
        ro.observe(host)
        viewRef.current = v
        setReady(true)
        cleanup = () => {
          viewRef.current = null
          ro.disconnect()
          controls.dispose()
          scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
          Object.values(materials).forEach((m) => m.dispose())
          renderer.dispose()
          renderer.forceContextLoss()
          renderer.domElement.remove()
        }
      },
      (e) => {
        console.error('3D preview failed', e)
        if (!cancelled) setFailed(true)
      },
    )
    return () => {
      cancelled = true
      cleanup()
    }
  }, [])

  // A new timeline starts at its end, showing the finished job (declared first so the effects below see it).
  useEffect(() => {
    tlRef.current = tl
    useAppStore.getState().setAnim({ t: tl?.total ?? 0, playing: false })
  }, [tl])

  // Stock box (sides and bottom; the top is the simulated surface) and the initial view.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const { T, controls, materials: m } = view
    const { w, h, thickness: t } = stock
    const box = new T.Mesh(new T.BoxGeometry(w, t, h), [m.sides, m.sides, m.hidden, m.sides, m.sides, m.sides])
    box.position.set(w / 2, -t / 2, -h / 2)
    replace(view, 'stock', box)
    controls.target.set(w / 2, -t / 2, -h / 2)
    view.radius = Math.hypot(w, h, t) / 2
    frame(view)
    view.render()
  }, [ready, stock])

  // Work-zero gizmo (X red, Y green, Z blue). Scene axes: x = stock X, y = up, -z = stock Y; drawn over the stock.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const axes = new view.T.AxesHelper(15)
    const material = axes.material as THREE.Material
    material.depthTest = false
    axes.rotation.x = -Math.PI / 2
    axes.position.set(origin.x, origin.z === 'bottom' ? -stock.thickness : 0, -origin.y)
    axes.renderOrder = 10
    replace(view, 'zero', axes)
    view.render()
    return () => material.dispose()
  }, [ready, stock, origin])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    objs.current.surface = replace(view, 'surface', sim?.mesh ? new view.T.Mesh(surfaceGeometry(view.T, sim.mesh), view.materials.surface) : null)
    sync()
  }, [ready, sim, sync])

  // Progressive removal: one persistent geometry per job; each update rewrites only the rows that changed.
  useEffect(() => {
    onProgress((u) => {
      const view = viewRef.current
      if (!view) return false
      if (u.index) {
        const mesh = new view.T.Mesh(surfaceGeometry(view.T, u as SurfaceMesh), view.materials.surface)
        mesh.frustumCulled = false // the bounding sphere of the flat start would go stale
        objs.current.progress = replace(view, 'progress', mesh)
      } else if (u.positions) {
        const geometry = (objs.current.progress as THREE.Mesh | null | undefined)?.geometry
        const off = u.r0 * u.width * 3
        const attrs = geometry && (['position', 'normal', 'color'] as const).map((n) => geometry.getAttribute(n) as THREE.BufferAttribute)
        if (!attrs || off + u.positions.length > attrs[0].array.length) return false
        ;[u.positions, u.normals!, u.colors!].forEach((data, k) => {
          ;(attrs[k].array as Float32Array).set(data, off)
          attrs[k].addUpdateRange(off, data.length)
          attrs[k].needsUpdate = true
        })
      } else if (!objs.current.progress) return false
      sync()
      return true
    })
    return () => onProgress(null)
  }, [sync])

  const linesOn = step === 'simulate' && showLines
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const { T, materials: m } = view
    let lines
    if (linesOn && cam && tl) {
      const { g, starts } = toolpathGeometry(T, tl, cam.ops)
      const dimG = new T.BufferGeometry() // same buffers, its own draw range
      dimG.setAttribute('position', g.getAttribute('position'))
      dimG.setAttribute('color', g.getAttribute('color'))
      lines = { bright: new T.LineSegments(g, m.lines), dim: new T.LineSegments(dimG, m.linesDim), starts }
    }
    replace(view, 'toolpaths', lines ? new T.Group().add(lines.bright, lines.dim) : null)
    objs.current.lines = lines
    objs.current.idx = -1
    sync()
  }, [ready, cam, tl, linesOn, sync])

  // One tool model per bit; sync shows the one for the current move's role.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    let tool = null
    if (step === 'simulate' && tl?.moves.length) {
      tool = new view.T.Group()
      for (const role of ['rough', 'detail'] as const) {
        if (bits[role]) tool.add(Object.assign(toolModel(view.T, effectiveBit({ bits, bitOverrides }, role), view.materials), { name: role }))
      }
    }
    objs.current.tool = replace(view, 'tool', tool)
    sync()
  }, [ready, tl, step, bits, bitOverrides, sync])

  useEffect(() => {
    if (step !== 'simulate') useAppStore.getState().setAnim({ playing: false })
  }, [step])

  // Scrubbing and toggles come through the store; the frame loop's own mirroring leaves t as it is.
  useEffect(
    () =>
      useAppStore.subscribe((s, p) => {
        if (s.anim === p.anim && s.step === p.step) return
        if (s.anim.t !== p.anim.t) tRef.current = s.anim.t
        sync()
      }),
    [sync],
  )

  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    let mirrored = last
    const frame = (now: number) => {
      const { anim, setAnim } = useAppStore.getState()
      const total = tlRef.current?.total ?? 0
      tRef.current = Math.min(total, tRef.current + (Math.max(0, now - last) / 1000) * anim.speed)
      last = now
      if (tRef.current >= total) return setAnim({ t: total, playing: false })
      sync()
      if (now - mirrored >= 100) {
        mirrored = now
        setAnim({ t: tRef.current })
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [playing, sync])

  const playback = step === 'simulate' && !!tl?.moves.length
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.bar = playback ? PLAYBACK_H : 0
    project(view)
    view.render()
  }, [ready, playback])

  const resetView = () => {
    const view = viewRef.current
    if (!view) return
    const { w, h, thickness: t } = stock
    view.controls.target.set(w / 2, -t / 2, -h / 2)
    frame(view)
    view.render()
  }

  return (
    <section className={playback ? 'preview3d has-playback' : 'preview3d'} aria-label="3D preview">
      <div ref={hostRef} className="preview3d-host" />
      {failed ? (
        <p className="preview3d-error">3D preview unavailable (WebGL not supported)</p>
      ) : (
        <button className="preview3d-reset" onClick={resetView} disabled={!ready}>
          Reset view
        </button>
      )}
      <span className="preview3d-busy" aria-live="polite">
        {busy && !failed ? 'Simulating…' : ''}
      </span>
      {step === 'simulate' && !failed && (
        <div className="preview3d-legend">
          <label>
            <input type="checkbox" checked={showLines} onChange={(e) => setShowLines(e.target.checked)} />
            Show toolpaths
          </label>
          <span className="swatch rough">Rough</span>
          <span className="swatch detail">Detail</span>
          <span className="swatch vcarve">V-carve</span>
        </div>
      )}
      {playback && cam ? <PlaybackBar tl={tl} ops={cam.ops} /> : null}
    </section>
  )
}
