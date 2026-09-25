import { toGcode } from './cam/gcode'
import { effectiveBit } from './lib/library'
import { formatLength } from './lib/units'
import type { BitRole, Project } from './model'
import { mmss, ROLE_LABEL, Summary, Warnings } from './SimulatePanel'
import { useAppStore } from './store'

const fileName = (project: Project, bitName: string) => `${project.name}-${bitName}.nc`.replace(/[\\/:*?"<>|]/g, '_')

function setupNote({ origin: o, units }: Project) {
  const len = (mm: number) => `${formatLength(mm, units)} ${units}`
  const xy =
    o.preset === 'custom'
      ? `${len(o.x)} right and ${len(o.y)} up from the bottom-left corner`
      : o.preset === 'center'
        ? 'the centre of the stock'
        : `the ${o.preset} corner of the stock`
  return o.z === 'top'
    ? `Set XY zero at ${xy} and Z zero at the top of the stock.`
    : `Set XY zero at ${xy} and Z zero at the bottom of the stock (touch off on the spoilboard next to it). Safe Z still clears the stock top by the same amount.`
}

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
    <div data-cam-busy={busy}>
      <h2>Export</h2>
      <Summary />
      <Warnings />
      {!busy && cam && !cam.ops.length && <p className="hint">Nothing to export yet. Give a shape a cut in the Design step.</p>}
      <p className="export-note">
        {setupNote(project)}
        {roles.length > 1 && " Run the rough bit first, then change to the detail bit. After changing bits, re-zero Z only; don't move X or Y."}
      </p>
      <ul className="export-bits">
        {roles.map((role) => {
          const bit = effectiveBit(project, role)
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
    </div>
  )
}
