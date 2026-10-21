import type { LabControl } from "../../lab-panel"
import { spotShadowAreaWgsl, spotShadowWgsl } from "../shadows/spot-shadows"
import { DARKWOOD_BEAM, beamWgsl } from "./beam"
import { streetLampWgsl } from "./street"
import { rectEmitterWgsl } from "./rect"
import type { SceneHooks } from "../shaders"

/**
 * Physically based lights and surfaces for the kit scene shader, as `SceneHooks` a game spreads into its own:
 *
 * - Lights: windowed inverse-square falloff from the fixture's 3D position (Karis' `(1 − (d/r)⁴)²` window, the fixture
 *   radius as the near clamp) and real 3D spot cones (`smoothstep(cosOuter, cosInner)`, the same shape the fog's air
 *   cone uses) with an optional spill floor.
 * - Surfaces: GGX, height-correlated Smith visibility and Schlick Fresnel per light; Karis' sphere-light widening so a
 *   fixture of radius r mirrors as a soft patch rather than a pin-prick; Tokuyoshi–Kaplanyan geometric specular
 *   anti-aliasing from the normal's screen derivatives; split-sum environment specular from an analytic sky (a fitted
 *   environment BRDF, no LUT, no prefiltered cube) with Lagarde's specular occlusion.
 *
 * Roughness comes from the surface's legacy shininess (`α² = 2 / (n + 2)`, the Blinn–Phong ↔ GGX match) unless the
 * game's material hook sets `pbrRough` (perceptual roughness) and `pbrMetal`. Light units: a light's `power × GAIN`
 * is its intensity, so a diffuse surface at distance d receives `albedo · I · cosθ / (π d²)`, as Lot's hook did.
 */

export type LightModel = "today" | "physical"

export type PhysicalLightSettings = {
  model: LightModel
  /** Geometric specular AA strength (1 = Tokuyoshi–Kaplanyan σ² 0.25, κ 0.18). */
  specularAA: number
  /** Sphere-light highlight widening: × the fixture radius (`Light.extra.z`). */
  sphereLights: number
  /** Environment (sky) reflection strength. */
  envSpecular: number
  /** Light a spot throws outside its cone, as a fraction of the beam (Aiden's spill floor). */
  spill: number
}

export const PHYSICAL_LIGHT_DEFAULTS: Readonly<PhysicalLightSettings> = {
  model: "today",
  specularAA: 1,
  sphereLights: 1,
  envSpecular: 1,
  spill: 0,
}

export const createPhysicalLightSettings = (overrides: Partial<PhysicalLightSettings> = {}): PhysicalLightSettings => ({ ...PHYSICAL_LIGHT_DEFAULTS, ...overrides })

/** Typed Lab rows; "Light model" first so Today is one setting away. */
export function physicalLightControls(group = "Lighting", prefix = ""): LabControl[] {
  const key = (k: keyof PhysicalLightSettings) => prefix + k
  const field = (k: keyof PhysicalLightSettings) => (prefix ? { field: k } : {})
  const range = (k: keyof PhysicalLightSettings, label: string, min: number, max: number, step: number, unit?: string): LabControl => ({
    key: key(k), ...field(k), label, group, subsection: "Physical", min, max, step, ...(unit ? { unit } : {}),
  })
  return [
    { key: key("model"), ...field("model"), label: "Light model", group, type: "select", options: [{ value: "today", label: "Today" }, { value: "physical", label: "Physical (GGX + sky)" }] },
    range("envSpecular", "Sky reflections", 0, 2, 0.05, "×"),
    range("sphereLights", "Fixture size in highlights", 0, 3, 0.05, "×"),
    range("specularAA", "Specular anti-aliasing", 0, 2, 0.05, "×"),
    range("spill", "Spill outside cones", 0, 0.3, 0.005),
  ]
}

/** Packs the four live knobs for a game that binds them through `knobs` (e.g. its custom uniform). */
export function packPhysicalLightKnobs<T extends Float32Array>(s: PhysicalLightSettings, out: T = new Float32Array(4) as T, offset = 0): T {
  out[offset] = s.specularAA
  out[offset + 1] = s.sphereLights
  out[offset + 2] = s.envSpecular
  out[offset + 3] = s.spill
  return out
}

