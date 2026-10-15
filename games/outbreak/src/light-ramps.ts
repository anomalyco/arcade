import { curveTable, curveText, parseCurve, sameCurve, type CurvePoint } from "@arcade/kit/ramps"

/**
 * Falloffs the Lab can reshape as curves. Each is baked into a 16-sample table at the end of the lighting uniform
 * block and read by `outbreakRamp` in WGSL; a flag per table says whether to read it at all. While a curve still reads as
 * its default the flag stays 0 and the shaders run the exact formula the default traces, so an untouched curve changes
 * no pixel and costs one uniform branch.
 *
 * - `beamFalloffCurve`: how the flashlight fades out toward its range (x = distance / range), the `(1 - x⁴)²` window
 *   on top of the softened inverse square. The surface pool and the volumetric beam read the same table.
 * - `lampFalloffCurve`: how a practical lamp's pool fades out toward its radius (x = plan distance / radius), the
 *   `(1 - x²)²` window. The radius itself (and the CPU culling that uses it) is unchanged: past it a lamp adds nothing.
 * - `unseenDepthCurve`: how strong the unseen effect is by depth past the visible edge (x = edge depth), today's
 *   linear 0.38 → 1.
 */
export const LIGHT_RAMP_SAMPLES = 16

const sampled = (f: (x: number) => number, n = 9): CurvePoint[] => Array.from({ length: n }, (_, i) => ({ x: i / (n - 1), y: f(i / (n - 1)) }))

export const LIGHT_CURVES = {
  beamFalloffCurve: { table: 0, label: "Falloff to range", points: sampled(x => (1 - x ** 4) ** 2) },
  lampFalloffCurve: { table: 1, label: "Lamp pool edge", points: sampled(x => (1 - x * x) ** 2) },
  unseenDepthCurve: { table: 2, label: "Strength by depth", points: [{ x: 0, y: 0.38 }, { x: 1, y: 1 }] },
} as const
export type LightCurveKey = keyof typeof LIGHT_CURVES
export const LIGHT_CURVE_KEYS = Object.keys(LIGHT_CURVES) as LightCurveKey[]
export const LIGHT_RAMP_FLOATS = 4 + LIGHT_CURVE_KEYS.length * LIGHT_RAMP_SAMPLES

export const DEFAULT_LIGHT_CURVES = Object.fromEntries(LIGHT_CURVE_KEYS.map(key => [key, curveText(LIGHT_CURVES[key].points)])) as Record<
  LightCurveKey,
  string
>
const DEFAULT_POINTS = Object.fromEntries(LIGHT_CURVE_KEYS.map(key => [key, parseCurve(DEFAULT_LIGHT_CURVES[key], [])])) as Record<
  LightCurveKey,
  readonly CurvePoint[]
>

const tables = new Map<LightCurveKey, { text: unknown; table: Float32Array | null }>()

/** The baked table for a curve setting, or null while it reads as its default (parsed once per change). */
export function lightRampTable(key: LightCurveKey, text: unknown): Float32Array | null {
  if (text === undefined || text === DEFAULT_LIGHT_CURVES[key]) return null
  const cached = tables.get(key)
  if (cached && cached.text === text) return cached.table
  const points = parseCurve(text, DEFAULT_POINTS[key])
  const table = sameCurve(points, DEFAULT_POINTS[key]) ? null : curveTable(points, "smooth", LIGHT_RAMP_SAMPLES)
  tables.set(key, { text, table })
  return table
}

/** Packs the flags (`rampOn`) and tables (`ramps`) at `offset`: `LIGHT_RAMP_FLOATS` floats. */
export function packLightRamps(curves: Partial<Record<LightCurveKey, unknown>>, out: Float32Array, offset: number): void {
  for (const key of LIGHT_CURVE_KEYS) {
    const { table: index } = LIGHT_CURVES[key]
    const table = lightRampTable(key, curves[key])
    out[offset + index] = table ? 1 : 0
    if (table) out.set(table, offset + 4 + index * LIGHT_RAMP_SAMPLES)
  }
}

/** The uniform fields (after the unseen block) and the sampler; `outbreakRamp(table, x)` reads table 0–2 at x 0…1. */
export const lightRampFieldsWgsl = /* wgsl */ `
  rampOn: vec4f, // beam falloff, lamp pool edge, unseen depth (1: read the table), reserved
  ramps: array<vec4f, ${(LIGHT_CURVE_KEYS.length * LIGHT_RAMP_SAMPLES) / 4}>,`

export const lightRampWgsl = /* wgsl */ `
fn outbreakRampAt(table: u32, i: u32) -> f32 {
  let k = table * ${LIGHT_RAMP_SAMPLES}u + i;
  return OL.ramps[k / 4u][k % 4u];
}
fn outbreakRamp(table: u32, x: f32) -> f32 {
  let f = clamp(x, 0.0, 1.0) * ${LIGHT_RAMP_SAMPLES - 1}.0;
  let i = min(u32(f), ${LIGHT_RAMP_SAMPLES - 2}u);
  return mix(outbreakRampAt(table, i), outbreakRampAt(table, i + 1u), f - f32(i));
}`
