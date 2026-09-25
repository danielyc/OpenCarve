import { useId, useMemo, useState } from 'react'
import { toGcode } from './cam/gcode'
import { Field, Section, Segmented } from './Inspector'
import { BITS, effectiveBit, findBit, findMaterial, MACHINES, MATERIALS, overrideError } from './lib/library'
import { formatLength, mmToIn, parseLength, type Units } from './lib/units'
import { gcodeBlockError, MAX_GCODE_BLOCK, MAX_STEPOVER, type BitOverride, type BitRole, type OriginPreset } from './model'
import { useAppStore } from './store'

const BIT_TYPES = { endmill: 'Endmill', ballnose: 'Ballnose', vbit: 'V-bit' }

// Grid cells (row, column) of a 3×3 layout; the icon marks the zero on a stock outline.
const ZERO_PRESETS: { value: OriginPreset; label: string; cell: [number, number] }[] = [
  { value: 'top-left', label: 'Top left', cell: [1, 1] },
  { value: 'top-right', label: 'Top right', cell: [1, 3] },
  { value: 'center', label: 'Centre', cell: [2, 2] },
  { value: 'bottom-left', label: 'Bottom left', cell: [3, 1] },
  { value: 'bottom-right', label: 'Bottom right', cell: [3, 3] },
]

function WorkZero() {
  const origin = useAppStore((s) => s.project.origin)
  const units = useAppStore((s) => s.project.units)
  const st = useAppStore.getState
  const name = useId()
  const coord = (label: string, mm: number, key: 'x' | 'y') => (
    <Field
      label={label}
      value={formatLength(mm, units)}
      onCommit={(t) => {
        const v = parseLength(t, units)
        if (v !== null) st().setOrigin({ [key]: v })
      }}
    />
  )
  return (
    <div className="work-zero">
      <h3>Work zero</h3>
      <div className="zero-grid" role="radiogroup" aria-label="XY zero">
        {ZERO_PRESETS.map(({ value, label, cell: [r, c] }) => (
          <label key={value} style={{ gridRow: r, gridColumn: c }} title={label}>
            <input type="radio" name={name} checked={origin.preset === value} onChange={() => st().setOrigin({ preset: value })} />
            <svg viewBox="0 0 20 14" width="20" height="14" aria-hidden="true">
              <rect x="1" y="1" width="18" height="12" rx="1" />
              <circle cx={1 + (c - 1) * 9} cy={1 + (r - 1) * 6} r="2.5" />
            </svg>
            {label}
          </label>
        ))}
      </div>
      <div className="fields">
        {coord('Zero X (from left)', origin.x, 'x')}
        {coord('Zero Y (from bottom)', origin.y, 'y')}
      </div>
      <Segmented
        label="Z zero"
        value={origin.z}
        options={[
          { value: 'top', label: 'Top of stock' },
          { value: 'bottom', label: 'Bottom of stock' },
        ]}
        hint={origin.z === 'bottom' ? 'Z zero at the bottom: touch off on the spoilboard next to the stock.' : undefined}
        onChange={(z) => st().setOrigin({ z })}
      />
    </div>
  )
}

// Inline edits of the chosen library bit, saved as a per-role override. An invalid value reverts and its error stays
// (with aria-invalid on the field) until the next valid edit. Lengths show 3 decimals in mm so 1/8" reads 3.175.
function BitOverrideFields({ role }: { role: BitRole }) {
  const project = useAppStore((s) => s.project)
  const [error, setError] = useState<{ key: keyof BitOverride; message: string } | null>(null)
  const errorId = useId()
  const id = project.bits[role]
  if (!id) return null
  const { units } = project
  const lib = findBit(id)
  const bit = effectiveBit(project, role)
  const fmt = (mm: number) => (units === 'mm' ? String(+mm.toFixed(3)) : formatLength(mm, units))
  const commit = (key: keyof BitOverride, v: number | null) => {
    const message = v === null ? 'Enter a number' : overrideError(lib, { ...project.bitOverrides[role], [key]: v })
    setError(message ? { key, message } : null)
    if (!message) useAppStore.getState().setBitOverride(role, { [key]: v! })
  }
  const field = (label: string, key: keyof BitOverride, value: string, parse: (t: string) => number | null) => (
    <Field
      label={label}
      value={value}
      invalid={error?.key === key}
      describedBy={error?.key === key ? errorId : undefined}
      onCommit={(t) => commit(key, parse(t))}
    />
  )
  const len = (t: string) => parseLength(t, units)
  const name = role === 'rough' ? 'Rough' : 'Detail'
  const libValues = [`${fmt(lib.diameter)} ${units}`, ...(lib.type === 'vbit' ? [`${lib.angle}°`, `flat ${fmt(lib.flat ?? 0)} ${units}`] : [])].join(', ')
  return (
    <div className="fields bit-fields" role="group" aria-label={`${name} dimensions`}>
      {field(`Diameter (${units})`, 'diameter', fmt(bit.diameter), len)}
      {lib.type === 'vbit' && (
        <>
          {field('Angle (°)', 'angle', String(bit.angle), (t) => (t.trim() && Number.isFinite(Number(t)) ? Number(t) : null))}
          {field(`Flat tip diameter (${units})`, 'flat', fmt(bit.flat ?? 0), len)}
        </>
      )}
      {error && (
        <p id={errorId} className="hint field-error">
          {error.message}
        </p>
      )}
      {project.bitOverrides[role] && (
        <p className="note">
          <span className="badge" title={`library: ${libValues}`}>
            Custom
          </span>
          <button
            aria-label={`Reset ${name.toLowerCase()} bit`}
            onClick={() => {
              setError(null)
              useAppStore.getState().setBitOverride(role, null)
            }}
          >
            Reset
          </button>
        </p>
      )}
    </div>
  )
}


