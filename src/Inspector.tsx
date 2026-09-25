import { useId, useRef, useState, type ReactNode } from 'react'
import { FontPicker } from './FontPicker'
import { loadFont } from './lib/fonts'
import { fitText, localBounds, scaleShape, textAtSize } from './lib/geometry'
import { xyZeroLabel, zZeroLabel } from './cam/gcode'
import { effectiveBit, findBit, findMaterial, vbitMaxDepth, vcarveBit } from './lib/library'
import { formatLength, parseLength } from './lib/units'
import { isOpen, tabsActive, type Cut, type Shape, type TextShape } from './model'
import { useAppStore } from './store'

// `live` commits on every keystroke; the whole focus session is a single undo entry.
// `multiline` makes it a textarea (Enter adds a line, Escape leaves); its aria-label keeps the typed text out of its name.
export function Field(props: { label: string; value: string; onCommit: (text: string) => void; wide?: boolean; live?: boolean; multiline?: boolean; mono?: boolean; step?: number; invalid?: boolean; describedBy?: string }) {
  const { label, value, onCommit, wide, live, multiline, mono, step, invalid, describedBy } = props
  const [draft, setDraft] = useState<string | null>(null)
  const gesture = useRef<number>(undefined)
  const Input = multiline ? 'textarea' : 'input'
  return (
    <label className={wide ? 'field wide' : 'field'}>
      <span>{label}</span>
      <Input
        value={draft ?? value}
        {...(multiline ? { rows: mono ? 6 : 2, 'aria-label': label, ...(mono && { className: 'mono', spellCheck: false }) } : step ? { type: 'number', step } : {})}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onFocus={() => {
          setDraft(value)
          if (live) gesture.current = useAppStore.getState().beginTransient()
        }}
        onChange={(e) => {
          setDraft(e.target.value)
          if (live) onCommit(e.target.value)
        }}
        onBlur={() => {
          if (draft !== null && draft !== value) onCommit(draft)
          setDraft(null)
          if (live) useAppStore.getState().commit(gesture.current)
        }}
        onKeyDown={(e) => (multiline ? e.key === 'Escape' : e.key === 'Enter') && e.currentTarget.blur()}
      />
    </label>
  )
}

const size = (s: Shape) => {
  const b = localBounds(s)
  return [b.maxX - b.minX, b.maxY - b.minY]
}
const trimNumber = (n: number) => String(+n.toFixed(2))

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details open className="section">
      <summary>
        <h2>{title}</h2>
      </summary>
      {children}
    </details>
  )
}

const SIDE_HINTS: Record<string, string> = {
  outside: 'Outside: the bit runs outside the line (arrow), so the part keeps its size.',
  inside: 'Inside: the bit runs inside the line (arrow), so the hole keeps its size.',
  on: 'On path: the bit centre follows the line.',
}

// The gesture of the slider (depth or bend) being dragged; only one can be at a time.
let slider = 0

const ALIGN_ICONS = { left: 'M2 4h12M2 8h8M2 12h10', center: 'M2 4h12M4 8h8M3 12h10', right: 'M2 4h12M6 8h8M4 12h10' }

