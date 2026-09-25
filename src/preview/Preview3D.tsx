import { useEffect, useRef, useState } from 'react'
import type * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Op } from '../cam/toolpath'
import { useAppStore } from '../store'
import type { SurfaceMesh } from './sim'
import { useSim } from './useSim'

// Model → three: X → x, Y → −z, Z → y (three is Y-up with Z toward the viewer). The surface mesh is built in the sim worker.
const SIDES = 0xd8bd92
const LINE_COLORS = { rough: 0x2563eb, detail: 0x9333ea, vcarve: 0xea580c } // as the 2D overlay
const LINE_LIFT = 0.05 // mm, keeps toolpath lines out of the cut floor
const VIEW_DIR: [number, number, number] = [-0.5, 0.9, 1] // front-left-top

interface View {
  T: typeof THREE
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  render: () => void
  materials: Record<'surface' | 'sides' | 'hidden' | 'lines', THREE.Material>
  radius: number // of the stock's bounding sphere, for framing
}

// Looks at the stock centre from VIEW_DIR, far enough back that its bounding sphere fits the view.
function frame(view: View) {
  const { T, camera, controls } = view
  const vfov = (camera.fov * Math.PI) / 180
  const fov = Math.min(vfov, 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect))
  const dir = new T.Vector3(...VIEW_DIR).normalize()
  camera.position.copy(controls.target).addScaledVector(dir, (view.radius / Math.sin(fov / 2)) * 1.05)
  controls.update()
}

function surfaceGeometry(T: typeof THREE, mesh: SurfaceMesh) {
  const g = new T.BufferGeometry()
  g.setAttribute('position', new T.BufferAttribute(mesh.positions, 3))
  g.setAttribute('normal', new T.BufferAttribute(mesh.normals, 3))
  g.setAttribute('color', new T.BufferAttribute(mesh.colors, 3))
  g.setIndex(new T.BufferAttribute(mesh.index, 1))
  return g
}

function toolpathGeometry(T: typeof THREE, ops: Op[]) {
  const pos: number[] = []
  const col: number[] = []
  const colors = { rough: new T.Color(LINE_COLORS.rough), detail: new T.Color(LINE_COLORS.detail), vcarve: new T.Color(LINE_COLORS.vcarve) }
  let prev: number[] | null = null
  for (const op of ops)
    for (const seg of op.segments)
      for (const [x, y, z] of seg.points) {
        const p = [x, z + LINE_LIFT, -y]
        if (prev && !seg.rapid) {
          pos.push(...prev, ...p)
          const { r, g, b } = colors[op.kind === 'vcarve' ? 'vcarve' : op.role]
          col.push(r, g, b, r, g, b)
        }
        prev = p
      }
  const g = new T.BufferGeometry()
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new T.Float32BufferAttribute(col, 3))
  return g
}

// Replaces a named object in the scene, disposing the old one's geometry.
function replace(view: View, name: string, obj: THREE.Object3D | null) {
  const old = view.scene.getObjectByName(name) as THREE.Mesh | undefined
  if (old) {
    view.scene.remove(old)
    old.geometry.dispose()
  }
  if (obj) view.scene.add(Object.assign(obj, { name }))
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
  }
  const render = () => renderer.render(scene, camera)
  controls.addEventListener('change', render)
  return { T, renderer, scene, camera, controls, render, materials, radius: 0 }
}

export default function Preview3D() {
  useSim()
  const sim = useAppStore((s) => s.sim)
  const busy = useAppStore((s) => s.simBusy)
  const cam = useAppStore((s) => s.cam)
  const stock = useAppStore((s) => s.project.stock)
  const step = useAppStore((s) => s.step)
  const [showLines, setShowLines] = useState(true)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const viewRef = useRef<View | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)

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
        const { renderer, camera, scene, controls, materials } = v
        const resize = () => {
          const { clientWidth: w, clientHeight: h } = host
          if (!w || !h) return
          renderer.setSize(w, h, false)
          camera.aspect = w / h
          camera.updateProjectionMatrix()
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

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    replace(view, 'surface', sim?.mesh ? new view.T.Mesh(surfaceGeometry(view.T, sim.mesh), view.materials.surface) : null)
    view.render()
  }, [ready, sim])

  const linesOn = step === 'simulate' && showLines
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    replace(view, 'toolpaths', linesOn && cam ? new view.T.LineSegments(toolpathGeometry(view.T, cam.ops), view.materials.lines) : null)
    view.render()
  }, [ready, cam, linesOn])

  const resetView = () => {
    const view = viewRef.current
    if (!view) return
    const { w, h, thickness: t } = stock
    view.controls.target.set(w / 2, -t / 2, -h / 2)
    frame(view)
    view.render()
  }

  return (
    <section className="preview3d" aria-label="3D preview">
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
    </section>
  )
}
