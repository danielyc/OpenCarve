import { useEffect, useRef, useState } from 'react'
import type * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Op } from '../cam/toolpath'
import type { Project } from '../model'
import { useAppStore } from '../store'
import type { SimResult } from './sim'
import { useSim } from './useSim'

// Model → three: X → x, Y → −z, Z → y (three is Y-up with Z toward the viewer).
const UNCUT = 0xecd6b0
const CUT = 0xb48a58
const SIDES = 0xd8bd92
const LINE_COLORS = { rough: 0x2563eb, detail: 0x9333ea }
const LINE_LIFT = 0.05 // mm, keeps toolpath lines out of the cut floor

interface View {
  T: typeof THREE
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  render: () => void
  radius: number // of the stock's bounding sphere, for framing
}

// Moves the camera along dir (from the target) until the stock's bounding sphere fits the view.
function frame(view: View, dir: THREE.Vector3) {
  const { camera, controls } = view
  const vfov = (camera.fov * Math.PI) / 180
  const fov = Math.min(vfov, 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect))
  camera.position.copy(controls.target).addScaledVector(dir.normalize(), (view.radius / Math.sin(fov / 2)) * 1.05)
  controls.update()
}

function surfaceGeometry(T: typeof THREE, sim: SimResult, stock: Project['stock']) {
  const { width: W, height: H, cellSize: c, heights } = sim
  const pos = new Float32Array(W * H * 3)
  const col = new Float32Array(W * H * 3)
  const [uncut, cut, tmp] = [new T.Color(UNCUT), new T.Color(CUT), new T.Color()]
  for (let j = 0, k = 0; j < H; j++)
    for (let i = 0; i < W; i++, k++) {
      const h = heights[k]
      pos[k * 3] = Math.min(i * c, stock.w)
      pos[k * 3 + 1] = h
      pos[k * 3 + 2] = -Math.min(j * c, stock.h)
      if (h < -0.01) tmp.lerpColors(uncut, cut, 0.4 + (0.6 * -h) / stock.thickness).toArray(col, k * 3)
      else uncut.toArray(col, k * 3)
    }
  // Two triangles per cell, facing up; cells cut right through are left out so through cuts show as holes.
  const through = -stock.thickness + 1e-3
  const index = new Uint32Array((W - 1) * (H - 1) * 6)
  let n = 0
  const tri = (a: number, b: number, d: number) => {
    if (heights[a] > through || heights[b] > through || heights[d] > through) {
      index[n++] = a
      index[n++] = b
      index[n++] = d
    }
  }
  for (let j = 0; j < H - 1; j++)
    for (let i = 0; i < W - 1; i++) {
      const a = j * W + i
      tri(a, a + 1, a + W)
      tri(a + 1, a + W + 1, a + W)
    }
  const g = new T.BufferGeometry()
  g.setAttribute('position', new T.BufferAttribute(pos, 3))
  g.setAttribute('color', new T.BufferAttribute(col, 3))
  g.setIndex(new T.BufferAttribute(index.subarray(0, n), 1))
  g.computeVertexNormals()
  return g
}

