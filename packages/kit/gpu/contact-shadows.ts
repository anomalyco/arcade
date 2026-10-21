import type { LabControl } from "../lab-panel"
import { common } from "./shaders"
import { volumeFrameWgsl, type VolumeInput, type VolumeLightShader } from "./volume-pass"

/**
 * Screen-space contact shadows (Bend Studio's technique, as in three.js r181 `SSSNode`, MIT): from each pixel's
 * depth-reconstructed position, march a short ray toward the one or two lights that light it most, testing the stored
 * scene depth; a hit within `thickness` behind the depth buffer is a blocker. It grounds what shadow maps are too
 * coarse for: bollards, kerbs, tyres, booth plinths and clutter within a metre of the surface.
 *
 * It runs as a depth-reading volume slot (`Renderer` `shaders.volume`) with a multiplicative composite, so it needs no
 * G-buffer: the normal comes from the depth, and each light's share of the light at the pixel (its diffuse irradiance
 * over the sum of every light's plus the sky's) scales how much its blocked light darkens the scene. Half resolution
 * with its own history and the depth-aware upsample. Under TAA it lands after the resolve.
 */

export type ContactShadowMode = "today" | "screen"

export type ContactShadowSettings = {
  mode: ContactShadowMode
  /** March length toward the light, metres (Bend uses well under a metre). */
  length: number
  /** Steps per light. */
  steps: number
  /** Blockers thinner than this behind the depth buffer count, metres. */
  thickness: number
  /** 0..1: how much of a blocked light is removed. */
  strength: number
  /** Lights marched per pixel (the strongest one or two). */
  lights: 1 | 2
  /** Fade out by this view distance, metres. */
  distance: number
  halfRes: boolean
  /**
   * The share of each new frame while the view moves (1 = Today: a moving view drops the history and shows each
   * frame's raw jittered march). Contact shadows sit on the surfaces the history reprojects by, so keeping it is exact.
   */
  historyMoving: number
}

export const CONTACT_SHADOW_DEFAULTS: Readonly<ContactShadowSettings> = { mode: "today", length: 0.6, steps: 12, thickness: 0.12, strength: 0.85, lights: 2, distance: 45, halfRes: true, historyMoving: 1 }

export const createContactShadowSettings = (overrides: Partial<ContactShadowSettings> = {}): ContactShadowSettings => ({ ...CONTACT_SHADOW_DEFAULTS, ...overrides })

export function contactShadowControls(group = "Lighting", prefix = "contact."): LabControl[] {
  const key = (k: keyof ContactShadowSettings) => ({ key: prefix + k, ...(prefix ? { field: k } : {}) })
  const range = (k: keyof ContactShadowSettings, label: string, min: number, max: number, step: number, unit?: string): LabControl => ({
    ...key(k), label, group, subsection: "Contact shadows", min, max, step, ...(unit ? { unit } : {}),
  })
  return [
    { ...key("mode"), label: "Contact shadows", group, subsection: "Contact shadows", type: "select", options: [{ value: "today", label: "Today" }, { value: "screen", label: "Screen-space" }] },
    range("length", "Length", 0.05, 1.5, 0.01, "m"),
    range("strength", "Strength", 0, 1, 0.01),
    range("thickness", "Blocker thickness", 0.02, 1, 0.01, "m"),
    range("steps", "Steps", 4, 24, 1),
    { ...key("lights"), label: "Lights per pixel", group, subsection: "Contact shadows", type: "select", options: [{ value: 1, label: "1" }, { value: 2, label: "2" }] },
    range("distance", "Fade distance", 5, 120, 1, "m"),
    { ...key("halfRes"), label: "Half resolution", group, subsection: "Contact shadows", type: "toggle" },
    range("historyMoving", "History weight in motion", 0.05, 1, 0.01),
  ]
}

export const CONTACT_KNOB_FLOATS = 8

/** Packs the live knobs: (length, thickness, strength, distance), (steps, lights, -, -). */
export function packContactShadowKnobs<T extends Float32Array>(s: ContactShadowSettings, out: T = new Float32Array(CONTACT_KNOB_FLOATS) as T, offset = 0): T {
  out.set([s.length, s.thickness, s.strength, s.distance, Math.round(s.steps), s.lights, 0, 0], offset)
  return out
}

