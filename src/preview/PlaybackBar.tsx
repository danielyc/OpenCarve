import type { Op } from '../cam/toolpath'
import { findBit } from '../lib/library'
import { mmss } from '../SimulatePanel'
import { useAppStore } from '../store'
import { moveAt, type Timeline } from './timeline'

const SPEEDS = [1, 2, 5, 10, 25, 50]

export default function PlaybackBar({ tl, ops }: { tl: Timeline; ops: Op[] }) {
  const anim = useAppStore((s) => s.anim)
  const setAnim = useAppStore((s) => s.setAnim)
  const shapes = useAppStore((s) => s.project.shapes)
  const bits = useAppStore((s) => s.project.bits)
  const t = Math.min(anim.t, tl.total)
  const move = tl.moves[moveAt(tl, t)]
  const op = ops[move.op]
  const bitId = bits[move.role]
  const toggle = () => setAnim(anim.playing ? { playing: false } : { playing: true, ...(t >= tl.total && { t: 0 }) })

  return (
    <div
      className="playback"
      role="group"
      aria-label="Toolpath animation"
      data-anim-t={t.toFixed(2)}
      onKeyDown={(e) => {
        // Space plays and pauses from anywhere in the bar except where it already means something.
        if (e.key !== ' ' || (e.target as Element).closest('button, select, input[type=checkbox]')) return
        e.preventDefault()
        e.stopPropagation()
        toggle()
      }}
    >
      <div className="playback-row">
        <button className="playback-play" onClick={toggle} aria-label={anim.playing ? 'Pause animation' : 'Play animation'}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="currentColor">
            {anim.playing ? <path d="M2 1h3v10H2zM7 1h3v10H7z" /> : <path d="M2 1l9 5-9 5z" />}
          </svg>
          {anim.playing ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          className="playback-scrub"
          aria-label="Animation time"
          aria-valuetext={`${mmss(t)} of ${mmss(tl.total)}`}
          min={0}
          max={tl.total}
          step={0.1}
          value={t}
          onChange={(e) => setAnim({ t: +e.target.value })}
        />
        <span className="playback-time">
          <span className="playback-current">{mmss(t)}</span> / <span className="playback-total">{mmss(tl.total)}</span>
        </span>
      </div>
      <div className="playback-row">
        <select aria-label="Animation speed" value={anim.speed} onChange={(e) => setAnim({ speed: +e.target.value })}>
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={anim.removal} onChange={(e) => setAnim({ removal: e.target.checked })} />
          Material removal
        </label>
        <span className="playback-op" aria-live="off">
          {shapes.find((s) => s.id === op?.shapeId)?.name ?? ''}
          {bitId && ` · ${findBit(bitId).name}`}
        </span>
      </div>
    </div>
  )
}
