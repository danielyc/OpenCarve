import { xyZeroLabel } from './cam/gcode'
import { opKey, type Op } from './cam/toolpath'
import { icons } from './icons'
import { effectiveBit, findMaterial } from './lib/library'
import { formatLength } from './lib/units'
import type { BitRole, Cut } from './model'
import { timelineFor } from './preview/timeline'
import { useAppStore } from './store'

export const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
export const ROLE_LABEL: Record<BitRole, string> = { rough: 'Rough', detail: 'Detail' }
const SIDE_LABEL: Record<Cut['side'], string> = { outside: 'Outline outside', inside: 'Outline inside', on: 'Outline on path' }
const KIND_LABEL: Record<Exclude<Op['kind'], 'outline'>, string> = {
  pocket: 'Pocket',
  'pocket-detail': 'Pocket detail',
  vcarve: 'V-carve',
  'vcarve-clear': 'V-carve clearing',
}

// Job summary shared by the Simulate and Export panels.
export function Summary() {
  const project = useAppStore((s) => s.project)
  const { materialId, stock, bits, units } = project
  const cam = useAppStore((s) => s.cam)
  const busy = useAppStore((s) => s.camBusy)
  const len = (mm: number) => formatLength(mm, units)
  const rows: [string, string][] = [
    ['Material', findMaterial(materialId).name],
    ['Stock', `${len(stock.w)} × ${len(stock.h)} × ${len(stock.thickness)} ${units}`],
    ...(['rough', 'detail'] as const).flatMap((role): [string, string][] => (bits[role] ? [[`${ROLE_LABEL[role]} bit`, effectiveBit(project, role).name]] : [])),
    ['Work zero', `${xyZeroLabel(project)}, Z at ${project.origin.z}`],
    ['Time', busy || !cam ? 'Calculating…' : `about ${mmss(cam.timeSec.rough + cam.timeSec.detail)}`],
  ]
  return (
    <dl className="summary">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Warnings() {
  const warnings = useAppStore((s) => s.cam?.warnings)
  return (
    <div aria-live="polite">
      {!!warnings?.length && (
        <ul className="warnings" aria-label="Warnings">
          {warnings.map((w) => (
            <li key={w}>
              {icons.warning}
              {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function SimulatePanel() {
  const shapes = useAppStore((s) => s.project.shapes)
  const cam = useAppStore((s) => s.cam)
  const selection = useAppStore((s) => s.selection)
  const highlight = useAppStore((s) => s.highlightOp)
  const settings = useAppStore((s) => s.project.cutSettings)
  // Clicking an op also seeks the animation to where that op starts.
  const seek = (i: number) => {
    const start = cam ? timelineFor(cam.ops, settings).moves.find((m) => m.op === i)?.t0 : undefined
    if (start !== undefined) useAppStore.getState().setAnim({ t: start })
  }
  return (
    <>
      <h2>Simulate</h2>
      <Summary />
      <Warnings />
      <h2 id="toolpaths-heading">Toolpaths</h2>
      {cam?.ops.length ? (
        <ul className="op-list" aria-labelledby="toolpaths-heading">
          {cam.ops.map((op, i) => {
            const shape = shapes.find((s) => s.id === op.shapeId)
            const key = opKey(op)
            const active = highlight === key && selection.includes(op.shapeId)
            return (
              <li key={key}>
                <button
                  className="op-row"
                  aria-pressed={active}
                  onClick={() => {
                    useAppStore.setState({ selection: [op.shapeId], highlightOp: active ? null : key })
                    seek(i)
                  }}
                >
                  <span className="op-name">{shape?.name}</span>
                  <span className="op-time">{mmss(op.timeSec ?? 0)}</span>
                  <span className="op-kind">
                    {op.kind === 'outline' ? SIDE_LABEL[shape?.cut?.side ?? 'on'] : KIND_LABEL[op.kind]} · {ROLE_LABEL[op.role]} bit
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="hint">No toolpaths yet. Give a shape a cut in the Design step.</p>
      )}
    </>
  )
}
