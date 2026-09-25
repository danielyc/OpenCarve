import { simulate, type SimInput } from './sim'

self.onmessage = (e: MessageEvent<SimInput>) => {
  const result = simulate(e.data)
  self.postMessage(result, { transfer: [result.heights.buffer] })
}
