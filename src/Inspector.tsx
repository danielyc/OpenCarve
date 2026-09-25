import { useState, type ReactNode } from 'react'
import { FONTS, loadFont } from './lib/fonts'
import { fitText, localBounds, scaleShape } from './lib/geometry'
import { BITS, findBit, findMaterial, MACHINES, MATERIALS } from './lib/library'
import { formatLength, mmToIn, parseLength, type Units } from './lib/units'
import { isOpen, type Cut, type Shape } from './model'
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

const BIT_TYPES = { endmill: 'Endmill', ballnose: 'Ballnose', vbit: 'V-bit' }

// Native radios give arrow-key navigation; an empty value (mixed selection) leaves all unchecked.
function Segmented<T extends string>({ label, name, value, options, onChange }: { label: string; name: string; value: string; options: { value: T; label: string; disabled?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value} title={o.disabled}>
          <input type="radio" name={name} checked={value === o.value} disabled={!!o.disabled} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
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
  const open = selected.some(isOpen) ? 'Open paths can only be cut along the path' : undefined
  const vbit = [bits.rough, bits.detail].some((id) => id && findBit(id).type === 'vbit')
  const type = shared((s) => s.cut?.type ?? 'none')
  const through = cuts.every((c) => c && c.depth >= t)
  const depth = cuts[0]?.depth ?? t
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
        name="cut-type"
        value={type}
        options={[
          { value: 'outline', label: 'Outline' },
          { value: 'pocket', label: 'Pocket', disabled: open },
          { value: 'vcarve', label: 'V-carve', disabled: open ?? (vbit ? undefined : 'Choose a V-bit as the rough or detail bit to V-carve') },
          { value: 'none', label: 'None' },
        ]}
        onChange={(v) => setCut(v === 'none' ? null : { type: v })}
      />
      {type === 'outline' && (
        <Segmented
          label="Cut side"
          name="cut-side"
          value={shared((s) => s.cut?.side ?? '')}
          options={[
            { value: 'outside', label: 'Outside', disabled: open },
            { value: 'inside', label: 'Inside', disabled: open },
            { value: 'on', label: 'On path' },
          ]}
          onChange={(side) => setCut({ side })}
        />
      )}
      {carved && (
        <>
          <div className="depth">
            <input
              type="range"
              aria-label="Depth slider"
              aria-valuetext={depth >= t ? 'Through' : `${formatLength(depth, units)} ${units}`}
              min={0.1}
              max={t}
              step="any"
              value={Math.min(depth, t)}
              onFocus={() => st().beginTransient()}
              onBlur={() => st().commit()}
              onChange={(e) => {
                const v = Number(e.target.value)
                setCut({ depth: v > t - 0.05 ? t : Math.round(v * 10) / 10 })
              }}
            />
            {through && <span className="badge">Through</span>}
          </div>
          <div className="fields">
            {numberField('Depth', (c) => c.depth, (depth) => ({ depth }))}
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
          {tabbable && tabs === 'true' && (
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
        <Section title="Cut settings">
          <div className="fields">
            {rate('Feed', cutSettings.feed, (feed) => st().setCutSettings({ feed }))}
            {rate('Plunge', cutSettings.plunge, (plunge) => st().setCutSettings({ plunge }))}
            {length('Stepdown', cutSettings.stepdown, (stepdown) => st().setCutSettings({ stepdown }))}
            <Field
              label="RPM"
              value={String(cutSettings.rpm)}
              onCommit={(t) => {
                const v = Math.round(Number(t))
                if (v > 0) st().setCutSettings({ rpm: v })
              }}
            />
            {length('Safe Z', cutSettings.safeZ, (safeZ) => st().setCutSettings({ safeZ }))}
          </div>
          <p className="note">
            {cutSettingsCustom ? (
              <button onClick={() => st().resetCutSettings()}>Reset to recommended</button>
            ) : (
              <span className="badge" title={`For ${findMaterial(project.materialId).name} with the rough bit`}>
                Recommended
              </span>
            )}
          </p>
        </Section>
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
    patch.text?.trim() !== '' && update((s) => (s.type === 'text' ? fitText({ ...s, ...patch }) : s))

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
      <CutSection selected={selected} />
    </>
  )
}