export type PhysicalLightOptions = {
  /**
   * WGSL `vec4f` expression of the live knobs (specular AA, sphere lights, sky reflections, spill), e.g. a field of the
   * game's custom uniform written with `packPhysicalLightKnobs`. Default: the settings baked as constants.
   */
  knobs?: string
  settings?: Partial<PhysicalLightSettings>
  /**
   * WGSL `vec3f` expression of `(dir: vec3f, rough: f32, n: vec3f)`: radiance the surface mirrors along `dir`.
   * Default: the kit hemisphere sky (`ambientAt`) blurred toward the irradiance around `n` as roughness rises. With the
   * fog port: `mix(fogEnv(dir), fogAmbient(n), rough * rough)`.
   */
  env?: string
  /** WGSL `vec3f` expression for the normal whose screen derivatives drive specular AA (default the interpolated normal). */
  aaNormal?: string
  /** Sample spot shadow maps (`gpu/shadows/spot-shadows.ts`, scene bindings 20–22) for the lights that hold one. */
  spotShadows?: boolean
  /**
   * WGSL \`vec4f\` expressions for the shared torch profile of \`SceneLight.beam\` lights (\`packBeamProfile\`'s two
   * halves, e.g. a custom uniform). Default: Outbreak's Darkwood beam baked as constants.
   */
  beam?: { a: string; b: string }
  /**
   * WGSL \`vec4f\` expressions of the shared street lamp profile (\`packStreetLamp\`'s two halves) for
   * \`SceneLight.street\` lights (lens emitter + roadway photometry, \`lights/street.ts\`). Only shaders given this
   * compile the street path (profile, lens highlights, PCSS); without it street lights shine unshaped.
   */
  street?: { a: string; b: string }
  /** Compile downward rectangular Lambertian panels (`SceneLight.rect`), with exact diffuse and representative GGX. */
  rect?: boolean
}

