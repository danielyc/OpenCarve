import { useEffect } from 'react'
import { effectiveBit } from '../lib/library'
import { useAppStore } from '../store'
import type { SimInput, SimResult } from './sim'
import type { ProgressRequest } from './simWorker'

const DEBOUNCE_MS = 200
let worker: Worker | null = null
let latest = 0
let latestProject = '' // a result for a project that's no longer open is dropped even if its id is still the latest

// Progressive removal: at most one request in flight, at most ~10 a second, always for the latest wanted point.
const PROGRESS_MS = 100
let progressId = 0
let progressBase = 0 // the full simulation a request stamps into; results for an older one are dropped
let inFlight = false
let sentAt = 0
let timer: ReturnType<typeof setTimeout> | undefined
let want = -1 // wanted move index, −1 for none
let wantFrac = 0
let sent = -1
let sentFrac = 0

export function requestProgress(move: number, frac: number) {
  want = move
  wantFrac = frac
  pump()
}

function pump() {
  if (!worker || inFlight || want < 0 || (want === sent && wantFrac === sentFrac) || useAppStore.getState().simBusy) return
  const wait = sentAt + PROGRESS_MS - performance.now()
  if (wait > 0) {
    timer ??= setTimeout(() => {
      timer = undefined
      pump()
    }, wait)
    return
  }
  inFlight = true
  sentAt = performance.now()
  ;[sent, sentFrac, progressBase] = [want, wantFrac, latest]
  worker.postMessage({ id: ++progressId, kind: 'progress', upTo: { move: want, frac: wantFrac } } satisfies ProgressRequest)
}

function run(input: Omit<SimInput, 'id'>) {
  if (!worker) {
    worker = new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<SimResult>) => {
      const current = latestProject === useAppStore.getState().project.id
      if (e.data.progress) {
        inFlight = false
        if (current && e.data.id === progressId && progressBase === latest) useAppStore.setState({ simProgress: e.data })
      } else if (e.data.id === latest && current) useAppStore.setState({ sim: e.data, simBusy: false })
      pump()
    }
    worker.onerror = (e) => {
      console.error('Simulation failed', e.message)
      useAppStore.setState({ simBusy: false })
    }
  }
  latestProject = useAppStore.getState().project.id
  worker.postMessage({ ...input, id: ++latest })
  sent = -1 // the worker starts progress over for the new job
  useAppStore.setState({ simProgress: null })
}

export function useSim() {
  const cam = useAppStore((s) => s.cam)
  const stock = useAppStore((s) => s.project.stock)
  const bits = useAppStore((s) => s.project.bits)
  const settings = useAppStore((s) => s.project.cutSettings)
  const bitOverrides = useAppStore((s) => s.project.bitOverrides)
  const camBusy = useAppStore((s) => s.camBusy)
  useEffect(() => {
    useAppStore.setState({ simBusy: true })
    // Wait for the toolpaths to catch up, so a bit change never simulates old paths with the new bit.
    if (camBusy) return
    const t = setTimeout(
      () => {
        const p = { bits, bitOverrides }
        run({ stock, ops: cam?.ops ?? [], settings, bits: { rough: effectiveBit(p, 'rough'), ...(bits.detail && { detail: effectiveBit(p, 'detail') }) } })
      },
      DEBOUNCE_MS,
    )
    return () => clearTimeout(t)
  }, [cam, camBusy, stock, bits, bitOverrides, settings])
}
