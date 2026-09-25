import type { Bit, BitOverride, BitRole, CutSettings, Material, Project } from '../model'

export const BITS: Bit[] = [
  { id: '1mm-endmill', name: '1 mm endmill', type: 'endmill', diameter: 1 },
  { id: '2mm-endmill', name: '2 mm endmill', type: 'endmill', diameter: 2 },
  { id: '3mm-endmill', name: '3 mm endmill', type: 'endmill', diameter: 3 },
  { id: '6mm-endmill', name: '6 mm endmill', type: 'endmill', diameter: 6 },
  { id: '1/16-endmill', name: '1/16" (1.5875 mm) endmill', type: 'endmill', diameter: 1.5875 },
  { id: '1/8-endmill', name: '1/8" (3.175 mm) endmill', type: 'endmill', diameter: 3.175 },
  { id: '1/4-endmill', name: '1/4" (6.35 mm) endmill', type: 'endmill', diameter: 6.35 },
  { id: '1/8-ballnose', name: '1/8" (3.175 mm) ballnose', type: 'ballnose', diameter: 3.175 },
  { id: '1/4-ballnose', name: '1/4" (6.35 mm) ballnose', type: 'ballnose', diameter: 6.35 },
  { id: '60-vbit', name: '60° V-bit, 1/2" (12.7 mm)', type: 'vbit', diameter: 12.7, angle: 60, flat: 0 },
  { id: '90-vbit', name: '90° V-bit, 1/2" (12.7 mm)', type: 'vbit', diameter: 12.7, angle: 90, flat: 0 },
]

// Conservative hobby-router defaults for a 1/8" (3.175 mm) bit on belt/lead-screw machines; recommendedSettings scales by diameter.
export const MATERIALS: Material[] = [
  { id: 'mdf', name: 'MDF', feed: 1500, plunge: 500, stepdownFrac: 0.5, rpm: 18000 },
  { id: 'plywood', name: 'Plywood', feed: 1200, plunge: 400, stepdownFrac: 0.4, rpm: 18000 },
  { id: 'softwood', name: 'Pine / softwood', feed: 1500, plunge: 500, stepdownFrac: 0.5, rpm: 18000 },
  { id: 'hardwood', name: 'Hardwood (oak, maple)', feed: 1000, plunge: 300, stepdownFrac: 0.3, rpm: 18000 },
  { id: 'acrylic', name: 'Acrylic', feed: 800, plunge: 250, stepdownFrac: 0.25, rpm: 16000 },
  { id: 'hdpe', name: 'HDPE', feed: 1200, plunge: 400, stepdownFrac: 0.4, rpm: 16000 },
  { id: 'aluminium', name: 'Aluminium', feed: 400, plunge: 100, stepdownFrac: 0.1, rpm: 16000 },
]

export const MACHINES: Project['machine'][] = [
  { name: 'Generic GRBL', w: 300, h: 300, maxRpm: 24000 },
  { name: '3018', w: 300, h: 180, maxRpm: 10000 },
  { name: 'Onefinity Woodworker', w: 816, h: 816, maxRpm: 24000 },
  { name: 'Shapeoko 4 XL', w: 838, h: 438, maxRpm: 24000 },
  { name: 'Shapeoko 4 XXL', w: 838, h: 838, maxRpm: 24000 },
  { name: 'TwoTrees TTC450 (500 W)', w: 460, h: 460, maxRpm: 12000 },
  { name: 'X-Carve 750', w: 750, h: 750, maxRpm: 24000 },
  { name: 'X-Carve 1000', w: 1000, h: 1000, maxRpm: 24000 },
]

export const findBit = (id: string) => BITS.find((b) => b.id === id) ?? BITS[0]

// Bit geometry as shown to people, always in mm (G-code headers and file names are mm too).
export const bitGeometry = (b: Bit) =>
  [`${+b.diameter.toFixed(3)} mm`, ...(b.type === 'vbit' ? [`${+b.angle!.toFixed(3)}°`, `flat ${+(b.flat ?? 0).toFixed(3)} mm`] : [])].join(', ')

// The library bit for a role with the project's override applied. Callers only ask for roles that have a bit.
export function effectiveBit(p: Pick<Project, 'bits' | 'bitOverrides'>, role: BitRole): Bit {
  const bit = findBit(p.bits[role]!)
  const o = p.bitOverrides[role]
  if (!o || !Object.keys(o).length) return bit
  const b = { ...bit, ...o }
  return { ...b, name: `${bit.name} (custom ${bitGeometry(b)})` }
}

// The V-bit a V-carve uses (the detail role's wins), overrides applied; null without one.
export function vcarveBit(p: Pick<Project, 'bits' | 'bitOverrides'>): Bit | null {
  const role = (['detail', 'rough'] as const).find((r) => p.bits[r] && findBit(p.bits[r]).type === 'vbit')
  return role ? effectiveBit(p, role) : null
}

// Deepest a V-bit can cut before its shank's straight side would cut the walls: (D/2 − flat/2) / tan(angle/2).
export const vbitMaxDepth = (b: Bit) => (b.diameter / 2 - (b.flat ?? 0) / 2) / Math.tan((b.angle! * Math.PI) / 360)

// Why an override can't apply to `bit` (V-bit fields only on V-bits), or null. `flat` is the tip flat's diameter.
// Every supplied field must be a finite number; absent fields keep the library value.
export function overrideError(bit: Bit, o: BitOverride): string | null {
  for (const [k, v] of Object.entries(o)) if (typeof v !== 'number' || !Number.isFinite(v)) return `${k} must be a number`
  if (bit.type !== 'vbit' && (o.angle !== undefined || o.flat !== undefined)) return 'Only V-bits have an angle or flat tip'
  const b = { ...bit, ...o }
  if (b.diameter < 0.1 || b.diameter > 50) return 'Diameter must be 0.1–50 mm'
  if (bit.type !== 'vbit') return null
  if (b.angle! < 10 || b.angle! > 170) return 'Angle must be 10–170°'
  if ((b.flat ?? 0) < 0 || (b.flat ?? 0) >= b.diameter) return 'Flat tip must be at least 0 and less than the diameter'
  return null
}

// Keeps only the fields that differ from the library bit: within 0.005 mm (0.0005°) counts as the same, so values
// that went through a rounded display don't turn a bit custom.
export const differingFields = (bit: Bit, o: BitOverride): BitOverride =>
  Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && !(Math.abs(v - (bit[k as keyof BitOverride] ?? 0)) < (k === 'angle' ? 0.0005 : 0.005))))

export const findMaterial = (id: string) => MATERIALS.find((m) => m.id === id) ?? MATERIALS[0]

// Material numbers are for a 1/8" bit: feed and plunge scale with diameter (roughly constant chipload), V-bits unscaled.
// V-bit stepdown is 1 mm.
export function recommendedSettings(material: Material, bit: Bit, maxRpm: number): CutSettings {
  const vbit = bit.type === 'vbit'
  const rpm = Math.min(material.rpm, maxRpm)
  const f = (vbit ? 1 : Math.min(1.5, Math.max(0.3, bit.diameter / 3.175))) * (rpm / material.rpm)
  const stepdown = vbit ? 1 : Math.round(Math.min(6, Math.max(0.2, material.stepdownFrac * bit.diameter)) * 10) / 10
  return {
    feed: Math.round(material.feed * f),
    plunge: Math.round(material.plunge * f),
    stepdown,
    rpm,
    safeZ: 5,
    stepover: 0.4,
    direction: 'conventional',
  }
}
