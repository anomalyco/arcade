import type { LabControl } from "../../lab-panel"

/**
 * Street lamps as real luminaires: a glowing lens of finite size with a roadway photometric distribution, shared by
 * the surface lights (`physicalLightHooks`), the fog's airlight (`fogScatterVolume`) and the lens geometry.
 *
 * - **Photometry.** A cobra head's refractor throws an asymmetric pool (IES RP-8 "Type II/III"): along the road,
 *   out past a mounting height on the street side, under one on the house side. `streetProfile` builds it from the
 *   pool it is designed to light: an even, flat-topped ellipse on the ground (half the peak at the reach, in mounting
 *   heights, per side), turned into candela by I = E / cos³θ. That gives the batwing a real photometric web has (the
 *   defaults peak ~50° from nadir, 1.2 MH out: IES "short") and a refractor cutoff (62°) that keeps the sky dark.
 *   `streetFluxGain` keeps the lamp's flux equal to the round spot it replaces, so a lamp only redistributes light.
 * - **Area emitter.** Light leaves the lens, not a point: irradiance falls as 1 / (d² + b²) (an on-axis disc of radius
 *   b, so no 1/d² hotspot under the head), highlights and wet glints use the representative point on the lens (Karis),
 *   and the fog integrates from points across the lens with the same softened kernel (`fog-scatter.ts`).
 *
 * The lens frame: `arm` is the plan direction from the pole to the head (towards the street); the lens is an ellipse
 * of semi-axes `a` along the arm and `b` across it. All street lamps in a scene share one profile.
 */
export type StreetLampMode = "today" | "area"

export type StreetLampSettings = {
  /** Today keeps the round point spot; Area turns on the lens emitter and street photometry. */
  mode: StreetLampMode
  /** Half-maximum reach of the pool along the road, in mounting heights. */
  along: number
  /** Half-maximum reach towards the street (the arm side), in mounting heights. */
  street: number
  /** Half-maximum reach behind the pole (house side), in mounting heights. */
  house: number
  /** Where the refractor stops throwing light, degrees from nadir. */
  cutoff: number
  /** Light the bowl throws sideways and slightly up (sag refractor), as a share of the nadir intensity. */
  glow: number
  /** Total flux as a multiple of the round spot it replaces. */
  flux: number
  /** Lens brightness (the emissive bowl). */
  lens: number
  /** Emitter size in shadows (contact-hardening penumbra), × the lens width. */
  softness: number
  /** How far the beam stays visible in the fog, × the fog's visible cone length. */
  air: number
  /** Light the beam scatters in the fog, × the scene's lamp haze (art direction; 1 is physical). */
  haze: number
  /**
   * Henyey–Greenstein g of the beam in the fog. Strong forward scattering (the scene's 0.6) puts the brightest air
   * between the camera and a lamp it stands under, so the beam reads as a ball round the head; a low g lets the fan
   * read as a wedge below the lens.
   */
  phase: number
  /**
   * Share of the light that reaches the sky glow above the lamp (cloud underglow, bank tint). A cutoff head sends
   * nothing up directly, so this is the ground bounce; the beam's own scattering in the bank is the lens airlight.
   */
  uplight: number
}

export const STREET_LAMP_DEFAULTS: Readonly<StreetLampSettings> = {
  mode: "area",
  along: 1.2,
  street: 1.1,
  house: 0.6,
  cutoff: 62,
  glow: 0.02,
  flux: 1.6,
  lens: 1,
  softness: 1,
  air: 0.6,
  haze: 4.2,
  phase: 0.1,
  uplight: 0.12,
}

export const createStreetLampSettings = (overrides: Partial<StreetLampSettings> = {}): StreetLampSettings => ({ ...STREET_LAMP_DEFAULTS, ...overrides })

/** Typed Lab rows; "Lamps" first so Today is one setting away. */
export function streetLampControls(group = "Lamps", prefix = ""): LabControl[] {
  const key = (k: keyof StreetLampSettings) => prefix + k
  const field = (k: keyof StreetLampSettings) => (prefix ? { field: k } : {})
  const range = (k: keyof StreetLampSettings, label: string, min: number, max: number, step: number, unit: string, subsection: string): LabControl => ({
    key: key(k), ...field(k), label, group, subsection, min, max, step, unit,
  })
  return [
    { key: key("mode"), ...field("mode"), label: "Street lamps", group, type: "select", options: [{ value: "today", label: "Today (point spot)" }, { value: "area", label: "Lens emitter + street photometry" }] },
    range("along", "Pool reach along road", 0.5, 5, 0.05, "MH", "Photometry"),
    range("street", "Pool reach street side", 0.3, 4, 0.05, "MH", "Photometry"),
    range("house", "Pool reach house side", 0.1, 3, 0.05, "MH", "Photometry"),
    range("cutoff", "Refractor cutoff", 50, 88, 0.5, "°", "Photometry"),
    range("glow", "Side glow (sag lens)", 0, 0.3, 0.005, "×", "Photometry"),
    range("flux", "Flux vs round spot", 0.2, 3, 0.05, "×", "Photometry"),
    range("air", "Beam reach in fog", 0.5, 5, 0.05, "×", "Emitter"),
    range("haze", "Beam brightness in fog", 0, 4, 0.05, "×", "Emitter"),
    range("phase", "Beam forward scattering (g)", -0.2, 0.9, 0.01, "g", "Emitter"),
    range("uplight", "Sky glow (ground bounce)", 0, 1, 0.01, "×", "Emitter"),
    range("lens", "Lens brightness", 0, 4, 0.05, "×", "Emitter"),
    range("softness", "Shadow softness (lens size)", 0, 3, 0.05, "×", "Emitter"),
  ]
}

