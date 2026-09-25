import { beforeEach, expect, test } from 'vitest'
import { shapeBounds } from './lib/geometry'
import { newProject, tabsActive, type Shape } from './model'
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

test('depth and tab sizes are clamped; tabs are kept but only active on a through outline', () => {
  store().addShape(rect('a', 10, 10))
  const cut = () => store().project.shapes[0].cut!
  store().setCut(['a'], { depth: 50, tabHeight: 20, tabWidth: -1 })
  expect(cut()).toMatchObject({ depth: 12, tabHeight: 11.9, tabWidth: 0.1 })
  store().setCut(['a'], { depth: 0 })
  expect(cut()).toMatchObject({ depth: 0.1, tabs: true })
  expect(tabsActive(cut(), 12)).toBe(false)
  store().setCut(['a'], { type: 'pocket', depth: 12 })
  expect(tabsActive(cut(), 12)).toBe(false)
  store().setCut(['a'], { type: 'outline' })
  expect(tabsActive(cut(), 12)).toBe(true)
  store().setCut(['a'], { type: 'vcarve' })
  expect(cut().depth).toBe(11.5) // a V-carve never cuts through
  store().setCut(['a'], null)
  expect(store().project.shapes[0].cut).toBeUndefined()
})

test('stock thickness changes clamp depths and keep through cuts through', () => {
  store().addShapes([rect('a', 10, 10), rect('b', 30, 30), rect('c', 50, 50)])
  store().setCut(['b'], { type: 'pocket', depth: 8 })
  store().setCut(['c'], { type: 'pocket', depth: 4 })
  store().setStock({ thickness: 6 })
  expect(store().project.shapes.map((s) => s.cut?.depth)).toEqual([6, 6, 4])
  expect(store().project.shapes[0].cut?.tabHeight).toBe(3)
  store().setStock({ thickness: 18 })
  expect(store().project.shapes.map((s) => s.cut?.depth)).toEqual([18, 18, 4])
  store().undo()
  expect(store().project.stock.thickness).toBe(6)
})

test('each bit follows its recommendation until customised', () => {
  const cs = () => store().project.cutSettings
  expect(cs().rough.stepdown).toBe(1.6)
  expect(cs().detail).toBeUndefined()
  store().setBits({ rough: '1/4-endmill', detail: '1mm-endmill' })
  expect(cs().rough.stepdown).toBe(3.2)
  expect(cs().detail?.feed).toBeLessThanOrEqual(600)
  store().setCutSettings('rough', { feed: 900 })
  expect(store().project.cutSettingsCustom).toEqual({ rough: true, detail: false })
  store().setMaterialId('acrylic')
  expect(cs().rough).toMatchObject({ feed: 900, stepdown: 3.2 })
  expect(cs().detail?.rpm).toBe(16000)
  store().setMachine({ name: '3018', w: 300, h: 180, maxRpm: 10000 })
  expect(cs().rough.rpm).toBe(18000)
  expect(cs().detail?.rpm).toBe(10000)
  store().resetCutSettings('rough')
  expect(cs().rough).toMatchObject({ feed: 750, stepdown: 1.6, rpm: 10000 })
  store().setCutSettings('detail', { feed: 100 })
  store().setBits({ rough: '1/4-endmill' })
  expect(cs().detail).toBeUndefined()
  expect(store().project.cutSettingsCustom.detail).toBe(false)
})

test('custom settings are dropped when that role gets a different bit', () => {
  store().setCutSettings('rough', { feed: 2000, stepdown: 3.2 })
  store().setBits({ rough: '1/16-endmill' })
  expect(store().project.cutSettingsCustom.rough).toBe(false)
  expect(store().project.cutSettings.rough.stepdown).toBeLessThan(1)
})

test('loadProject replaces the project and clears history and selection', () => {
  store().addShape(rect('a', 10, 10))
  store().undo()
  store().addShape(rect('b', 10, 10))
  const other = { ...newProject(), name: 'Other', shapes: [rect('c', 0, 0)] }
  store().loadProject(other)
  expect(store()).toMatchObject({ project: other, screen: 'editor', selection: [], past: [], future: [], transientBase: null })
  store().undo()
  expect(store().project).toBe(other)
  store().newProject()
  expect(store().project.id).not.toBe(other.id)
  expect(store().project.shapes).toEqual([])
})
