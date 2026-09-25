import { toGcode } from './cam/gcode'
import { findBit } from './lib/library'
import type { BitRole, Project } from './model'
import { mmss, ROLE_LABEL, Summary, Warnings } from './SimulatePanel'
import { useAppStore } from './store'

const fileName = (project: Project, bitName: string) => `${project.name}-${bitName}.nc`.replace(/[\\/:*?"<>|]/g, '_')

export default function ExportPanel() {
  const project = useAppStore((s) => s.project)
  const cam = useAppStore((s) => s.cam)
  const busy = useAppStore((s) => s.camBusy)
  const roles = (['rough', 'detail'] as BitRole[]).filter((r) => project.bits[r])

  const download = (role: BitRole, name: string) => {
    const url = URL.createObjectURL(new Blob([toGcode(cam!, role, project)], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <>
      <h2>Export</h2>
      <Summary />
      <Warnings />
      {!busy && cam && !cam.ops.length && <p className="hint">Nothing to export yet. Give a shape a cut in the Design step.</p>}
      <p className="export-note">
        Set Z zero at the top of the stock and XY zero at the bottom-left corner.
        {roles.length > 1 && ' Run the rough bit first, then change to the detail bit.'}
      </p>
      <ul className="export-bits">
        {roles.map((role) => {
          const bit = findBit(project.bits[role]!)
          const ops = cam?.ops.filter((o) => o.role === role).length ?? 0
          const name = fileName(project, bit.name)
          return (
            <li key={role} className="export-bit">
              <h3>
                {ROLE_LABEL[role]}: {bit.name}
              </h3>
              <p>
                {ops} {ops === 1 ? 'toolpath' : 'toolpaths'} · about {mmss(cam?.timeSec[role] ?? 0)}
              </p>
              <p className="file-name" title={name}>
                {name}
              </p>
              <button disabled={busy || !ops} onClick={() => download(role, name)}>
                Download {role} G-code
              </button>
              {!busy && cam && !ops && <p className="hint">No toolpaths for this bit</p>}
            </li>
          )
        })}
      </ul>
    </>
  )
}