/** WGSL: BRDF, light shape and environment functions. Needs `common` (Frame, Light, PI) and `ambientAt` before use. */
export const physicalLightWgsl = /* wgsl */ `
var<private> pbrRough: f32 = -1.0;
var<private> pbrMetal: f32 = 0.0;
var<private> pbrAAKernel: f32 = 0.0;
var<private> pbrSpecF: vec3f = vec3f(0.0);

/** GGX α from the surface: the material's perceptual roughness, else the legacy shininess (α² = 2 / (n + 2)). */
fn pbrAlpha(shin: f32) -> f32 {
  if (pbrRough >= 0.0) { return max(pbrRough * pbrRough, 0.002); }
  return sqrt(2.0 / (max(shin, 0.0) + 2.0));
}
fn pbrPerceptual(shin: f32) -> f32 { return sqrt(pbrAlpha(shin)); }

/** Tokuyoshi & Kaplanyan 2019: screen-space normal variance widens α² so sub-pixel normal detail cannot sparkle. */
fn pbrSpecularAAKernel(n: vec3f, strength: f32) -> f32 {
  let du = dpdx(n);
  let dv = dpdy(n);
  return min(2.0 * 0.25 * (dot(du, du) + dot(dv, dv)), 0.18) * strength;
}

fn pbrD(nh: f32, a2: f32) -> f32 {
  let d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}
/** Height-correlated Smith visibility, Hammon's fast form (V = G / 4 n·l n·v). */
fn pbrV(nv: f32, nl: f32, a: f32) -> f32 {
  return 0.5 / max(mix(2.0 * nl * nv, nl + nv, a), 1e-5);
}
fn pbrFc(vh: f32) -> f32 {
  let x = 1.0 - vh;
  let x2 = x * x;
  return x2 * x2 * x;
}

/**
 * One light's specular, split by Fresnel so F0 (unknown inside the light loop) applies afterwards:
 * spec = F0 · x + y with x = D·V·(1 − Fc)·n·l and y = D·V·Fc·n·l. Fixture radius widens α (Karis), energy-kept.
 */
fn pbrSpecular(n: vec3f, V: vec3f, ldir: vec3f, shin: f32, d: f32, radius: f32) -> vec2f {
  let nl = dot(n, ldir);
  if (nl <= 0.0) { return vec2f(0.0); }
  let nv = max(dot(n, V), 1e-4);
  let h = normalize(ldir + V);
  let a = pbrAlpha(shin);
  let a2 = clamp(a * a + pbrAAKernel, 0.0, 1.0);
  let aa = sqrt(a2);
  let wide = clamp(aa + radius / (2.0 * max(d, 0.05)), 0.0, 1.0);
  let energy = (aa / wide) * (aa / wide);
  let dv = pbrD(max(dot(n, h), 0.0), wide * wide) * energy * pbrV(nv, nl, aa) * nl;
  let fc = pbrFc(max(dot(V, h), 0.0));
  return vec2f(dv * (1.0 - fc), dv * fc);
}

/** Windowed inverse-square intensity at distance d from a fixture of radius s and range r (Karis' window). */
fn pbrFalloff(d: f32, r: f32, s: f32) -> f32 {
  let x = d / max(r, 1e-3);
  let w = clamp(1.0 - x * x * x * x, 0.0, 1.0);
  return w * w / max(d * d, max(s * s, 0.01));
}

/**
 * Distance falloff: the windowed inverse square, or for a street lamp's lens (cone.w >= 6.5, lens half-width
 * cone.w − 7) the on-axis disc form 1 / (d² + b²), so the pool has no hotspot under the head.
 */
fn pbrLightFalloff(L: Light, d: f32, r: f32) -> f32 {
  if (L.cone.w < 6.5) { return pbrFalloff(d, r, L.extra.z); }
  let b = L.cone.w - 7.0;
  let x = d / max(r, 1e-3);
  let w = clamp(1.0 - x * x * x * x, 0.0, 1.0);
  return w * w / (d * d + b * b);
}

/**
 * A light's 3D spot cone (Light.cone.w in [2.5, 4.5)): axis xz in cone.xy with y pointing down, cos outer in cone.z,
 * cos inner in cone.w − 3; or a torch beam (cone.w >= 4.5: axis x, z, y in cone.xyz, half-angle cone.w − 5) shaped by the shared beam profile
 * (\`lights/beam.ts\`); or a street lamp (cone.w >= 6.5: arm xz in cone.xy, lens semi-axes cone.z and cone.w − 7) shaped by
 * \`streetProfile\`. Returns 1 for other lights (the kit's plan cones and game-shaped cones keep their own code).
 */
fn pbrCone(L: Light, ldir: vec3f, spill: f32) -> f32 {
  if (L.cone.w < 2.5) { return 1.0; }
  if (L.cone.w >= 6.5) { return pbrStreetCone(ldir, L.cone.xy); }
  if (L.cone.w >= 4.5) { return kitBeamProfile(kitBeamAngle(dot(-ldir, L.cone.xzy)) / (L.cone.w - 5.0), pbrBeamA(), pbrBeamB()); }
  let axis = vec3f(L.cone.x, -sqrt(max(1.0 - dot(L.cone.xy, L.cone.xy), 0.0)), L.cone.y);
  let c = smoothstep(L.cone.z, L.cone.w - 3.0, dot(-ldir, axis));
  return mix(spill, 1.0, c);
}

/**
 * Split-sum environment BRDF, F0 · A + B, by a least-squares fit in (roughness, roughness², n·v, exp2(−9.28 n·v)) to
 * the importance-sampled reference (\`envBRDFReference\`): worst error 0.06, RMS 0.015 over roughness 0.1–1. Karis'
 * mobile fit is off by up to 0.4 for metals; this costs four more multiply-adds and no LUT.
 */
fn pbrEnvBRDF(f0: vec3f, rough: f32, nv: f32) -> vec3f {
  let r = vec3f(1.0, rough, rough * rough);
  let e = exp2(-9.28 * nv);
  let a = dot(r, vec3f(1.0791, -0.9213, 0.4656)) + nv * dot(r, vec3f(-0.086, 1.3501, -1.6465)) + e * dot(r, vec3f(-1.5511, 4.2961, -2.4702));
  let b = dot(r, vec3f(0.06, 0.0612, -0.1361)) + nv * dot(r, vec3f(-0.0867, -0.0305, 0.1345)) + e * dot(r, vec3f(1.2644, -3.1543, 2.0));
  return f0 * clamp(a, 0.0, 1.0) + clamp(b, 0.0, 1.0);
}

/** Lagarde's specular occlusion from ambient occlusion. */
fn pbrSpecOcclusion(nv: f32, ao: f32, rough: f32) -> f32 {
  return clamp(pow(nv + ao, exp2(-16.0 * rough - 1.0)) - 1.0 + ao, 0.0, 1.0);
}
`