/** Floats `packStreetLamp` writes. */
export const STREET_LAMP_FLOATS = 12
/** (along, street, house, cos cutoff), (on, glow, lens, softness), (air reach, fog haze, phase g, uplight): WGSL `A`, `B`, `C`. */
export function packStreetLamp<T extends Float32Array>(s: StreetLampSettings, out: T = new Float32Array(STREET_LAMP_FLOATS) as T, offset = 0): T {
  out.set([s.along, s.street, s.house, Math.cos((s.cutoff * Math.PI) / 180), s.mode === "area" ? 1 : 0, s.glow, s.lens, s.softness, s.air, s.haze, s.phase, s.uplight], offset)
  return out
}

// ---------------------------------------------------------------- CPU mirror

export type Vec3 = readonly [number, number, number]
type Profile = Pick<StreetLampSettings, "along" | "street" | "house" | "cutoff" | "glow">

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** Relative intensity (1 at nadir) towards unit `d` from a downward lamp whose arm points along plan `arm`. */
export function streetProfile(d: Vec3, arm: readonly [number, number], s: Profile): number {
  const c = -d[1]
  const cc = Math.max(c, 0.55)
  const gx = d[0] / cc, gz = d[2] / cc
  const y = gx * arm[0] + gz * arm[1]
  const x = -gx * arm[1] + gz * arm[0]
  const ay = y > 0 ? s.street : s.house
  const q = (x * x) / (s.along * s.along) + (y * y) / (ay * ay)
  const cosCut = Math.cos((s.cutoff * Math.PI) / 180)
  return (Math.exp(-0.693147 * Math.pow(q, 1.25)) / (cc * cc * cc)) * smooth(cosCut - 0.1, cosCut + 0.1, c) + s.glow * smooth(-0.25, 0.15, c)
}

/** Flux of a profile in "nadir candela × steradian" (numeric quadrature over the sphere). */
export function profileFlux(f: (d: Vec3) => number, steps = 96): number {
  let sum = 0
  for (let i = 0; i < steps; i++) {
    const c = -1 + ((i + 0.5) / steps) * 2
    const s = Math.sqrt(1 - c * c)
    for (let j = 0; j < steps * 2; j++) {
      const ph = ((j + 0.5) / (steps * 2)) * Math.PI * 2
      sum += f([s * Math.cos(ph), -c, s * Math.sin(ph)])
    }
  }
  return (sum * 4 * Math.PI) / (steps * steps * 2)
}

/** Flux of the round spot `smoothstep(cosOuter, cosInner, cosθ)` (closed form over the azimuth, numeric in θ). */
export function spotFlux(cosOuter: number, cosInner: number, steps = 512): number {
  let sum = 0
  for (let i = 0; i < steps; i++) {
    const c = (i + 0.5) / steps
    sum += smooth(cosOuter, cosInner, c)
  }
  return (2 * Math.PI * sum) / steps
}

let fluxKey = ""
let fluxValue = 1
/** Multiplier on a lamp's nadir intensity that gives the street profile `s.flux` × the flux of its round spot. */
export function streetFluxGain(s: StreetLampSettings, cosOuter: number, cosInner: number): number {
  const key = [s.along, s.street, s.house, s.cutoff, s.glow].join("/")
  if (key !== fluxKey) {
    fluxKey = key
    fluxValue = profileFlux((d) => streetProfile(d, [1, 0], s), 64)
  }
  return (s.flux * spotFlux(cosOuter, cosInner)) / Math.max(fluxValue, 1e-6)
}

/** Arm (plan unit vector, pole → head) of a lamp from the nearest slender pole collider below it, else null. */
export function armFromPoles(lamp: Vec3, poles: readonly { min: readonly number[]; max: readonly number[] }[], reach = 4): [number, number] | null {
  let best: [number, number] | null = null, bestD = reach
  for (const p of poles) {
    const w = Math.max(p.max[0]! - p.min[0]!, p.max[2]! - p.min[2]!)
    if (w > 0.9 || p.max[1]! < lamp[1] - 3) continue
    const cx = (p.min[0]! + p.max[0]!) / 2, cz = (p.min[2]! + p.max[2]!) / 2
    const dx = lamp[0] - cx, dz = lamp[2] - cz, d = Math.hypot(dx, dz)
    if (d < bestD && d > 0.2) { bestD = d; best = [dx / d, dz / d] }
  }
  return best
}

