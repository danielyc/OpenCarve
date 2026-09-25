import { describe, expect, it } from 'vitest'
import type { Op, Pt3 } from '../cam/toolpath'
import { findBit } from '../lib/library'
import { surfaceMesh } from './mesh'
import { gridCellSize, simulate, type SimResult } from './sim'

const stock = { w: 50, h: 50, thickness: 12 }
const at = (r: SimResult, x: number, y: number) => r.heights[Math.round(y / r.cellSize) * r.width + Math.round(x / r.cellSize)]
const op = (points: Pt3[], rapid = false): Op => ({ role: 'rough', shapeId: 's', kind: 'pocket', segments: [{ points, rapid }] })

describe('simulate', () => {
  it('keeps a 300×200 stock near 1.2 M cells', () => {
    expect(gridCellSize(300, 200)).toBe(0.25)
  })

  it('cuts a flat-endmill pocket to depth with sharp edges', () => {
    const bit = findBit('1/8-endmill') // r = 1.5875
    const r = bit.diameter / 2
    const pts: Pt3[] = []
    // Zigzag the tool centre over [10 + r, 30 - r] so the cut covers exactly 10..30.
    for (let y = 10 + r, k = 0; y <= 30 - r + 1e-9; y += 1, k++) {
      const row: Pt3[] = [[10 + r, y, -3], [30 - r, y, -3]]
      pts.push(...(k % 2 ? row.reverse() : row))
    }
    pts.push([30 - r, 30 - r, -3], [10 + r, 30 - r, -3])
    const res = simulate({ id: 1, stock, ops: [op(pts)], bits: { rough: bit }, resolution: 0.25 })
    for (const [x, y] of [[20, 20], [11, 11], [29, 29], [10.5, 20]]) expect(at(res, x, y)).toBeCloseTo(-3, 5)
    for (const [x, y] of [[5, 5], [40, 20], [20, 31], [9.5, 20]]) expect(at(res, x, y)).toBe(0)
    // Edge: the cut starts within one cell of x = 10.
    const row = Math.round(20 / res.cellSize) * res.width
    const first = Array.from({ length: res.width }, (_, i) => i).find((i) => res.heights[row + i] < 0)!
    expect(Math.abs(first * res.cellSize - 10)).toBeLessThanOrEqual(res.cellSize)
  })

  it('stamps a V-bit cone', () => {
    const res = simulate({ id: 1, stock, ops: [op([[25, 25, -2]])], bits: { rough: findBit('90-vbit') }, resolution: 0.1 })
    expect(at(res, 25, 25)).toBeCloseTo(-2, 5)
    expect(at(res, 26, 25)).toBeCloseTo(-1, 1)
    expect(at(res, 25, 27.5)).toBe(0)
  })

  it('cuts a ballnose groove with a round profile', () => {
    const bit = findBit('1/4-ballnose') // r = 3.175
    const res = simulate({ id: 1, stock, ops: [op([[10, 25, -2], [40, 25, -2]])], bits: { rough: bit }, resolution: 0.1 })
    const r = bit.diameter / 2
    expect(at(res, 25, 25)).toBeCloseTo(-2, 5)
    const d = 1.5
    expect(at(res, 25, 25 + d)).toBeCloseTo(-2 + r - Math.sqrt(r * r - d * d), 1)
    expect(at(res, 25, 25 + 3)).toBe(0) // the ball reaches the surface at ~2.95 mm
  })

  it('ignores rapids and moves above the stock', () => {
    const bits = { rough: findBit('1/8-endmill') }
    for (const ops of [[op([[10, 10, -5], [40, 40, -5]], true)], [op([[10, 40, 1], [40, 10, 1]])]])
      expect(simulate({ id: 1, stock, ops, bits }).heights.every((h) => h === 0)).toBe(true)
  })

  it('cuts the move from the previous segment end, like G-code', () => {
    const bits = { rough: findBit('1/8-endmill') }
    const ops: Op[] = [
      { role: 'rough', shapeId: 's', kind: 'pocket', segments: [
        { rapid: true, points: [[10, 25, 5]] },
        { rapid: false, plunge: true, points: [[10, 25, -2]] },
        { rapid: false, points: [[40, 25, -2]] },
      ] },
    ]
    const res = simulate({ id: 1, stock, ops, bits })
    for (const x of [10, 25, 40]) expect(at(res, x, 25)).toBeCloseTo(-2, 5)
  })

  it('never cuts below the stock bottom', () => {
    const res = simulate({ id: 1, stock, ops: [op([[25, 25, -13]])], bits: { rough: findBit('1/8-endmill') } })
    expect(at(res, 25, 25)).toBe(-12)
  })
})

describe('surfaceMesh', () => {
  it('builds up-facing normals and leaves holes where cut through', () => {
    const bits = { rough: findBit('1/4-endmill') }
    const res = simulate({ id: 1, stock, ops: [op([[25, 25, -20]])], bits, resolution: 0.5 })
    const mesh = surfaceMesh(res)
    const n = (x: number, y: number) => {
      const k = (Math.round(y / 0.5) * res.width + Math.round(x / 0.5)) * 3
      return Array.from(mesh.normals.slice(k, k + 3))
    }
    expect(n(5, 5).map(Math.abs)).toEqual([0, 1, 0])
    const [nx, ny] = n(21.5, 25) // left rim of the hole: the wall faces +x (into the hole) and up
    expect(nx).toBeGreaterThan(0.5)
    expect(ny).toBeGreaterThan(0)
    const full = (res.width - 1) * (res.height - 1) * 6
    expect(mesh.index.length).toBeLessThan(full)
    expect(mesh.index.length).toBeGreaterThan(full * 0.9)
  })
})