const num = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x))

/**
 * Scene hooks for physically based lights and surfaces. Spread them into a game's hooks; a game that also sets
 * `declarations`, `fragmentStart` or `ambient` should compose them (`physicalLightHooks` puts its own first).
 */
export function physicalLightHooks(opts: PhysicalLightOptions = {}): SceneHooks {
  const s = createPhysicalLightSettings(opts.settings)
  const knobs = opts.knobs ?? `vec4f(${num(s.specularAA)}, ${num(s.sphereLights)}, ${num(s.envSpecular)}, ${num(s.spill)})`
  const env = opts.env ?? "mix(ambientAt(dir), ambientAt(n), rough * rough)"
  const d = DARKWOOD_BEAM
  const street = opts.street
  const beam = opts.beam ?? { a: `vec4f(${[d.inner, d.core, d.coreWidth, d.spill].map(num).join(", ")})`, b: `vec4f(${num(d.spillWidth)}, ${num(d.rings)}, 0.0, 0.0)` }
  return {
    declarations: `${street ? streetLampWgsl : ""}${opts.rect ? rectEmitterWgsl : ""}${physicalLightWgsl}${beamWgsl}${opts.spotShadows ? spotShadowWgsl + (street || opts.rect ? spotShadowAreaWgsl : "") : ""}
fn pbrKnobs() -> vec4f { return ${knobs}; }
${street ? `fn pbrStreetA() -> vec4f { return ${street.a}; }
fn pbrStreetB() -> vec4f { return ${street.b}; }
fn pbrStreetCone(ldir: vec3f, arm: vec2f) -> f32 { return streetProfile(-ldir, arm, pbrStreetA(), pbrStreetB().y); }` : "fn pbrStreetCone(ldir: vec3f, arm: vec2f) -> f32 { return 1.0; }"}
fn pbrBeamA() -> vec4f { return ${beam.a}; }
fn pbrBeamB() -> vec4f { return ${beam.b}; }
fn pbrEnvRadiance(dir: vec3f, rough: f32, n: vec3f) -> vec3f { return ${env}; }
/** Split-sum sky reflection along the GGX dominant direction (Lagarde), with specular occlusion. */
fn pbrEnvSpecular(n: vec3f, V: vec3f, rough: f32, f0: vec3f, ao: f32) -> vec3f {
  let nv = max(dot(n, V), 1e-4);
  let a = rough * rough;
  let R = reflect(-V, n);
  let dir = normalize(mix(n, R, (1.0 - a) * (sqrt(1.0 - a) + a)));
  return pbrEnvRadiance(dir, rough, n) * pbrEnvBRDF(f0, rough, nv) * pbrSpecOcclusion(nv, ao, rough) * pbrKnobs().z;
}`,
    fragmentStart: `pbrAAKernel = pbrSpecularAAKernel(${opts.aaNormal ?? "normalize(o.normal)"}, pbrKnobs().x);`,
    lightAttenuation: `var att = power * pbrLightFalloff(L, d3, r) * pbrCone(L, ldir, pbrKnobs().w);${opts.rect ? `
    if(L.cone.w == -3.0) {
      let window=clamp(1.0-pow(d3/max(r,0.001),4.0),0.0,1.0);
      att=select(0.0,power*window*window,world.y<L.pos.y);
    }` : ""}${opts.spotShadows ? `
    if (att > 0.0005) {${street || opts.rect ? `
      // A street lamp's lens softens its shadows with distance from the caster (contact hardening).
      var lensR = ${street ? "select(0.0, sqrt(max(0.0,L.cone.z * (L.cone.w - 7.0))) * pbrStreetB().w, L.cone.w >= 6.5)" : "0.0"};${opts.rect ? "\n      if(L.cone.w == -3.0) { lensR=sqrt(L.cone.x*L.cone.y); }" : ""}
      if (lensR > 0.01) { att *= spotShadowVisArea(i, world, n, lensR, fract(sin(dot(world, vec3f(12.9898, 78.233, 37.719))) * 43758.5453 + F.cam.w * 0.618034)); }
      else { att *= spotShadowVis(i, world, n); }` : `
      att *= spotShadowVis(i, world, n);`}
    }` : ""}`,
    diffuseTerm: opts.rect ? `var diffuse=max(ndl,0.0)/PI;
    if(L.cone.w == -3.0) { diffuse=rectIrradiance(L.pos.xyz,L.cone.xy,L.cone.z,world,n)/PI; }` : "let diffuse = max(ndl, 0.0) / PI;",
    lightLeak: "0.0",
    wallDirectScale: "1.0",
    specularTerm: `if (att * vis > 0.0) {
      var sl = ldir;
      var sd = d3;
      var sr = L.extra.z;${street ? `
      if (L.cone.w >= 6.5) {
        // Representative point (Karis): the lens point nearest the mirror ray, widened by the lens half-width.
        let lp = streetLensPoint(vec3f(L.pos.x, hl, L.pos.z), L.cone.xy, L.cone.z, L.cone.w - 7.0, world, reflect(-V, n));
        sd = max(length(lp - world), 0.05);
        sl = (lp - world) / sd;
        sr = L.cone.w - 7.0;
      }` : ""}
      ${opts.rect ? `if(L.cone.w == -3.0) {
        let rp=rectMirrorPoint(L.pos.xyz,L.cone.xy,L.cone.z,world,reflect(-V,n));
        sd=max(length(rp-world),0.05); sl=(rp-world)/sd; sr=min(L.cone.x,L.cone.y);
      }` : ""}
      var sp = pbrSpecular(n, V, sl, shin, sd, sr * pbrKnobs().y);${opts.rect ? `
      if(L.cone.w == -3.0) { sp*=max(sl.y,0.0)/(sd*sd); }` : ""}
      out.spec += L.color.rgb * att * vis * sp.x;
      pbrSpecF += L.color.rgb * att * vis * sp.y;
    }`,
    combineLighting: `let pbrR = pbrPerceptual(gloss.x);
    let pbrF0 = mix(vec3f(0.04), albedo, pbrMetal);
    let pbrAo = min(ao, 1.0);
    col = albedo * (1.0 - pbrMetal) * (amb + direct + moon) + pbrEnvSpecular(n, V, pbrR, pbrF0, pbrAo)`,
    specularCombine: "(pbrF0 * lit.spec + pbrSpecF) * GAIN * pbrSpecOcclusion(max(dot(n, V), 1e-4), pbrAo, pbrR)",
  }
}

