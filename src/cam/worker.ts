import type { Project } from '../model'
import { planProject } from './toolpath'

self.onmessage = (e: MessageEvent<{ id: number; project: Project }>) => {
  const { id, project } = e.data
  try {
    self.postMessage({ id, result: planProject(project) })
  } catch (error) {
    self.postMessage({ id, error: String(error) })
  }
}
