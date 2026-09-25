// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { newProject } from '../model'
import { useAppStore } from '../store'
import { startAutosave } from './persist'

const db = new Map<string, unknown>()
let failures = 0
vi.mock('idb-keyval', () => ({
  get: async (k: string) => db.get(k),
  set: async (k: string, v: unknown) => {
    if (k.startsWith('opencarve:project:') && failures-- > 0) throw new Error('quota')
    db.set(k, v)
  },
  del: async (k: string) => void db.delete(k),
  update: async (k: string, fn: (v: unknown) => unknown) => void db.set(k, fn(db.get(k))),
}))

afterEach(() => vi.useRealTimers())

test('a failed save shows as failed and retries with backoff until it succeeds', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  startAutosave()
  const st = useAppStore.getState
  st().loadProject(newProject())
  const id = st().project.id
  failures = 2
  st().setProjectName('Draft')
  expect(st().saveState).toBe('saving')

  await vi.advanceTimersByTimeAsync(1000) // autosave → first failure
  expect(st().saveState).toBe('failed')
  await vi.advanceTimersByTimeAsync(5000) // retry after 5 s → second failure
  expect(st().saveState).toBe('failed')
  await vi.advanceTimersByTimeAsync(9999) // backoff doubled to 10 s
  expect(db.has(`opencarve:project:${id}`)).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(st().saveState).toBe('saved')
  expect(db.get(`opencarve:project:${id}`)).toContain('"Draft"')
})