function toolpathGeometry(T: typeof THREE, ops: Op[]) {
  const pos: number[] = []
  const col: number[] = []
  const colors = { rough: new T.Color(LINE_COLORS.rough), detail: new T.Color(LINE_COLORS.detail) }
  let prev: number[] | null = null
  for (const op of ops)
    for (const seg of op.segments)
      for (const [x, y, z] of seg.points) {
        const p = [x, z + LINE_LIFT, -y]
        if (prev && !seg.rapid) {
          pos.push(...prev, ...p)
          const { r, g, b } = colors[op.role]
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

export default function Preview3D() {
  useSim()
  const sim = useAppStore((s) => s.sim)
  const busy = useAppStore((s) => s.simBusy)
  const cam = useAppStore((s) => s.cam)
  const stock = useAppStore((s) => s.project.stock)
  const step = useAppStore((s) => s.step)
  const [showLines, setShowLines] = useState(true)
  const viewRef = useRef<View | null>(null)
  const [ready, setReady] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const materials = useRef<Record<string, THREE.Material>>({})

  useEffect(() => {
    const host = hostRef.current!
    let cancelled = false
    let cleanup = () => {}
    void Promise.all([import('three'), import('three/examples/jsm/controls/OrbitControls.js')]).then(([T, { OrbitControls }]) => {
      if (cancelled) return
      const renderer = new T.WebGLRenderer({ antialias: true })
      renderer.setPixelRatio(window.devicePixelRatio)
      renderer.setClearColor(0xeceef1)
      renderer.domElement.setAttribute('aria-label', '3D carve preview')
      renderer.domElement.setAttribute('role', 'img')
      host.appendChild(renderer.domElement)
      const scene = new T.Scene()
      scene.add(new T.HemisphereLight(0xffffff, 0x8a7a66, 1.6))
      const sun = new T.DirectionalLight(0xffffff, 1.8)
      sun.position.set(-1, 3, 2)
      scene.add(sun)
      const camera = new T.PerspectiveCamera(35, 1, 1, 10000)
      const controls = new OrbitControls(camera, renderer.domElement)
      const render = () => renderer.render(scene, camera)
      controls.addEventListener('change', render)
      const v: View = { T, renderer, scene, camera, controls, render, radius: 0 }
      const ro = new ResizeObserver(() => {
        const { clientWidth: w, clientHeight: h } = host
        if (!w || !h) return
        renderer.setSize(w, h, false)
        camera.aspect = w / h
        camera.updateProjectionMatrix()
        if (v.radius) frame(v, camera.position.clone().sub(controls.target))
        render()
      })
      ro.observe(host)
      const m = materials.current
      m.surface = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 })
      m.sides = new T.MeshStandardMaterial({ color: SIDES, roughness: 0.9 })
      m.hidden = new T.MeshBasicMaterial({ visible: false })
      m.lines = new T.LineBasicMaterial({ vertexColors: true })
      viewRef.current = v
      setReady(true)
      cleanup = () => {
        viewRef.current = null
        ro.disconnect()
        controls.dispose()
        scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
        Object.values(m).forEach((mat) => mat.dispose())
        renderer.dispose()
        renderer.domElement.remove()
      }
    })
    return () => {
      cancelled = true
      cleanup()
    }
  }, [])

  // Stock box (sides and bottom; the top is the simulated surface) and an isometric-ish view from front-left-top.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const { T, controls } = view
    const { w, h, thickness: t } = stock
    const m = materials.current
    const box = new T.Mesh(new T.BoxGeometry(w, t, h), [m.sides, m.sides, m.hidden, m.sides, m.sides, m.sides])
    box.position.set(w / 2, -t / 2, -h / 2)
    replace(view, 'stock', box)
    controls.target.set(w / 2, -t / 2, -h / 2)
    view.radius = Math.hypot(w, h, t) / 2
    frame(view, new T.Vector3(-0.5, 0.9, 1))
    view.render()
  }, [ready, stock])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const { T } = view
    replace(view, 'surface', sim && new T.Mesh(surfaceGeometry(T, sim, stock), materials.current.surface))
    view.render()
    // stock is read for scale only; the surface follows each new simulation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, sim])

  const linesOn = step === 'simulate' && showLines
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const { T } = view
    replace(view, 'toolpaths', linesOn && cam ? new T.LineSegments(toolpathGeometry(T, cam.ops), materials.current.lines) : null)
    view.render()
  }, [ready, cam, linesOn])

  return (
    <section className="preview3d" aria-label="3D preview">
      <div ref={hostRef} className="preview3d-host" />
      {busy && <span className="preview3d-busy">Simulating…</span>}
      {step === 'simulate' && (
        <div className="preview3d-legend">
          <label>
            <input type="checkbox" checked={showLines} onChange={(e) => setShowLines(e.target.checked)} />
            Show toolpaths
          </label>
          <span className="swatch rough">Rough</span>
          <span className="swatch detail">Detail</span>
        </div>
      )}
    </section>
  )
}