/** Composes `physicalLightHooks` under a game's hooks: declarations and fragment starts concatenate, the rest the game wins. */
export function withPhysicalLights(game: SceneHooks, opts: PhysicalLightOptions = {}): SceneHooks {
  const p = physicalLightHooks(opts)
  return {
    ...p,
    ...game,
    declarations: `${game.declarations ?? ""}\n${p.declarations}`,
    fragmentStart: `${p.fragmentStart}\n${game.fragmentStart ?? ""}`,
    lightAttenuation: game.lightAttenuation ?? p.lightAttenuation,
    diffuseTerm: game.diffuseTerm ?? p.diffuseTerm,
    specularTerm: p.specularTerm,
    combineLighting: p.combineLighting,
    specularCombine: p.specularCombine,
  }
}

// ---------------------------------------------------------------- CPU mirrors (tests, tooling)

/** Packs a physical spot into the kit `Light.cone` slot: axis (pointing down or level), cos outer, 3 + cos inner. */
export function physicalCone(axis: readonly [number, number, number], cosOuter: number, cosInner: number): [number, number, number, number] {
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1
  if (axis[1] / len > 1e-6) throw new Error("Physical spot axes point down or level (light.cone stores y ≤ 0)")
  if (!(cosInner > cosOuter) || cosOuter < 0 || cosInner > 1) throw new Error("Physical spot needs 0 ≤ cosOuter < cosInner ≤ 1")
  return [axis[0] / len, axis[2] / len, cosOuter, 3 + cosInner]
}