// Native radios give arrow-key navigation; an empty value (mixed selection) leaves all unchecked.
export function Segmented<T extends string>(props: { label: string; value: string; options: { value: T; label: string; disabled?: boolean }[]; hint?: string; onChange: (v: T) => void }) {
  const { label, value, options, hint, onChange } = props
  const id = useId()
  return (
    <>
      <div className="segmented" role="radiogroup" aria-label={label} aria-describedby={hint ? id : undefined}>
        {options.map((o) => (
          <label key={o.value}>
            <input type="radio" name={id} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
      {hint && (
        <p id={id} className="hint">
          {hint}
        </p>
      )}
    </>
  )
}

function CutSection({ selected }: { selected: Shape[] }) {
  const project = useAppStore((s) => s.project)
  const { stock, bits, units } = project
  const st = useAppStore.getState
  const ids = selected.map((s) => s.id)
  const t = stock.thickness
  const shared = (f: (s: Shape) => string) => {
    const v = selected.map(f)
    return v.every((x) => x === v[0]) ? v[0] : ''
  }
  const setCut = (patch: Partial<Cut> | null) => st().setCut(ids, patch)
  const cuts = selected.map((s) => s.cut)
  const carved = cuts.every((c) => c)
  const open = selected.some(isOpen)
  const vbit = [bits.rough, bits.detail].some((id) => id && findBit(id).type === 'vbit')
  const type = shared((s) => s.cut?.type ?? 'none')
  const vcarve = type === 'vcarve'
  const vBit = vcarveBit(project)
  const maxDepth = vcarve ? Math.min(t - 0.5, vBit ? vbitMaxDepth(vBit) : Infinity) : t
  const through = !vcarve && cuts.every((c) => c && c.depth >= t)
  const depth = cuts[0]?.depth ?? t
  const sameDepth = cuts.every((c) => c?.depth === depth)
  const tabbable = cuts.every((c) => c?.type === 'outline' && c.depth >= t)
  const tabs = shared((s) => String(!!s.cut?.tabs))
  const numberField = (label: string, get: (c: Cut) => number, set: (v: number) => Partial<Cut>, isLength = true) => (
    <Field
      label={label}
      value={shared((s) => (isLength ? formatLength(get(s.cut!), units) : String(get(s.cut!))))}
      onCommit={(text) => {
        const v = isLength ? parseLength(text, units) : Math.round(Number(text))
        if (v && v > 0) setCut(set(v))
      }}
    />
  )
  return (
    <Section title="Cut">
      <Segmented
        label="Cut type"
        value={type}
        options={[
          { value: 'outline', label: 'Outline' },
          { value: 'pocket', label: 'Pocket', disabled: open },
          { value: 'vcarve', label: 'V-carve', disabled: open || !vbit },
          { value: 'none', label: 'None' },
        ]}
        hint={open ? 'Open paths can only be cut along the path.' : vbit ? undefined : 'V-carve needs a V-bit as the rough or detail bit.'}
        onChange={(v) => setCut(v === 'none' ? null : { type: v, ...(v === 'pocket' && cuts.every((c) => !c || c.depth >= t) && { depth: Math.min(3, t / 2) }) })}
      />
      {type === 'outline' && (
        <Segmented
          label="Cut side"
          value={shared((s) => s.cut?.side ?? '')}
          options={[
            { value: 'outside', label: 'Outside', disabled: open },
            { value: 'inside', label: 'Inside', disabled: open },
            { value: 'on', label: 'On path' },
          ]}
          hint={SIDE_HINTS[shared((s) => s.cut?.side ?? '')]}
          onChange={(side) => setCut({ side })}
        />
      )}
      {carved && (
        <>
          {sameDepth && (
            <div className="depth">
              <input
                type="range"
                aria-label={vcarve ? 'Max depth' : 'Depth'}
                aria-valuetext={through ? 'Through' : `${formatLength(depth, units)} ${units}`}
                min={0.1}
                max={maxDepth}
                step="any"
                value={Math.min(depth, maxDepth)}
                onPointerDown={() => (slider = st().beginTransient())}
                onPointerUp={() => st().commit(slider)}
                onBlur={() => st().commit(slider)}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setCut({ depth: !vcarve && v > t - 0.05 ? t : Math.min(maxDepth, Math.round(v * 10) / 10) })
                }}
              />
              {through && <span className="badge">Through</span>}
            </div>
          )}
          <div className="fields">
            {numberField(vcarve ? 'Max depth value' : 'Depth value', (c) => c.depth, (depth) => ({ depth }))}
          </div>
          {tabbable && (
            <label className="check">
              <input
                type="checkbox"
                checked={tabs === 'true'}
                ref={(el) => {
                  if (el) el.indeterminate = tabs === ''
                }}
                onChange={(e) => setCut({ tabs: e.target.checked })}
              />
              Tabs
            </label>
          )}
          {selected.every((s) => tabsActive(s.cut, t)) && (
            <>
              <div className="fields">
                {numberField('Tab count', (c) => c.tabCount, (tabCount) => ({ tabCount }), false)}
                {numberField('Tab width', (c) => c.tabWidth, (tabWidth) => ({ tabWidth }))}
                {numberField('Tab height', (c) => c.tabHeight, (tabHeight) => ({ tabHeight }))}
              </div>
              <p className="hint">Tabs hold every cut-out piece, including scrap.</p>
            </>
          )}
        </>
      )}
    </Section>
  )
}

function ProjectSummary() {
  const project = useAppStore((s) => s.project)
  const { stock, units, bits } = project
  const len = (mm: number) => formatLength(mm, units)
  const rows: [string, string][] = [
    ['Material', findMaterial(project.materialId).name],
    ['Stock', `${len(stock.w)} × ${len(stock.h)} × ${len(stock.thickness)} ${units}`],
    ['Rough bit', effectiveBit(project, 'rough').name],
    ...(bits.detail ? [['Detail bit', effectiveBit(project, 'detail').name] as [string, string]] : []),
    ['Work zero', `${xyZeroLabel(project)}, Z at ${zZeroLabel(project)}`],
    ['Machine', project.machine.name],
  ]
  return (
    <section aria-label="Project settings">
      <h2>Project</h2>
      <dl className="summary">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="note">
        <button onClick={() => useAppStore.getState().setStep('settings')}>Edit in Settings</button>
      </p>
      <p className="hint">Select a shape to edit it.</p>
    </section>
  )
}

export default function Inspector() {
  const project = useAppStore((s) => s.project)
  const selection = useAppStore((s) => s.selection)
  const { units, origin } = project
  const selected = project.shapes.filter((s) => selection.includes(s.id))
  const st = useAppStore.getState

  if (!selected.length) return <ProjectSummary />

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
  const updateText = (patch: Partial<TextShape>) =>
    patch.text?.trim() !== '' && update((s) => (s.type === 'text' ? fitText({ ...s, ...patch }) : s))
  const textValue = (f: (s: TextShape) => string) => shared((s) => (s.type === 'text' ? f(s) : ''))
  const bend = textValue((s) => String(s.arc))

  return (
    <>
      <h2>{selected.length > 1 ? `${selected.length} shapes` : 'Shape'}</h2>
      <div className="fields">
        <Field wide label="Name" value={shared((s) => s.name)} onCommit={(name) => update({ name })} />
        {lengthField('X', (s) => s.x - origin.x, (s, x) => ({ ...s, x: x + origin.x }))}
        {lengthField('Y', (s) => s.y - origin.y, (s, y) => ({ ...s, y: y + origin.y }))}
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
            <Field wide live multiline label="Text" value={textValue((s) => s.text)} onCommit={(text) => updateText({ text })} />
            <FontPicker
              value={textValue((s) => s.font)}
              text={textValue((s) => s.text)}
              onChange={(font) =>
                loadFont(font)
                  .then(() => updateText({ font }))
                  .catch(console.error)
              }
            />
            {lengthField('Size', (s) => (s.type === 'text' ? s.size : 0), (s, size) =>
              s.type === 'text' ? fitText(textAtSize(s, size)) : s,
            true)}
            <h3 className="subhead">Layout</h3>
            {lengthField('Letter spacing', (s) => (s.type === 'text' ? s.letterSpacing : 0), (s, v) =>
              s.type === 'text' ? fitText({ ...s, letterSpacing: Math.max(-s.size / 2, v) }) : s,
            )}
            <Field
              live
              step={0.1}
              label="Line height ×"
              value={textValue((s) => String(s.lineHeight))}
              onCommit={(t) => {
                const v = parseFloat(t)
                if (v >= 0.5 && v <= 3) updateText({ lineHeight: v })
              }}
            />
            <div className="field">
              <span>Align</span>
              <div className="segmented" role="radiogroup" aria-label="Align">
                {(['left', 'center', 'right'] as const).map((a) => (
                  <label key={a} title={`Align ${a}`}>
                    <input type="radio" name="text-align" aria-label={`Align ${a}`} checked={textValue((s) => s.align) === a} onChange={() => updateText({ align: a })} />
                    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                      <path d={ALIGN_ICONS[a]} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </label>
                ))}
              </div>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={textValue((s) => String(s.mirror)) === 'true'}
                ref={(el) => {
                  if (el) el.indeterminate = textValue((s) => String(s.mirror)) === ''
                }}
                onChange={(e) => updateText({ mirror: e.target.checked })}
              />
              Mirror
            </label>
            <div className="bend">
              <input
                type="range"
                aria-label="Bend"
                aria-valuetext={bend ? `${bend}°` : 'Mixed'}
                min={-360}
                max={360}
                step={5}
                value={bend || 0}
                onPointerDown={() => (slider = st().beginTransient())}
                onPointerUp={() => st().commit(slider)}
                onBlur={() => st().commit(slider)}
                onChange={(e) => updateText({ arc: Number(e.target.value) })}
              />
              <Field
                label="Bend °"
                value={bend}
                onCommit={(t) => {
                  const v = parseFloat(t)
                  if (Number.isFinite(v)) updateText({ arc: Math.min(360, Math.max(-360, v)) })
                }}
              />
            </div>
          </>
        )}
      </div>
      <CutSection selected={selected} />
    </>
  )
}
