import { useEffect } from 'react'
import { findBit } from '../lib/library'
import { useAppStore } from '../store'
import type { SimInput, SimResult } from './sim'

const DEBOUNCE_MS = 200
let worker: Worker | null = null
let latest = 0

function run(input: Omit<SimInput, 'id'>) {
  if (!worker) {
    worker = new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<SimResult>) => {
      if (e.data.id === latest) useAppStore.setState({ sim: e.data, simBusy: false })
    }
    worker.onerror = (e) => {
      console.error('Simulation failed', e.message)
      useAppStore.setState({ simBusy: false })
    }
  }
  worker.postMessage({ ...input, id: ++latest })
}

export function useSim() {
  const cam = useAppStore((s) => s.cam)
  const stock = useAppStore((s) => s.project.stock)
  const bits = useAppStore((s) => s.project.bits)
  const camBusy = useAppStore((s) => s.camBusy)
  useEffect(() => {
    useAppStore.setState({ simBusy: true })
    // Wait for the toolpaths to catch up, so a bit change never simulates old paths with the new bit.
    if (camBusy) return
    const t = setTimeout(
      () => run({ stock, ops: cam?.ops ?? [], bits: { rough: findBit(bits.rough), ...(bits.detail && { detail: findBit(bits.detail) }) } }),
      DEBOUNCE_MS,
    )
    return () => clearTimeout(t)
  }, [cam, camBusy, stock, bits])
}