const PREVIEW_LINES = 8

// The user's blocks, with a preview of where they land in the rough file (the current toolpaths, or none yet).
function GcodeSection() {
  const project = useAppStore((s) => s.project)
  const cam = useAppStore((s) => s.cam)
  const [errors, setErrors] = useState<{ header?: string; footer?: string }>({})
  const id = useId()
  const { replaceDefaults } = project.gcode
  // ponytail: renders the whole rough file per edit; emit only the first/last op if big jobs make typing lag.
  const preview = useMemo(() => {
    const lines = toGcode(cam ?? { ops: [] }, 'rough', project).trimEnd().split('\n')
    return lines.length > 2 * PREVIEW_LINES + 1 ? [...lines.slice(0, PREVIEW_LINES), '…', ...lines.slice(-PREVIEW_LINES)] : lines
  }, [cam, project])
  const block = (key: 'header' | 'footer', label: string, hint: string) => (
    <>
      <Field
        wide
        live
        multiline
        mono
        label={label}
        value={project.gcode[key]}
        invalid={!!errors[key]}
        describedBy={`${id}-${key}`}
        onCommit={(t) => {
          const error = gcodeBlockError(t)
          setErrors((e) => ({ ...e, [key]: error ? `This block ${error}.` : undefined }))
          if (!error) useAppStore.getState().setGcode({ [key]: t })
        }}
      />
      <p id={`${id}-${key}`} className={errors[key] ? 'hint field-error' : 'hint'}>
        {errors[key] ?? hint}
      </p>
    </>
  )
  return (
    <Section title="G-code">
      {block('header', 'Before the toolpaths', replaceDefaults ? 'Starts the file, right after the comments.' : 'Runs after the standard setup line (G21 G90 G17 G94), before the spindle starts.')}
      {block('footer', 'After the toolpaths', replaceDefaults ? 'Ends the file, after the final move to safe Z.' : 'Runs after the final move to safe Z, before the spindle stops (M5) and the program ends (M2).')}
      <label className="check">
        <input type="checkbox" checked={replaceDefaults} onChange={(e) => useAppStore.getState().setGcode({ replaceDefaults: e.target.checked })} />
        Replace the standard header and footer
      </label>
      {replaceDefaults && (
        <p className="hint field-error">
          Your blocks must then set units and absolute mode (G21 G90), start the spindle (M3 S…), stop it (M5) and end the program (M2).
        </p>
      )}
      <h3 className="subhead">Rough file preview</h3>
      <pre className="gcode-preview" aria-label="G-code preview" tabIndex={0}>
        {preview.join('\n')}
      </pre>
      <p className="hint">Each block is limited to {MAX_GCODE_BLOCK.toLocaleString('en')} plain ASCII characters.</p>
    </Section>
  )
}

export default function SettingsPanel() {
  const project = useAppStore((s) => s.project)
  const { units, stock, machine, bits, cutSettings, cutSettingsCustom } = project
  const st = useAppStore.getState
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
        {bit && <small>{BIT_TYPES[bit.type]}</small>}
      </label>
    )
  }
  const preset = MACHINES.find((m) => m.name === machine.name)
  return (
    <div className="settings-grid">
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
        <WorkZero />
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
          <BitOverrideFields role="rough" />
          {bitSelect('Detail bit', bits.detail, (detail) => st().setBits({ rough: bits.rough, ...(detail && { detail }) }), true)}
          <BitOverrideFields role="detail" />
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
      <GcodeSection />
    </div>
  )
}