export type LensShape = {
  /** Lens centre (world). */
  center: Vec3
  /** Plan unit vector from the pole to the head. */
  arm: readonly [number, number]
  /** Semi-axes along and across the arm (m). */
  a: number
  b: number
  /** Sag below the rim (m); 0 for flat glass. */
  depth: number
  /** Head-end droop (rad): the housing tilts the lens down away from the pole. */
  tilt?: number
}

/**
 * Appends the glowing lens (a sag bowl, or flat glass when depth is 0) as kit vertices: colour `color`, material `mat`,
 * aux the radiance weight (1 in the core where the arc tube sits, ~0.55 at the rim). The game shades `mat` as emissive.
 */
export function pushLens(out: number[], lens: LensShape, color: Vec3, mat: number, rings = 6, segments = 28): void {
  const [cx, cy, cz] = lens.center
  const ax = lens.arm[0], az = lens.arm[1]
  const point = (r: number, t: number): [number[], number[], number] => {
    const u = Math.cos(t) * r, v = Math.sin(t) * r
    const sag = Math.sqrt(Math.max(0, 1 - r * r))
    const x = cx + ax * u * lens.a - az * v * lens.b
    const z = cz + az * u * lens.a + ax * v * lens.b
    const y = cy - sag * lens.depth - u * lens.a * Math.sin(lens.tilt ?? 0)
    // Ellipsoid normal (points outward and down).
    const nu = (u / lens.a) * (lens.depth > 0 ? 1 : 0), nv = (v / lens.b) * (lens.depth > 0 ? 1 : 0), ny = -(lens.depth > 0 ? sag / lens.depth : 1)
    const nl = Math.hypot(nu, nv, ny) || 1
    const n = [(ax * nu - az * nv) / nl, ny / nl, (az * nu + ax * nv) / nl]
    // The arc tube lies along the arm: hottest along that line, a soft fall to the rim.
    const core = Math.exp(-(v * v) / 0.18) * Math.exp(-(u * u) / 1.4)
    return [[x, y, z], n, 0.55 + 0.45 * core]
  }
  const vert = (p: [number[], number[], number]) => out.push(p[0][0]!, p[0][1]!, p[0][2]!, p[1][0]!, p[1][1]!, p[1][2]!, color[0], color[1], color[2], mat, p[2])
  for (let i = 0; i < rings; i++) {
    const r0 = i / rings, r1 = (i + 1) / rings
    for (let j = 0; j < segments; j++) {
      const t0 = (j / segments) * Math.PI * 2, t1 = ((j + 1) / segments) * Math.PI * 2
      const a = point(r0, t0), b = point(r1, t0), c = point(r1, t1), d = point(r0, t1)
      // Both windings: the bowl is seen from below and, through the housing's open sides, from above.
      vert(a); vert(c); vert(b); vert(a); vert(b); vert(c)
      if (i > 0) { vert(a); vert(d); vert(c); vert(a); vert(c); vert(d) }
    }
  }
}

// ---------------------------------------------------------------- WGSL

/**
 * `streetProfile(d, arm, A, glow)`: relative intensity towards unit d (lamp → point); `streetLensPoint(center, arm,
 * a, b, ro, rd)`: the point of the lens ellipse nearest the ray (its plane crossing, clamped to the rim), the
 * representative point for highlights.
 */
export const streetLampWgsl = /* wgsl */ `
fn streetProfile(d: vec3f, arm: vec2f, A: vec4f, glow: f32) -> f32 {
  let c = -d.y;
  let cc = max(c, 0.55);
  let g = d.xz / cc;
  let y = dot(g, arm);
  let x = dot(g, vec2f(-arm.y, arm.x));
  let ay = select(A.z, A.y, y > 0.0);
  let q = x * x / (A.x * A.x) + y * y / (ay * ay);
  return exp(-0.693147 * pow(q, 1.25)) / (cc * cc * cc) * smoothstep(A.w - 0.1, A.w + 0.1, c) + glow * smoothstep(-0.25, 0.15, c);
}
fn streetLensPoint(center: vec3f, arm: vec2f, a: f32, b: f32, ro: vec3f, rd: vec3f) -> vec3f {
  var p = center;
  if (abs(rd.y) > 1e-4) {
    let t = (center.y - ro.y) / rd.y;
    if (t > 0.0) { p = ro + rd * t; }
  }
  let q = p.xz - center.xz;
  var uv = vec2f(dot(q, arm) / a, dot(q, vec2f(-arm.y, arm.x)) / b);
  uv /= max(length(uv), 1.0);
  return vec3f(center.x + (arm.x * uv.x * a - arm.y * uv.y * b), center.y, center.z + (arm.y * uv.x * a + arm.x * uv.y * b));
}
`
