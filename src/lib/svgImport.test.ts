// @vitest-environment jsdom
import { expect, test } from 'vitest'
import type { Shape } from '../model'
import { shapeBounds, shapeToPolylines } from './geometry'
import { importSvg } from './svgImport'

const PX = 25.4 / 96
const svg = (body: string, attrs = 'viewBox="0 0 100 100" width="100mm" height="100mm"') =>
  importSvg(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`).shapes
const size = (s: Shape) => {
  const b = shapeBounds(s)
  return [b.maxX - b.minX, b.maxY - b.minY]
}
const close = (a: number[], b: number[], digits = 3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits))

test('rect with transform, placed at (10, 10), y flipped', () => {
  const [r] = svg('<rect x="0" y="0" width="20" height="10" transform="rotate(90)"/>')
  expect(r.type).toBe('path')
  close(size(r), [10, 20])
  const b = shapeBounds(r)
  close([b.minX, b.minY], [10, 10])
  expect(shapeToPolylines(r)[0]).toMatchObject({ closed: true })
  expect(shapeToPolylines(r)[0].points).toHaveLength(4)
})

test('relative layout is preserved and Y is flipped', () => {
  const [a, b] = svg('<rect x="0" y="0" width="10" height="10"/><rect x="30" y="50" width="10" height="10"/>')
  close([b.x - a.x, b.y - a.y], [30, -50])
})

test('path with cubic, arc and relative commands', () => {
  const [p] = svg('<path d="M10 50 c0 -20 40 -20 40 0 a20 20 0 0 1 -40 0 z"/>')
  expect(p.type).toBe('path')
  close(size(p), [40, 15 + 20], 1)
  expect(shapeToPolylines(p)[0].points.length).toBeGreaterThan(20)
})

test('px units by default, mm/in on the root honoured', () => {
  close(size(svg('<rect width="96" height="48"/>', 'width="96" height="48"')[0]), [25.4, 12.7])
  close(size(svg('<rect width="96" height="48"/>', 'viewBox="0 0 96 48"')[0]), [25.4, 12.7])
  close(size(svg('<rect width="50" height="50"/>', 'viewBox="0 0 100 100" width="2in" height="2in"')[0]), [25.4, 25.4])
  close(size(svg('<circle r="10"/>', 'width="10cm" height="10cm" viewBox="0 0 200 200"')[0]), [10, 10])
  close(size(svg('<rect width="10" height="10"/>', '')[0]), [10 * PX, 10 * PX])
})

test('nested g transforms compose; defs are ignored', () => {
  const [r, ...rest] = svg(
    '<defs><rect width="99" height="99"/></defs><g transform="scale(2)"><g transform="translate(5 0)"><rect width="10" height="5" transform="scale(1 2)"/></g></g><rect x="0" width="1" height="1"/>',
  )
  expect(rest).toHaveLength(1)
  close(size(r), [20, 20])
  close([r.x - rest[0].x], [2 * (5 + 5) - 0.5])
})

test('multi-subpath path imports as one compound shape', () => {
  const shapes = svg('<path d="M0 0h30v30h-30z M10 10v10h10v-10z"/><polyline points="0,0 10,10 20,0"/>')
  expect(shapes.map((s) => s.type)).toEqual(['compound', 'path'])
  const polys = shapeToPolylines(shapes[0])
  expect(polys).toHaveLength(2)
  expect(polys.every((p) => p.closed)).toBe(true)
  expect(shapeToPolylines(shapes[1])[0].closed).toBe(false)
  close(size(shapes[0]), [30, 30])
})

test('rejects non-SVG input', () => {
  expect(() => importSvg('<html></html>')).toThrow()
})

test('viewBox scales uniformly (meet), using only the sides given', () => {
  close(size(svg('<rect width="100" height="100"/>', 'viewBox="0 0 100 100" width="100mm" height="50mm"')[0]), [50, 50])
  close(size(svg('<rect width="100" height="100"/>', 'viewBox="0 0 100 100" width="100mm"')[0]), [100, 100])
})

test('counts skipped text and use elements', () => {
  const r = importSvg('<svg xmlns="http://www.w3.org/2000/svg"><defs><text>x</text></defs><text>a</text><use href="#p"/><rect width="5" height="5"/></svg>')
  expect(r.shapes).toHaveLength(1)
  expect(r.skipped).toBe(2)
})

test('rounded rect, fill-rule and hidden elements', () => {
  const [r, e, ...rest] = svg(
    '<rect width="40" height="20" rx="30"/><g style="fill-rule: evenodd"><path fill-rule="inherit" d="M0 0h10v10h-10z M2 2h6v6h-6z"/></g>' +
      '<rect width="5" height="5" display="none"/><g visibility="hidden"><rect width="5" height="5"/></g>',
  )
  expect(rest).toHaveLength(0)
  close(size(r), [40, 20])
  const pts = shapeToPolylines(r)[0].points
  expect(pts.length).toBeGreaterThan(20)
  // rx clamps to 20 and ry defaults to rx (clamped to 10): the corner at the bbox is cut away.
  expect(pts.some(([x, y]) => Math.hypot(x - 10, y - 10) < 0.5)).toBe(false)
  expect(r.fillRule).toBeUndefined()
  expect(e.fillRule).toBe('evenodd')
})
