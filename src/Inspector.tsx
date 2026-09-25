import { useId, useState, type ReactNode } from 'react'
import { FontPicker } from './FontPicker'
import { loadFont } from './lib/fonts'
import { fitText, localBounds, scaleShape } from './lib/geometry'
import { BITS, findBit, findMaterial, MACHINES, MATERIALS } from './lib/library'
import { formatLength, mmToIn, parseLength, type Units } from './lib/units'
import { isOpen, MAX_STEPOVER, tabsActive, type BitRole, type Cut, type Shape, type TextShape } from './model'
import { useAppStore } from './store'

// `live` commits on every keystroke; the whole focus session is a single undo entry.
// `multiline` makes it a textarea (Enter adds a line, Escape leaves); its aria-label keeps the typed text out of its name.
// `step` makes it a number input.
function Field(props: { label: string; value: string; onCommit: (text: string) => void; wide?: boolean; live?: boolean; multiline?: boolean; step?: number }) {
  const { label, value, onCommit, wide, live, multiline, step } = props
  const [draft, setDraft] = useState<string | null>(null)
  const Input = multiline ? 'textarea' : 'input'
  return (
    <label className={wide ? 'field wide' : 'field'}>
      <span>{label}</span>
      <Input
        value={draft ?? value}
        {...(multiline ? { rows: 2, 'aria-label': label } : step ? { type: 'number', step } : {})}
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details open className="section">
      <summary>
        <h2>{title}</h2>
      </summary>
      {children}
    </details>
  )
}

// The canvas arrow on each outline points to the side the bit runs on.
const SIDE_HINTS: Record<string, string> = {
  outside: 'Outside: the bit runs outside the line (arrow), so the part keeps its size.',
  inside: 'Inside: the bit runs inside the line (arrow), so the hole keeps its size.',
  on: 'On path: the bit centre follows the line.',
}

const ALIGN_ICONS = { left: 'M2 4h12M2 8h8M2 12h10', center: 'M2 4h12M4 8h8M3 12h10', right: 'M2 4h12M6 8h8M4 12h10' }

const BIT_TYPES = { endmill: 'Endmill', ballnose: 'Ballnose', vbit: 'V-bit' }

// Native radios give arrow-key navigation; an empty value (mixed selection) leaves all unchecked.
// `hint` explains any disabled options and is shown under the group.
function Segmented<T extends string>(props: { label: string; value: string; options: { value: T; label: string; disabled?: boolean }[]; hint?: string; onChange: (v: T) => void }) {
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
  const { stock, bits, units } = useAppStore((s) => s.project)
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
  const maxDepth = vcarve ? t - 0.5 : t
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
                onPointerDown={() => st().beginTransient()}
                onPointerUp={() => st().commit()}
                onBlur={() => st().commit()}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setCut({ depth: !vcarve && v > t - 0.05 ? t : Math.round(v * 10) / 10 })
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
            <div className="fields">
              {numberField('Tab count', (c) => c.tabCount, (tabCount) => ({ tabCount }), false)}
              {numberField('Tab width', (c) => c.tabWidth, (tabWidth) => ({ tabWidth }))}
              {numberField('Tab height', (c) => c.tabHeight, (tabHeight) => ({ tabHeight }))}
            </div>
          )}
        </>
      )}
    </Section>
  )
}

