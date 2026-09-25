import { toGcode } from './cam/gcode'
import { findBit } from './lib/library'
import type { BitRole } from './model'
import { useAppStore } from './store'

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`

export default function ExportPanel() {
  const project = useAppStore((s) => s.project)
  const cam = useAppStore((s) => s.cam)
  const busy = useAppStore((s) => s.camBusy)
  const roles = (['rough', 'detail'] as BitRole[]).filter((r) => project.bits[r])

  const download = (role: BitRole, bitName: string) => {
    const url = URL.createObjectURL(new Blob([toGcode(cam!, role, project)], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${project.name}-${bitName}.nc`.replace(/[\\/:*?"<>|]/g, '_')
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <>
      <h2>Export</h2>
      <p className="note" aria-live="polite">
        {busy ? 'Calculating toolpaths…' : ' '}
      </p>
      {!!cam?.warnings.length && (
        <ul className="warnings">
          {cam.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {roles.map((role) => {
        const bit = findBit(project.bits[role]!)
        const hasOps = !!cam?.ops.some((o) => o.role === role)
        return (
          <section key={role} className="export-bit">
            <h3>
              {role === 'rough' ? 'Rough' : 'Detail'}: {bit.name}
            </h3>
            <p>Estimated time {mmss(cam?.timeSec[role] ?? 0)}</p>
            <button disabled={busy || !hasOps} onClick={() => download(role, bit.name)}>
              Download {role} G-code
            </button>
            {!busy && cam && !hasOps && <p className="hint">No toolpaths for this bit</p>}
          </section>
        )
      })}
    </>
  )
}
