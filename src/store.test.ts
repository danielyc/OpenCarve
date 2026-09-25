import { beforeEach, expect, test } from 'vitest'
import { shapeBounds } from './lib/geometry'
import { newProject, type Shape } from './model'
import { useAppStore } from './store'

const store = useAppStore.getState
const rect = (id: string, x: number, y: number, w = 10, h = 10): Shape => ({ id, name: id, type: 'rect', x, y, rotation: 0, w, h })

beforeEach(() => useAppStore.setState({ project: newProject(), selection: [], past: [], future: [], transientBase: null }))

test('add, undo, redo', () => {
  store().addShape(rect('a', 10, 10))
  expect(store().project.shapes).toHaveLength(1)
  expect(store().selection).toEqual(['a'])
  store().undo()
  expect(store().project.shapes).toHaveLength(0)
  expect(store().selection).toEqual([])
  store().redo()
  expect(store().project.shapes).toHaveLength(1)
  store().redo()
  expect(store().past).toHaveLength(1)
})

test('a drag gesture is one undo entry', () => {
  store().addShape(rect('a', 10, 10))
  store().beginTransient()
  for (let i = 1; i <= 5; i++) store().updateShapes(['a'], { x: 10 + i })
  store().commit()
  expect(store().project.shapes[0].x).toBe(15)
  expect(store().past).toHaveLength(2)
  store().undo()
  expect(store().project.shapes[0].x).toBe(10)
})

test('an empty gesture records nothing', () => {
  store().beginTransient()
  store().commit()
  expect(store().past).toHaveLength(0)
})

test('history is capped at 100', () => {
  store().addShape(rect('a', 0, 0))
  for (let i = 0; i < 150; i++) store().nudge(1, 0)
  expect(store().past).toHaveLength(100)
})

test('align to selection bbox and to stock', () => {
  store().addShape(rect('a', 10, 10))
  store().addShape(rect('b', 50, 40, 20, 20))
  store().setSelection(['a', 'b'])
  store().align('left')
  expect(store().project.shapes.map((s) => shapeBounds(s).minX)).toEqual([5, 5])
  store().align('top')
  expect(store().project.shapes.map((s) => shapeBounds(s).maxY)).toEqual([50, 50])
  store().setSelection(['a'])
  store().align('right')
  expect(shapeBounds(store().project.shapes[0]).maxX).toBe(300)
  store().align('centerY')
  expect(store().project.shapes[0].y).toBe(100)
})

test('duplicate offsets copies and selects them', () => {
  store().addShape(rect('a', 10, 10))
  store().duplicateSelected()
  const [a, b] = store().project.shapes
  expect(b.id).not.toBe(a.id)
  expect([b.x, b.y]).toEqual([15, 15])
  expect(store().selection).toEqual([b.id])
})

test('cancelling a gesture restores the project', () => {
  store().addShape(rect('a', 10, 10))
  store().beginTransient()
  store().updateShapes(['a'], { x: 50 })
  store().cancelTransient()
  expect(store().project.shapes[0].x).toBe(10)
  expect(store().past).toHaveLength(1)
})

test('no-op edits and unit changes are not undo entries', () => {
  store().addShape(rect('a', 10, 10))
  store().updateShapes(['a'], { x: 10 })
  store().setUnits('in')
  expect(store().past).toHaveLength(1)
  store().undo()
  expect(store().project.units).toBe('in')
})

const path = (id: string, closed: boolean): Shape => ({ id, name: id, type: 'path', x: 0, y: 0, rotation: 0, closed, points: [[0, 0], [10, 0], [10, 10]] })

test('new shapes get a through outline cut', () => {
  store().addShapes([rect('a', 10, 10), path('p', false)])
  const [a, p] = store().project.shapes
  expect(a.cut).toMatchObject({ type: 'outline', side: 'outside', depth: 12, tabs: true })
  expect(p.cut).toMatchObject({ type: 'outline', side: 'on' })
})

test('open paths are forced to an outline on the path', () => {
  store().addShape(path('p', false))
  store().setCut(['p'], { type: 'pocket', side: 'inside' })
  expect(store().project.shapes[0].cut).toMatchObject({ type: 'outline', side: 'on' })
})

test('depth is clamped and tabs need a through outline', () => {
  store().addShape(rect('a', 10, 10))
  store().setCut(['a'], { depth: 50 })
  expect(store().project.shapes[0].cut?.depth).toBe(12)
  store().setCut(['a'], { depth: 0 })
  expect(store().project.shapes[0].cut).toMatchObject({ depth: 0.1, tabs: false })
  store().setCut(['a'], { type: 'pocket', depth: 12, tabs: true })
  expect(store().project.shapes[0].cut?.tabs).toBe(false)
  store().setCut(['a'], null)
  expect(store().project.shapes[0].cut).toBeUndefined()
})

test('stock thickness changes clamp depths and keep through cuts through', () => {
  store().addShapes([rect('a', 10, 10), rect('b', 30, 30), rect('c', 50, 50)])
  store().setCut(['b'], { type: 'pocket', depth: 8 })
  store().setCut(['c'], { type: 'pocket', depth: 4 })
  store().setStock({ thickness: 6 })
  expect(store().project.shapes.map((s) => s.cut?.depth)).toEqual([6, 6, 4])
  store().setStock({ thickness: 18 })
  expect(store().project.shapes.map((s) => s.cut?.depth)).toEqual([18, 18, 4])
  expect(store().project.shapes[0].cut?.tabs).toBe(true)
  store().undo()
  expect(store().project.stock.thickness).toBe(6)
})

test('cut settings follow the recommendation until customised', () => {
  expect(store().project.cutSettings.stepdown).toBe(1.6)
  store().setBits({ rough: '1/4-endmill' })
  expect(store().project.cutSettings.stepdown).toBe(3.2)
  store().setCutSettings({ feed: 900 })
  expect(store().project.cutSettingsCustom).toBe(true)
  store().setBits({ rough: '1/16-endmill' })
  store().setMaterialId('acrylic')
  expect(store().project.cutSettings).toMatchObject({ feed: 900, stepdown: 3.2 })
  store().resetCutSettings()
  expect(store().project.cutSettings).toMatchObject({ feed: 800, stepdown: 0.4, rpm: 16000 })
  expect(store().project.cutSettingsCustom).toBe(false)
})