export default function Inspector() {
  const project = useAppStore((s) => s.project)
  const selection = useAppStore((s) => s.selection)
  const { units } = project
  const selected = project.shapes.filter((s) => selection.includes(s.id))
  const st = useAppStore.getState

  if (!selected.length) {
    const { stock, machine, bits, cutSettings, cutSettingsCustom } = project
    const length = (label: string, mm: number, set: (v: number) => void) => (
      <Field
        label={label}
        value={formatLength(mm, units)}
        onCommit={(t) => {
          const v = parseLength(t, units)
          if (v && v > 0) set(v)
        }}
      />
    )
    const rate = (label: string, mm: number, set: (v: number) => void) => (
      <Field
        label={`${label} (${units}/min)`}
        value={units === 'mm' ? String(Math.round(mm)) : mmToIn(mm).toFixed(1)}
        onCommit={(t) => {
          const v = parseLength(t, units)
          if (v && v > 0) set(v)
        }}
      />
    )
    const count = (label: string, n: number, set: (v: number) => void) => (
      <Field
        label={label}
        value={String(n)}
        onCommit={(t) => {
          const v = Math.round(Number(t))
          if (v > 0) set(v)
        }}
      />
    )
    const bitSettings = (role: BitRole) => {
      const c = cutSettings[role]
      if (!c) return null
      const set = (patch: Parameters<ReturnType<typeof st>['setCutSettings']>[1]) => st().setCutSettings(role, patch)
      return (
        <Section key={role} title={role === 'rough' ? 'Rough cut settings' : 'Detail cut settings'}>
          <div className="fields">
            {rate('Feed', c.feed, (feed) => set({ feed }))}
            {rate('Plunge', c.plunge, (plunge) => set({ plunge }))}
            {length('Stepdown', c.stepdown, (stepdown) => set({ stepdown }))}
            {count('Stepover %', Math.round(c.stepover * 100), (v) => set({ stepover: Math.min(MAX_STEPOVER, v / 100) }))}
            {count('RPM', c.rpm, (rpm) => set({ rpm }))}
            {length('Safe Z', c.safeZ, (safeZ) => set({ safeZ }))}
            <label className="field wide">
              <span>Direction</span>
              <select value={c.direction} onChange={(e) => set({ direction: e.target.value as typeof c.direction })}>
                <option value="conventional">Conventional</option>
                <option value="climb">Climb</option>
              </select>
            </label>
          </div>
          <p className="note">
            {cutSettingsCustom[role] ? (
              <button onClick={() => st().resetCutSettings(role)}>Reset to recommended</button>
            ) : (
              <span className="badge" title={`For ${findMaterial(project.materialId).name} with this bit`}>
                Recommended
              </span>
            )}
          </p>
        </Section>
      )
    }
    const bitSelect = (label: string, id: string | undefined, set: (id: string) => void, none = false) => {
      const bit = id ? findBit(id) : null
      return (
        <label className="field wide">
          <span>{label}</span>
          <select value={id ?? ''} onChange={(e) => set(e.target.value)}>
            {none && <option value="">None</option>}
            {BITS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          {bit && (
            <small>
              {BIT_TYPES[bit.type]} · ⌀ {formatLength(bit.diameter, units)} {units}
              {bit.angle ? ` · ${bit.angle}°` : ''}
            </small>
          )}
        </label>
      )
    }
    const preset = MACHINES.find((m) => m.name === machine.name)
    return (
      <>
        <Section title="Stock">
          <div className="fields">
            {length('Width', stock.w, (w) => st().setStock({ w }))}
            {length('Height', stock.h, (h) => st().setStock({ h }))}
            {length('Thickness', stock.thickness, (thickness) => st().setStock({ thickness }))}
          </div>
          <div className="segmented" role="group" aria-label="Units">
            {(['mm', 'in'] as Units[]).map((u) => (
              <button key={u} aria-pressed={units === u} onClick={() => st().setUnits(u)}>
                {u}
              </button>
            ))}
          </div>
        </Section>
        <Section title="Machine">
          <div className="fields">
            <label className="field wide">
              <span>Machine</span>
              <select value={preset?.name ?? ''} onChange={(e) => st().setMachine(MACHINES.find((m) => m.name === e.target.value)!)}>
                {!preset && <option value="">{machine.name}</option>}
                {MACHINES.map((m) => (
                  <option key={m.name}>{m.name}</option>
                ))}
              </select>
            </label>
            {length('Travel X', machine.w, (w) => st().setMachine({ ...machine, name: 'Custom', w }))}
            {length('Travel Y', machine.h, (h) => st().setMachine({ ...machine, name: 'Custom', h }))}
            {count('Max RPM', machine.maxRpm, (maxRpm) => st().setMachine({ ...machine, name: 'Custom', maxRpm }))}
          </div>
        </Section>
        <Section title="Bits">
          <div className="fields">
            {bitSelect('Rough bit', bits.rough, (rough) => st().setBits({ ...bits, rough }))}
            {bitSelect('Detail bit', bits.detail, (detail) => st().setBits({ rough: bits.rough, ...(detail && { detail }) }), true)}
          </div>
        </Section>
        <Section title="Material">
          <label className="field">
            <span>Material</span>
            <select value={project.materialId} onChange={(e) => st().setMaterialId(e.target.value)}>
              {MATERIALS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </Section>
        {bitSettings('rough')}
        {bitSettings('detail')}
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
  const updateText = (patch: Partial<TextShape>) =>
    patch.text?.trim() !== '' && update((s) => (s.type === 'text' ? fitText({ ...s, ...patch }) : s))
  const textValue = (f: (s: TextShape) => string) => shared((s) => (s.type === 'text' ? f(s) : ''))
  const bend = textValue((s) => String(s.arc ?? 0))

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
            <Field wide live multiline label="Text" value={textValue((s) => s.text)} onCommit={(text) => updateText({ text })} />
            <FontPicker
              value={textValue((s) => s.font)}
              onChange={(font) =>
                loadFont(font)
                  .then(() => updateText({ font }))
                  .catch(console.error)
              }
            />
            {lengthField('Size', (s) => (s.type === 'text' ? s.size : 0), (s, size) => (s.type === 'text' ? fitText({ ...s, size }) : s), true)}
            {lengthField('Letter spacing', (s) => (s.type === 'text' ? (s.letterSpacing ?? 0) : 0), (s, v) =>
              s.type === 'text' ? fitText({ ...s, letterSpacing: Math.max(-s.size / 2, v) }) : s,
            )}
            <Field
              live
              step={0.1}
              label="Line height ×"
              value={textValue((s) => String(s.lineHeight ?? 1.2))}
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
                    <input type="radio" name="text-align" aria-label={`Align ${a}`} checked={textValue((s) => s.align ?? 'center') === a} onChange={() => updateText({ align: a })} />
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
                checked={textValue((s) => String(!!s.mirror)) === 'true'}
                ref={(el) => {
                  if (el) el.indeterminate = textValue((s) => String(!!s.mirror)) === ''
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
                onPointerDown={() => st().beginTransient()}
                onPointerUp={() => st().commit()}
                onBlur={() => st().commit()}
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