/** Packs a street lamp into the kit \`Light.cone\` slot: arm (plan, pole → head), lens semi-axes a (along the arm) and b. */
export function streetCone(arm: readonly [number, number], a: number, b: number): [number, number, number, number] {
  const len = Math.hypot(arm[0], arm[1]) || 1
  if (!(b > 0 && b < 0.5) || !(a > 0)) throw new Error("Street lamp lens needs a > 0 and 0 < b < 0.5 m")
  return [arm[0] / len, arm[1] / len, a, 7 + b]
}

export function falloff(d: number, r: number, s: number): number {
  const x = d / Math.max(r, 1e-3)
  const w = Math.max(0, Math.min(1, 1 - x ** 4))
  return (w * w) / Math.max(d * d, Math.max(s * s, 0.01))
}

export function ggxD(nh: number, a2: number): number {
  const d = nh * nh * (a2 - 1) + 1
  return a2 / (Math.PI * d * d)
}

export function smithV(nv: number, nl: number, a: number): number {
  return 0.5 / Math.max(nl * nv * 2 * (1 - a) + (nl + nv) * a, 1e-5)
}

const ENV_A = [1.0791, -0.9213, 0.4656, -0.086, 1.3501, -1.6465, -1.5511, 4.2961, -2.4702] as const
const ENV_B = [0.06, 0.0612, -0.1361, -0.0867, -0.0305, 0.1345, 1.2644, -3.1543, 2] as const

/** CPU mirror of WGSL `pbrEnvBRDF` (scalar F0). */
export function envBRDF(f0: number, rough: number, nv: number): number {
  const e = 2 ** (-9.28 * nv)
  const f = [1, rough, rough * rough, nv, nv * rough, nv * rough * rough, e, e * rough, e * rough * rough]
  const dot = (c: readonly number[]) => f.reduce((s, x, i) => s + x * c[i]!, 0)
  const clamp = (x: number) => Math.max(0, Math.min(1, x))
  return f0 * clamp(dot(ENV_A)) + clamp(dot(ENV_B))
}

/**
 * Reference split-sum environment BRDF by GGX importance sampling with the exact height-correlated Smith G (white
 * environment, F0 scalar). Used to check `envBRDF`.
 */
export function envBRDFReference(f0: number, rough: number, nv: number, samples = 4096): number {
  const a = rough * rough
  const a2 = a * a
  const V = [Math.sqrt(1 - nv * nv), 0, nv]
  const lambda = (c: number) => (-1 + Math.sqrt(1 + (a2 * (1 - c * c)) / Math.max(c * c, 1e-9))) / 2
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const u = (i + 0.5) / samples
    const v = radicalInverse(i)
    const cosT = Math.sqrt((1 - u) / (1 + (a2 - 1) * u))
    const sinT = Math.sqrt(1 - cosT * cosT)
    const phi = 2 * Math.PI * v
    const H = [sinT * Math.cos(phi), sinT * Math.sin(phi), cosT]
    const vh = V[0]! * H[0]! + V[2]! * H[2]!
    const L = [2 * vh * H[0]! - V[0]!, 2 * vh * H[1]! - V[1]!, 2 * vh * H[2]! - V[2]!]
    const nl = L[2]!
    if (nl <= 0 || vh <= 0) continue
    const G = 1 / (1 + lambda(nv) + lambda(nl))
    const w = (G * vh) / (cosT * nv)
    const fc = (1 - vh) ** 5
    sum += (f0 * (1 - fc) + fc) * w
  }
  return sum / samples
}

function radicalInverse(i: number): number {
  let b = i >>> 0
  b = ((b << 16) | (b >>> 16)) >>> 0
  b = (((b & 0x55555555) << 1) | ((b & 0xaaaaaaaa) >>> 1)) >>> 0
  b = (((b & 0x33333333) << 2) | ((b & 0xcccccccc) >>> 2)) >>> 0
  b = (((b & 0x0f0f0f0f) << 4) | ((b & 0xf0f0f0f0) >>> 4)) >>> 0
  b = (((b & 0x00ff00ff) << 8) | ((b & 0xff00ff00) >>> 8)) >>> 0
  return b / 4294967296
}
