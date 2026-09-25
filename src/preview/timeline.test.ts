import { describe, expect, it } from 'vitest'
import { planProject } from '../cam/toolpath'
import { findBit, findMaterial, recommendedSettings } from '../lib/library'
import { defaultCut, newProject, type Project, type RectShape } from '../model'
import type { Pt3 } from '../cam/toolpath'
import { surfaceMesh, surfaceRows } from './mesh'
import { progress, simulate } from './sim'
import type { Move } from './timeline'
import { buildTimeline, moveAt, positionAt } from './timeline'

const rect = (id: string, x: number, y: number, extra: Partial<RectShape>): RectShape => ({ id, type: 'rect', name: id, x, y, rotation: 0, w: 40, h: 30, ...extra })

// An outline and a pocket with rest machining, so both bits have ops.
function sample(): Project {
  const p = newProject()
  const rec = (id: string) => recommendedSettings(findMaterial(p.materialId), findBit(id), p.machine.maxRpm)
  const shapes = [
    rect('outline', 30, 30, { cut: defaultCut(12) }),
    rect('pocket', 120, 60, { cut: { ...defaultCut(12), type: 'pocket', depth: 3 } }),
  ]
  return { ...p, shapes, bits: { rough: '6mm-endmill', detail: '1mm-endmill' }, cutSettings: { rough: rec('6mm-endmill'), detail: rec('1mm-endmill') } }
}

describe('timeline', () => {
  const p = sample()
  const cam = planProject(p)
  const tl = buildTimeline(cam.ops, p.cutSettings)

  it('runs the rough file, then the detail file, with monotonic times that add up to the job time', () => {
    const roles = tl.moves.map((m) => m.role)
    expect(roles.indexOf('detail')).toBeGreaterThan(0)
    expect(roles.lastIndexOf('rough')).toBeLessThan(roles.indexOf('detail'))
    tl.moves.forEach((m, i) => {
      expect(m.t1).toBeGreaterThanOrEqual(m.t0)
      if (i) expect(m.t0).toBe(tl.moves[i - 1].t1)
    })
    expect(Math.abs(tl.total - (cam.timeSec.rough + cam.timeSec.detail))).toBeLessThan(1e-6)
  })

  it('puts the tool at the first point at 0 and the last point at the end', () => {
    expect(positionAt(tl, 0)).toEqual(tl.moves[0].a)
    expect(positionAt(tl, tl.total)).toEqual(tl.moves.at(-1)!.b)
  })

  it('finds the move running at a time, including at move boundaries', () => {
    expect(moveAt(tl, -1)).toBe(0)
    expect(moveAt(tl, tl.total + 1)).toBe(tl.moves.length - 1)
    for (const i of [1, 10, Math.floor(tl.moves.length / 2)]) {
      const m = tl.moves[i]
      if (m.t1 === m.t0) continue
      expect(moveAt(tl, m.t0)).toBe(i)
      expect(moveAt(tl, (m.t0 + m.t1) / 2)).toBe(i)
    }
  })
})

describe('progressive removal', () => {
  const p = sample()
  const cam = planProject(p)
  const { moves } = buildTimeline(cam.ops, p.cutSettings)
  const input = { stock: p.stock, bits: { rough: findBit('6mm-endmill'), detail: findBit('1mm-endmill') }, resolution: 0.5 }
  const heights = (s: ReturnType<typeof progress>) => s.sim.result(0).heights
  const n = moves.length
  const k = Math.floor(n / 3)

  it('stamping moves 0..k then k..n equals stamping 0..n and the full simulation', () => {
    const stepped = progress(input, moves, progress(input, moves, null, { move: k, frac: 0.5 }), { move: n, frac: 0 })
    const once = progress(input, moves, null, { move: n, frac: 0 })
    expect(heights(stepped)).toEqual(heights(once))
    expect(heights(once)).toEqual(simulate({ ...input, id: 0, ops: cam.ops }).heights)
    expect(heights(progress(input, moves, null, { move: k, frac: 0 })).some((h) => h < 0)).toBe(true)
  })

  it('going backwards starts over and equals a fresh run', () => {
    const back = progress(input, moves, progress(input, moves, null, { move: n, frac: 0 }), { move: k, frac: 0 })
    expect(heights(back)).toEqual(heights(progress(input, moves, null, { move: k, frac: 0 })))
    expect(heights(back)).not.toEqual(heights(progress(input, moves, null, { move: n, frac: 0 })))
  })

  it('a partial V-carve ramp stamped at stepped fractions ends exactly like the whole move', () => {
    const vin = { stock: { w: 40, h: 20, thickness: 12 }, bits: { rough: findBit('60-vbit') }, resolution: 0.1 }
    const ramp = (a: Pt3, b: Pt3): Move => ({ a, b, t0: 0, t1: 1, op: 0, role: 'rough', cut: true })
    const vmoves = [ramp([5, 10, -0.2], [35, 12, -3]), ramp([35, 12, -3], [20, 5, -1])]
    let state = null
    for (const [move, frac] of [[0, 0.13], [0, 0.37], [0, 0.61], [1, 0.08], [1, 0.9], [2, 0]]) state = progress(vin, vmoves, state, { move, frac })
    const once = progress(vin, vmoves, null, { move: 2, frac: 0 })
    const [a, b] = [heights(state!), heights(once)]
    expect(Math.max(...a.map((h, i) => Math.abs(h - b[i])))).toBeLessThan(1e-5)
    expect(Math.min(...b)).toBeLessThan(-2.5)
  })

  it('reports the rows it changed, including rows reset when starting over', () => {
    const s1 = progress(input, moves, null, { move: k, frac: 0 })
    const d1 = s1.sim.takeDirty()
    expect(d1.lo).toBeLessThanOrEqual(d1.hi)
    expect(s1.sim.takeDirty().lo).toBe(Infinity) // nothing new since
    const s2 = progress(input, moves, s1, { move: 1, frac: 0 }) // backwards: the cut rows go back to stock
    const d2 = s2.sim.takeDirty()
    expect(d2.lo).toBeLessThanOrEqual(d1.lo)
    expect(d2.hi).toBeGreaterThanOrEqual(d1.hi)
  })

  it('builds the same vertices for a band of rows as for the whole surface', () => {
    const r = simulate({ ...input, id: 0, ops: cam.ops })
    const full = surfaceMesh(r)
    const band = surfaceRows(r, 20, 60)
    const off = 20 * r.width * 3
    for (const key of ['positions', 'normals', 'colors'] as const) expect(band[key]).toEqual(full[key].slice(off, off + band[key].length))
  })
})