/** Volume input for `FrameInput.volume` (null: Today, no pass). */
export function contactShadowInput(s: ContactShadowSettings): VolumeInput | null {
  return s.mode === "screen" ? { downscale: s.halfRes ? 2 : 1, history: 0.25, moving: s.historyMoving } : null
}

export type ContactShadowHooks = {
  /** WGSL declarations (e.g. the game's custom uniform and `fogParamsWgsl` for `ambient`). */
  declarations?: string
  /** Two WGSL `vec4f` expressions of `packContactShadowKnobs`. */
  knobs: readonly [string, string]
  /** WGSL `vec3f` of (`p`, `n`): sky/ambient irradiance at the pixel, so lights share the light with it. */
  ambient?: string
  /**
   * WGSL `f32` of (`L: Light`, `p`, `n`): a light's diffuse irradiance (luminance) at the pixel, for games whose lights
   * don't follow the kit's windowed inverse square and physical cones. Default `csIrradiance`.
   */
  irradiance?: string
}

export function contactShadowVolume(hooks: ContactShadowHooks): VolumeLightShader {
  return {
    depth: true,
    history: true,
    composite: "multiply",
    code: /* wgsl */ `
${common}
${volumeFrameWgsl}
${hooks.declarations ?? ""}
fn csKnobsA() -> vec4f { return ${hooks.knobs[0]}; }
fn csKnobsB() -> vec4f { return ${hooks.knobs[1]}; }
fn csAmbient(p: vec3f, n: vec3f) -> vec3f { return ${hooks.ambient ?? "vec3f(0.0)"}; }
fn csLightIrradiance(L: Light, p: vec3f, n: vec3f) -> f32 { return ${hooks.irradiance ?? "csIrradiance(L, p, n)"}; }

struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

fn csPos(uv: vec2f) -> vec3f { return volumeWorldAtTexel(volumeTexel(uv)); }

/**
 * Normal from the scene depth (per axis, the neighbour whose depth is closer, so silhouettes don't smear) in xyz, and in
 * w the depth slope: how far the surface moves along the view ray from one pixel to the next, the march's bias floor.
 */
fn csNormal(uv: vec2f, p: vec3f) -> vec4f {
  // Half-resolution centres lie on full-resolution texel edges. Adding a float
  // UV pixel there can round back into the same texel and collapse a tangent.
  // Load integer neighbours and unproject each at the centre actually sampled.
  let t = volumeTexel(uv);
  let r = volumeWorldAtTexel(t + vec2i(1, 0)) - p;
  let l = p - volumeWorldAtTexel(t - vec2i(1, 0));
  let d = volumeWorldAtTexel(t + vec2i(0, 1)) - p;
  let u = p - volumeWorldAtTexel(t - vec2i(0, 1));
  let dx = select(l, r, dot(r, r) < dot(l, l));
  let dy = select(u, d, dot(d, d) < dot(u, u));
  var n = normalize(cross(dy, dx));
  let v = normalize(V.eye.xyz - p);
  if (dot(n, v) < 0.0) { n = -n; }
  return vec4f(n, max(abs(dot(dx, v)), abs(dot(dy, v))));
}

/** A light's diffuse irradiance (luminance) at p: windowed inverse square, physical spot cone, n·l. */
fn csIrradiance(L: Light, p: vec3f, n: vec3f) -> f32 {
  let power = L.color.w;
  if (power <= 0.001 || L.cone.w >= 4.5) { return 0.0; }
  let lp = L.pos.xyz;
  let toL = lp - p;
  let d = max(length(toL), 0.05);
  let ld = toL / d;
  let ndl = dot(n, ld);
  if (ndl <= 0.0 || d >= L.pos.w) { return 0.0; }
  let x = d / L.pos.w;
  let w = clamp(1.0 - x * x * x * x, 0.0, 1.0);
  var att = power * GAIN * w * w / max(d * d, max(L.extra.z * L.extra.z, 0.01));
  if (L.cone.w >= 2.5) {
    let axis = vec3f(L.cone.x, -sqrt(max(1.0 - dot(L.cone.xy, L.cone.xy), 0.0)), L.cone.y);
    att *= smoothstep(L.cone.z, L.cone.w - 3.0, dot(-ld, axis));
  }
  return att * ndl / PI * dot(L.color.rgb, vec3f(0.2126, 0.7152, 0.0722));
}

/** Occlusion 0..1 toward a light: a jittered march through the stored depth; near hits count fully, far ones less. */
fn csMarch(p: vec3f, n: vec3f, eyeDist: f32, slope: f32, lp: vec3f, jitter: f32) -> f32 {
  let k = csKnobsA();
  let toL = lp - p;
  let dl = length(toL);
  let len = min(k.x, dl - 0.15);
  if (len <= 0.02) { return 0.0; }
  let dir = toL / dl;
  let start = p + n * (0.01 + 0.002 * eyeDist);
  let steps = max(1.0, csKnobsB().x);
  // Nearest-texel depth at a sub-pixel position is off by up to the depth slope: grazing walls would shadow themselves.
  let bias = 0.015 + 0.002 * eyeDist + 2.5 * slope;
  let c0 = V.viewProj * vec4f(p, 1.0);
  let px0 = vec2f(c0.x / c0.w * 0.5 + 0.5, 0.5 - c0.y / c0.w * 0.5) * V.size.zw;
  for (var s = 0.0; s < steps; s += 1.0) {
    let t = (s + jitter) / steps * len;
    let q = start + dir * t;
    let c = V.viewProj * vec4f(q, 1.0);
    if (c.w <= 0.0) { break; }
    let uv = vec2f(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5);
    if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { break; }
    // Samples within two pixels of the start mostly read the surface itself (Bend's near-pixel rejection).
    if (distance(uv * V.size.zw, px0) < 2.0) { continue; }
    let d = volumeDepthAt(uv);
    if (volumeIsSky(d)) { continue; }
    let behind = length(q - V.eye.xyz) - length(csPos(uv) - V.eye.xyz);
    if (behind > bias && behind < k.y) { return 1.0 - 0.5 * t / len; }
  }
  return 0.0;
}

@fragment fn fs(o: VO) -> @location(0) vec4f {
  let d = volumeDepthAt(o.uv);
  if (volumeIsSky(d)) { return vec4f(1.0); }
  let p = csPos(o.uv);
  let eyeDist = length(p - V.eye.xyz);
  let k = csKnobsA();
  let fade = 1.0 - smoothstep(k.w * 0.6, k.w, eyeDist);
  if (fade <= 0.0) { return vec4f(1.0); }
  let ns = csNormal(o.uv, p);
  let n = ns.xyz;
  var e1 = 0.0; var e2 = 0.0; var i1 = 0u; var i2 = 0u;
  var total = dot(csAmbient(p, n), vec3f(0.2126, 0.7152, 0.0722));
  let count = min(u32(F.screen.z), MAX_LIGHTS);
  for (var i = 0u; i < count; i++) {
    let e = csLightIrradiance(lights[i], p, n);
    total += e;
    if (e > e1) { e2 = e1; i2 = i1; e1 = e; i1 = i; } else if (e > e2) { e2 = e; i2 = i; }
  }
  if (total <= 1e-6 || e1 <= 0.0) { return vec4f(1.0); }
  let jitter = fract(52.9829189 * fract(dot(o.pos.xy + V.eye.w * 5.588238, vec2f(0.06711056, 0.00583715))));
  var lost = e1 / total * csMarch(p, n, eyeDist, ns.w, lights[i1].pos.xyz, jitter);
  if (csKnobsB().y > 1.5 && e2 > 0.0) { lost += e2 / total * csMarch(p, n, eyeDist, ns.w, lights[i2].pos.xyz, jitter); }
  let vis = 1.0 - clamp(lost, 0.0, 1.0) * k.z * fade;
  return vec4f(vec3f(vis), 1.0);
}
`,
  }
}
