import type { SimResult, SurfaceMesh } from './sim'

// Model → three: X → x, Y → −z, Z → y (three is Y-up with Z toward the viewer).
export const UNCUT = 0xecd6b0
export const CUT = 0xb48a58

// three.js vertex colours are linear; these are sRGB hex.
const linear = (hex: number) =>
  [16, 8, 0].map((sh) => {
    const c = ((hex >> sh) & 255) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })

type Grid = Pick<SimResult, 'width' | 'height' | 'cellSize' | 'heights' | 'stock'>

export function surfaceMesh(r: SimResult): SurfaceMesh {
  return { ...surfaceRows(r, 0, r.height - 1), index: surfaceIndex(r, true) }
}

// Vertex attributes for grid rows r0..r1 (inclusive), heights clamped to the stock bottom.
export function surfaceRows({ width: W, height: H, cellSize: c, heights: raw, stock }: Grid, r0: number, r1: number) {
  const n = (r1 - r0 + 1) * W * 3
  const positions = new Float32Array(n)
  const normals = new Float32Array(n)
  const colors = new Float32Array(n)
  const [uncut, cut] = [linear(UNCUT), linear(CUT)]
  const floor = -stock.thickness
  const heights = (k: number) => Math.max(raw[k], floor)
  for (let j = r0, k = r0 * W; j <= r1; j++)
    for (let i = 0; i < W; i++, k++) {
      const h = heights(k)
      const o = (k - r0 * W) * 3
      positions[o] = Math.min(i * c, stock.w)
      positions[o + 1] = h
      positions[o + 2] = -Math.min(j * c, stock.h)
      // Central differences (one-sided at the border); the height field y = h(x, −z) has normal (−∂h/∂x, 1, ∂h/∂Y).
      const [i0, i1, j0, j1] = [Math.max(0, i - 1), Math.min(W - 1, i + 1), Math.max(0, j - 1), Math.min(H - 1, j + 1)]
      const dx = (heights(j * W + i1) - heights(j * W + i0)) / ((i1 - i0) * c || 1)
      const dy = (heights(j1 * W + i) - heights(j0 * W + i)) / ((j1 - j0) * c || 1)
      const len = Math.hypot(dx, 1, dy)
      normals[o] = -dx / len
      normals[o + 1] = 1 / len
      normals[o + 2] = dy / len
      const t = h < -0.01 ? 0.4 + (0.6 * -h) / stock.thickness : 0
      for (let ch = 0; ch < 3; ch++) colors[o + ch] = uncut[ch] + (cut[ch] - uncut[ch]) * t
    }
  return { positions, normals, colors }
}

// Two up-facing triangles per cell; with holes, cells cut right through are left out so through cuts show as holes.
export function surfaceIndex({ width: W, height: H, heights, stock }: Grid, holes: boolean) {
  const through = holes ? -stock.thickness + 1e-3 : -Infinity
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
  return n === index.length ? index : index.slice(0, n)
}
