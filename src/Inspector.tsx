import { useState } from 'react'
import { FONTS, loadFont } from './lib/fonts'
import { fitText, localBounds, scaleShape } from './lib/geometry'
import { formatLength, parseLength, type Units } from './lib/units'
import type { Shape } from './model'
import { useAppStore } from './store'

// `live` commits on every keystroke; the whole focus session is a single undo entry.
function Field({ label, value, onCommit, wide, live }: { label: string; value: string; onCommit: (text: string) => void; wide?: boolean; live?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <label className={wide ? 'field wide' : 'field'}>
      <span>{label}</span>
      <input
        value={draft ?? value}
        onFocus={() => {
          setDraft(value)
          if (live) useAppStore.getState().beginTransient()
        }}
        onChange={(e) => {
          setDraft(e.target.value)
          if (live) onCommit(e.target.value)
        }}
        onBlur={() => {
          if (draft !== null && draft !== value) onCommit(draft)
          setDraft(null)
          if (live) useAppStore.getState().commit()
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </label>
  )
}

const size = (s: Shape) => {
  const b = localBounds(s)
  return [b.maxX - b.minX, b.maxY - b.minY]
}
const trimNumber = (n: number) => String(+n.toFixed(2))

export default function Inspector() {
  const project = useAppStore((s) => s.project)
  const selection = useAppStore((s) => s.selection)
  const { units, material } = project
  const selected = project.shapes.filter((s) => selection.includes(s.id))
  const st = useAppStore.getState

  if (!selected.length) {
    const length = (key: keyof typeof material) => (
      <Field
        label={{ w: 'Width', h: 'Height', thickness: 'Thickness' }[key]}
        value={formatLength(material[key], units)}
        onCommit={(t) => {
          const v = parseLength(t, units)
          if (v && v > 0) st().setMaterial({ [key]: v })
        }}
      />
    )
    return (
      <>
        <h2>Material</h2>
        <div className="fields">
          {length('w')}
          {length('h')}
          {length('thickness')}
        </div>
        <div className="segmented" role="group" aria-label="Units">
          {(['mm', 'in'] as Units[]).map((u) => (
            <button key={u} aria-pressed={units === u} onClick={() => st().setUnits(u)}>
              {u}
            </button>
          ))}
        </div>
        <h2>Cut settings</h2>
      </>
    )
  }

  const ids = selected.map((s) => s.id)
  const shared = (f: (s: Shape) => string) => {
    const v = selected.map(f)
    return v.every((x) => x === v[0]) ? v[0] : ''
  }
  const update = (patch: Parameters<ReturnType<typeof st>['updateShapes']>[1]) => st().updateShapes(ids, patch)
  const lengthField = (label: string, get: (s: Shape) => number, set: (s: Shape, v: number) => Shape, positive = false) => (
    <Field
      label={label}
      value={shared((s) => formatLength(get(s), units))}
      onCommit={(t) => {
        const v = parseLength(t, units)
        if (v !== null && (!positive || v > 0)) update((s) => set(s, v))
      }}
    />
  )
  const polygons = selected.every((s) => s.type === 'polygon')
  const texts = selected.every((s) => s.type === 'text')
  const updateText = (patch: { text?: string; font?: string; size?: number }) =>
    update((s) => (s.type === 'text' ? fitText({ ...s, ...patch }) : s))

  return (
    <>
      <h2>{selected.length > 1 ? `${selected.length} shapes` : 'Shape'}</h2>
      <div className="fields">
        <Field wide label="Name" value={shared((s) => s.name)} onCommit={(name) => update({ name })} />
        {lengthField('X', (s) => s.x, (s, x) => ({ ...s, x }))}
        {lengthField('Y', (s) => s.y, (s, y) => ({ ...s, y }))}
        {lengthField('W', (s) => size(s)[0], (s, w) => scaleShape(s, size(s)[0] ? w / size(s)[0] : 1, 1), true)}
        {lengthField('H', (s) => size(s)[1], (s, h) => scaleShape(s, 1, size(s)[1] ? h / size(s)[1] : 1), true)}
        <Field
          label="Rotation °"
          value={shared((s) => trimNumber(s.rotation))}
          onCommit={(t) => {
            const v = parseFloat(t)
            if (Number.isFinite(v)) update({ rotation: ((v % 360) + 360) % 360 })
          }}
        />
        {polygons && (
          <Field
            label="Sides"
            value={shared((s) => (s.type === 'polygon' ? String(s.sides) : ''))}
            onCommit={(t) => {
              const v = Math.round(parseFloat(t))
              if (Number.isFinite(v)) update({ sides: Math.min(64, Math.max(3, v)) })
            }}
          />
        )}
        {texts && (
          <>
            <Field wide live label="Text" value={shared((s) => (s.type === 'text' ? s.text : ''))} onCommit={(text) => updateText({ text })} />
            <label className="field">
              <span>Font</span>
              <select
                value={shared((s) => (s.type === 'text' ? s.font : ''))}
                onChange={(e) => {
                  const font = e.target.value
                  loadFont(font)
                    .then(() => updateText({ font }))
                    .catch(console.error)
                }}
              >
                {FONTS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            {lengthField('Size', (s) => (s.type === 'text' ? s.size : 0), (s, size) => (s.type === 'text' ? fitText({ ...s, size }) : s), true)}
          </>
        )}
      </div>
      <h2>Cut settings</h2>
    </>
  )
}
