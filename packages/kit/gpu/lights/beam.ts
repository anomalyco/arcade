import type { LabControl } from "../../lab-panel"

/**
 * A handheld torch's angular profile, lifted from Outbreak's flashlight (`games/outbreak/src/lighting.ts`
 * `flashProfile`, its default path): a soft cone with a hot core, faint reflector rings and a wide dim spill, as a
 * function of t = angle off the axis / the beam's half-angle. Outbreak's shape is better than a plain
 * `smoothstep(cosOuter, cosInner)` spot (Aiden's) for a torch: the core reads as the bulb's hot spot and the spill
 * keeps the ground just outside the beam from going black.
 *
 * Physical lights use it for `SceneLight.beam` lights (`physicalLightHooks`, cone = (axis.x, axis.z, axis.y, 5 +
 * half-angle), so a torch can point up as well as down); the distance
 * falloff stays physical (windowed inverse-square). Outbreak's near-lens softening (1 / (1 + d²/s²), s = 6 m) is a
 * top-down readability choice and stays in Outbreak. All beam lights in a scene share one profile.
 */
export type BeamProfile = {
  /** Where the cone starts to fade, as a share of the half-angle. */
  inner: number
  /** Hot core strength (on-axis gain above the cone). */
  core: number
  /** Hot core width, as a share of the half-angle. */
  coreWidth: number
  /** Spill level outside the cone. */
  spill: number
  /** Spill width, as a multiple of the half-angle (it ends at 1.7× this). */
  spillWidth: number
  /** Reflector rings (a bright ring near the edge, a dark ring outside the core). */
  rings: number
}

/** Outbreak's Darkwood beam: a wide, evenly lit wedge with a crisp edge, faint core and rings, almost no spill. */
export const DARKWOOD_BEAM: Readonly<BeamProfile> = { inner: 0.8, core: 0.2, coreWidth: 0.34, spill: 0.02, spillWidth: 1.5, rings: 0.1 }
/** A cheap torch: soft cone, strong hot core, visible reflector rings (Outbreak's v7 values on the same path). */
export const HOT_CORE_BEAM: Readonly<BeamProfile> = { inner: 0.35, core: 0.6, coreWidth: 0.34, spill: 0.05, spillWidth: 1.5, rings: 0.45 }

export const BEAM_PROFILES = { darkwood: DARKWOOD_BEAM, hotCore: HOT_CORE_BEAM } as const
export type BeamProfileId = keyof typeof BEAM_PROFILES

export function beamControls(group = "Flashlight", prefix = ""): LabControl[] {
  const row = (k: keyof BeamProfile, label: string, min: number, max: number, step: number, unit = ""): LabControl => ({
    key: prefix + k, ...(prefix ? { field: k } : {}), label, group, subsection: "Beam profile", min, max, step, unit,
  })
  return [
    row("inner", "Inner cone (share of outer)", 0, 0.95, 0.01),
    row("core", "Hot core strength", 0, 3, 0.05, "×"),
    row("coreWidth", "Hot core width (share of outer)", 0.05, 1, 0.01),
    row("spill", "Spill level", 0, 0.5, 0.005, "×"),
    row("spillWidth", "Spill width (× outer)", 1, 3, 0.05, "×"),
    row("rings", "Reflector rings", 0, 1.5, 0.05),
  ]
}

/** Eight floats: (inner, core, coreWidth, spill), (spillWidth, rings, 0, 0); `beamWgsl`'s `a` and `b`. */
export function packBeamProfile<T extends Float32Array>(p: BeamProfile, out: T = new Float32Array(8) as T, offset = 0): T {
  out.set([p.inner, p.core, p.coreWidth, p.spill, p.spillWidth, p.rings, 0, 0], offset)
  return out
}

/** The beam's angular reach: past this angle it throws nothing, so a spot shadow frustum or culling can stop there. */
export const beamReach = (halfAngle: number, p: BeamProfile) => Math.min(Math.PI * 0.95, halfAngle * Math.max(p.spillWidth, 1) * 1.7)

/** Packs a beam into the kit `Light.cone` slot: unit axis x, z, y (any direction), 5 + half-angle. */
export function beamCone(axis: readonly [number, number, number], halfAngle: number): [number, number, number, number] {
  const len = Math.hypot(axis[0], axis[1], axis[2])
  if (!(len > 0)) throw new Error("Beam axis must be non-zero")
  if (!(halfAngle > 0 && halfAngle < 1.5)) throw new Error("Beam half-angle must be in (0, 1.5) rad")
  return [axis[0] / len, axis[2] / len, axis[1] / len, 5 + halfAngle]
}

const bell = (x: number) => 1 / (1 + x * x * (1 + 0.35 * x * x))
const lorentz = (x: number) => 1 / (1 + x * x * (1 + 0.48 * x * x))
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** CPU mirror of `kitBeamProfile` (t = angle / half-angle). */
export function beamProfile(t: number, p: BeamProfile): number {
  const spillW = Math.max(p.spillWidth, 1)
  if (t >= spillW * 1.7) return 0
  const coreW = Math.max(p.coreWidth, 0.05)
  const rings = 1 + p.rings * (0.2 * bell((t - 0.84) * 12.5) - 0.18 * bell((t - coreW * 1.35) * 9))
  return (1 - smoothstep(p.inner, 1, t)) * rings + p.core * lorentz(t / Math.max(coreW, 0.04)) + p.spill * lorentz(t / spillW)
}

/** WGSL: `kitBeamAngle(cosT)` (≈ acos, Outbreak's series) and `kitBeamProfile(t, a, b)` from `packBeamProfile`. */
export const beamWgsl = /* wgsl */ `
fn kitBeamAngle(cosT: f32) -> f32 {
  let omc = max(0.0, 1.0 - clamp(cosT, -1.0, 1.0));
  return sqrt(2.0 * omc) * (1.0 + 0.083333 * omc);
}
fn kitBeamBell(x: f32) -> f32 { return 1.0 / (1.0 + x * x * (1.0 + 0.35 * x * x)); }
fn kitBeamLorentz(x: f32) -> f32 { return 1.0 / (1.0 + x * x * (1.0 + 0.48 * x * x)); }
fn kitBeamProfile(t: f32, a: vec4f, b: vec4f) -> f32 {
  let spillW = max(b.x, 1.0);
  if (t >= spillW * 1.7) { return 0.0; }
  let coreW = max(a.z, 0.05);
  let rings = 1.0 + b.y * (0.2 * kitBeamBell((t - 0.84) * 12.5) - 0.18 * kitBeamBell((t - coreW * 1.35) * 9.0));
  return (1.0 - smoothstep(a.x, 1.0, t)) * rings + a.y * kitBeamLorentz(t / max(coreW, 0.04)) + a.w * kitBeamLorentz(t / spillW);
}
`
