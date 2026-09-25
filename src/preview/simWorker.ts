import { surfaceMesh } from './mesh'
import { simulate, type SimInput } from './sim'

self.onmessage = (e: MessageEvent<SimInput>) => {
  const result = simulate(e.data)
  const mesh = surfaceMesh(result)
  const transfer = [result.heights, mesh.positions, mesh.normals, mesh.colors, mesh.index].map((a) => a.buffer)
  self.postMessage({ ...result, mesh }, { transfer })
}
