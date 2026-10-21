/**
 * Screen-space reflections for wet ground and glossy floors, after Aiden's Ashwood (`render/post.ts`: three's SSRNode
 * in its single-ray blur mode, then his streak pass and his temporal accumulation). It runs as a renderer volume slot
 * (`shaders.volume`) with depth, scene colour, a filter and its own history, so it lands after the temporal resolve:
 *
 * 1. **March** (1/`scale` of the internal size): surfaces whose roughness (the HDR-alpha tag of `./surface`) is under
 *    the cut-off and that face up get a mirror ray, its normal rebuilt from depth and rippled by the wet film
 *    (`./wet`, flat in puddles). The ray is stepped linearly in screen space, `steps` per reflection texel of its
 *    length, from a per-pixel, per-frame jittered start, and a crossing is accepted when the scene point lies within
 *    `thickness` (or three pixels) of the ray; five bisections refine it. Hits beyond `maxDistance` from the surface
 *    plane, off screen or into the sky miss.
 * 2. **Weight** (Ashwood's): gloss × dielectric reflectance × up-facing × (1 − d/maxDistance)² × the grazing term
 *    (I·R + 1)/2 × screen-edge fade × strength × fog transmittance to the surface. A hit replaces the fog sky the
 *    surface already reflects in the scene pass (`skyReplace`), so trees and roofs cut dark shapes into the sky's
 *    reflection; a miss adds nothing and leaves that sky. Bright hits roll off softly past `maxLuminance` (hue kept),
 *    so lamp heads stay bright without fireflies.
 * 3. **Streak** (filter): 17 taps along screen Y over roughness² × reflected distance ÷ view distance, a little
 *    along X, jittered per pixel and frame; at least 1.5 reflection texels, so the low resolution never shows.
 * 4. **History**: the slot's reprojected, 3×3-clipped accumulation, then the depth-aware upsample.
 *
 * `mode: "today"` turns it off (no pass runs). Indoor and outdoor tiers keep Ashwood's numbers: outdoors a quarter
 * of the internal size, 0.2 steps per texel and long streaks; indoors 0.85, 0.6 and short streaks.
 */
import type { LabControl } from "../../lab-navigation"
import { fogParamsWgsl } from "../fog-scatter"
import { VOLUME_PARAM_FLOATS, volumeFrameWgsl, volumeLowDepthWgsl, volumeParamsWgsl, type VolumeInput, type VolumeLightShader } from "../volume-pass"
import { sceneSurfaceWgsl } from "./surface"
import { WET_DEFAULTS, WET_ASPHALT, packWet, wetMaterialWgsl, wetSurfaceWgsl, type WetMaterial, type WetSettings } from "./wet"

export type SsrMode = "today" | "ssr"

export type SsrSettings = {
  mode: SsrMode
  strength: number
  /** Reflectance of wet dielectrics (metals are 1). */
  dielectric: number
  /** Roughness above which nothing reflects. */
  cutoff: number
  /** Vertical streaking outdoors / indoors. */
  streak: number
  streakIndoor: number
  /** Reflected luminance where the soft roll-off starts. */
  maxLuminance: number
  /** Hit thickness (m). */
  thickness: number
  /** Furthest reflected point from the surface plane (m). */
  maxDistance: number
  /** Ray steps per reflection texel, outdoors / indoors. */
  steps: number
  stepsIndoor: number
  /** Long indoor rays need enough samples to hit chair backs and narrow counter edges. */
  maxStepsIndoor: number
  /** Reflection resolution as a share of the internal size, outdoors / indoors. */
  scale: number
  scaleIndoor: number
  /** Share of the fog sky a hit replaces. */
  skyReplace: number
  /** Screen-edge fade width (share of the screen). */
  edgeFade: number
  /** Temporal response: the share of each new frame. */
  history: number
  /** The share of each new frame while the view moves (1 = Today: a moving view drops the history). */
  historyMoving: number
  /** Debug view: the final reflection, the surface weight (gloss × up-facing), or the hit mask. */
  view: "final" | "weight" | "hits"
}

/** Ashwood's Lab values (`post.ssr*`). */
export const SSR_DEFAULTS: SsrSettings = {
  mode: "ssr",
  strength: 1.3,
  dielectric: 0.5,
  cutoff: 0.85,
  streak: 2.2,
  streakIndoor: 0.2,
  maxLuminance: 10,
  thickness: 0.1,
  maxDistance: 30,
  steps: 0.2,
  stepsIndoor: 0.6,
  maxStepsIndoor: 512,
  scale: 0.25,
  scaleIndoor: 0.85,
  skyReplace: 1,
  edgeFade: 0.15,
  history: 0.08,
  historyMoving: 1,
  view: "final",
}

export const createSsrSettings = (overrides: Partial<SsrSettings> = {}): SsrSettings => ({ ...SSR_DEFAULTS, ...overrides })

/** Outdoor cap; the higher-resolution indoor tier has its own bounded budget. */
export const SSR_MAX_STEPS = 64

/** Typed Lab rows; "Reflections" first so Today is one setting away. */
export function ssrControls(group = "Reflections", prefix = ""): LabControl[] {
  const key = (k: keyof SsrSettings) => prefix + k
  const field = (k: keyof SsrSettings) => (prefix ? { field: k } : {})
  const range = (k: keyof SsrSettings, label: string, min: number, max: number, step: number, unit?: string, subsection?: string): LabControl => ({
    key: key(k), ...field(k), label, group, min, max, step, ...(unit ? { unit } : {}), ...(subsection ? { subsection } : {}),
  })
  return [
    { key: key("mode"), ...field("mode"), label: "Reflections", group, type: "select", options: [{ value: "today", label: "Today" }, { value: "ssr", label: "Screen-space" }] },
    range("strength", "Strength", 0, 3, 0.05, "×"),
    range("dielectric", "Dielectric reflectance", 0, 1, 0.01),
    range("cutoff", "Roughness cut-off", 0.1, 1, 0.01),
    range("streak", "Vertical streaking", 0, 4, 0.05, "×"),
    range("skyReplace", "Hits replace sky", 0, 1, 0.01),
    range("maxLuminance", "Highlight roll-off from", 0.05, 20, 0.05, "HDR", "Ray"),
    range("thickness", "Hit thickness", 0.005, 0.5, 0.005, "m", "Ray"),
    range("maxDistance", "Max distance", 2, 80, 1, "m", "Ray"),
    range("edgeFade", "Screen-edge fade", 0, 0.5, 0.01, undefined, "Ray"),
    range("steps", "Ray steps outdoors", 0.05, 1, 0.05, "/texel", "Quality"),
    range("scale", "Resolution outdoors", 0.25, 1, 0.05, "× 3D res", "Quality"),
    range("stepsIndoor", "Ray steps indoors", 0.05, 1, 0.05, "/texel", "Quality"),
    range("maxStepsIndoor", "Indoor step limit", 64, 1024, 32, "steps", "Quality"),
    range("scaleIndoor", "Resolution indoors", 0.25, 1, 0.05, "× 3D res", "Quality"),
    range("streakIndoor", "Streaking indoors", 0, 4, 0.05, "×", "Quality"),
    range("history", "History weight (new frame)", 0.02, 1, 0.01, undefined, "Quality"),
    range("historyMoving", "History weight in motion", 0.05, 1, 0.01, undefined, "Quality"),
    { key: key("view"), ...field("view"), label: "View", group, subsection: "Debug", type: "select", options: [{ value: "final", label: "Final" }, { value: "weight", label: "Surface weight" }, { value: "hits", label: "Ray hits" }] },
  ]
}

/** CPU side: settings → this frame's `VolumeInput` (null when off). */
export class Ssr {
  readonly settings: SsrSettings
  private readonly params = new Float32Array(VOLUME_PARAM_FLOATS)

  constructor(settings: SsrSettings = createSsrSettings()) {
    this.settings = settings
  }

  get enabled(): boolean {
    return this.settings.mode === "ssr"
  }

  volumeInput(opts: { indoor?: boolean; wet?: WetSettings } = {}): VolumeInput | null {
    if (!this.enabled) return null
    const s = this.settings
    const indoor = !!opts.indoor
    const scale = Math.min(1, Math.max(0.1, indoor ? s.scaleIndoor : s.scale))
    const p = this.params
    p.set([s.strength, s.dielectric, s.cutoff, indoor ? s.streakIndoor : s.streak], 0)
    p.set([s.maxLuminance, s.thickness, s.maxDistance, indoor ? s.stepsIndoor : s.steps], 4)
    p.set([s.edgeFade, s.skyReplace, indoor ? Math.max(64, Math.min(1024, Math.round(s.maxStepsIndoor))) : SSR_MAX_STEPS, s.view === "weight" ? 1 : s.view === "hits" ? 2 : 0], 8)
    p.set(packWet(opts.wet ?? WET_DEFAULTS), 12)
    return { downscale: 1 / scale, history: s.history, moving: s.historyMoving, params: p }
  }
}

export type SsrHooks = {
  /** The wet material of the reflecting ground, so the film ripple lines up with the scene's puddles. */
  wetMaterial?: WetMaterial
}

const fullscreen = /* wgsl */ `
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
fn ssrIgn(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715)))); }
`

/** The renderer volume slot (`shaders.volume`); put it before slots that add light into the scene colour. */
export function ssrVolume(hooks: SsrHooks = {}): VolumeLightShader {
  return {
    depth: true,
    history: true,
    color: true,
    lowDepth: true,
    code: /* wgsl */ `
${volumeFrameWgsl}
${volumeLowDepthWgsl}
${fogParamsWgsl}
${volumeParamsWgsl}
${sceneSurfaceWgsl}
${wetSurfaceWgsl}
${fullscreen}
/** View depth of the slot-resolution depth copy at uv (1e9 for sky). */
fn ssrLowW(uv: vec2f) -> f32 { return textureLoad(volumeLowDepth, clamp(vec2i(uv * V.size.xy), vec2i(0), vec2i(V.size.xy) - 1), 0).r; }
/** World point at uv whose view depth (clip w) is w. */
fn ssrWorldFromW(uv: vec2f, w: f32) -> vec3f {
  let dir = normalize(volumeUnproject(uv, 0.5) - V.eye.xyz);
  let k = dot(vec3f(V.viewProj[0].w, V.viewProj[1].w, V.viewProj[2].w), dir);
  return V.eye.xyz + dir * (w / max(k, 1e-6));
}
fn ssrUv(c: vec4f) -> vec2f { return vec2f(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5); }

@fragment fn fs(o: VO) -> @location(0) vec4f {
  let P0 = volumeParams[0];
  let P1 = volumeParams[1];
  let P2 = volumeParams[2];
  let W = volumeParams[3];
  let texelId = volumeTexel(o.uv);
  let uv = (vec2f(texelId) + 0.5) / V.size.zw;
  let d = textureLoad(sceneDepth, texelId, 0);
  if (volumeIsSky(d)) { return vec4f(0.0); }
  let rough = sceneRoughness(uv);
  let glossy = smoothstep(P0.z, P0.z * 0.25, rough);
  if (glossy <= 0.001) { return vec4f(0.0); }
  let eye = V.eye.xyz;
  let p = volumeWorldAtTexel(texelId);
  let rd = normalize(p - eye);
  let ng = volumeNormalAtTexel(texelId, eye);
  let pixel = length(volumeWorldAtTexel(texelId + vec2i(1, 0)) - p);
  let up = smoothstep(0.55, 0.85, ng.y);
  if (P2.w == 1.0) { return vec4f(glossy, up, 1.0 - rough, 0.0); }
  if (glossy * up <= 0.001) { return vec4f(0.0); }
  // The wet film tilts the mirror a little (puddles stay flat), so reflections break up like Ashwood's normal-mapped film.
  let footprint = pixel * V.params.w;
  let wet = wetSurface(p, ng.y, rough, 1.0, footprint, W, ${wetMaterialWgsl(hooks.wetMaterial ?? WET_ASPHALT)});
  let tilt = wetRipple(p, W, wet.flat);
  let n = normalize(ng + vec3f(tilt.x, 0.0, tilt.y));
  let r = reflect(rd, n);
  let cosV = clamp(-dot(rd, ng), 0.0, 1.0);
  let viewDist = length(p - eye);

  // Ray from p to the height maxDistance above the plane, clipped to just in front of the eye.
  var p1 = p + r * min(P1.z / max(dot(r, ng), 0.05), 400.0);
  let c0 = V.viewProj * vec4f(p, 1.0);
  var c1 = V.viewProj * vec4f(p1, 1.0);
  let near = 0.05;
  if (c1.w < near) {
    let t = (c0.w - near) / (c0.w - c1.w);
    c1 = mix(c0, c1, t);
    p1 = mix(p, p1, t);
  }
  let u0 = ssrUv(c0);
  let u1 = ssrUv(c1);
  let lenTexels = max(abs(u1.x - u0.x) * V.size.x, abs(u1.y - u0.y) * V.size.y);
  let steps = clamp(i32(lenTexels * P1.w), 1, i32(P2.z));
  let iw0 = 1.0 / c0.w;
  let iw1 = 1.0 / c1.w;
  let jitter = ssrIgn(floor(o.pos.xy) + V.eye.w * 5.588238);
  // Minimum thickness: three internal pixels at the scene point's depth, plus the ray's own depth change per step.
  let pixelPerDepth = pixel / max(c0.w, 1e-4) * 3.0;
  var lo = 0.0;
  var hi = 0.0;
  var hit = false;
  var prevW = c0.w;
  for (var i = 0; i < steps; i++) {
    let s = max((f32(i) + jitter) / f32(steps), 1.5 / max(lenTexels, 1.0));
    let uv = mix(u0, u1, s);
    if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { break; }
    // March against the slot-resolution copy of the view depth (nearest of each block): one cheap load a step.
    let sceneW = ssrLowW(uv);
    let rayW = 1.0 / mix(iw0, iw1, s);
    if (rayW > sceneW && sceneW < 1e8 && rayW - sceneW <= max(P1.y, sceneW * pixelPerDepth) + abs(rayW - prevW)) {
      hi = s;
      hit = true;
      break;
    }
    prevW = rayW;
    lo = s;
  }
  var refl = vec3f(0.0);
  var hitDist = 1.0;
  if (hit) {
    for (var k = 0; k < 5; k++) {
      let m = (lo + hi) * 0.5;
      if (1.0 / mix(iw0, iw1, m) > ssrLowW(mix(u0, u1, m))) { hi = m; } else { lo = m; }
    }
    let uvH = mix(u0, u1, hi);
    let wH = ssrLowW(uvH);
    let q = ssrWorldFromW(uvH, wH);
    let plane = dot(q - p, ng);
    if (wH < 1e8 && plane <= P1.z) {
      var col = sceneColorAt(uvH);
      let lum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
      // Soft roll-off past maxLuminance (towards twice it), hue kept: lamp heads stay bright, single texels can't spike.
      let over = max(lum - P1.x, 0.0);
      col *= (min(lum, P1.x) + over / (1.0 + over / max(P1.x, 1e-3))) / max(lum, 1e-5);
      let atten = (1.0 - plane / P1.z) * (1.0 - plane / P1.z);
      let grazing = (dot(rd, r) + 1.0) * 0.5;
      let edgeDist = min(min(uvH.x, 1.0 - uvH.x), min(uvH.y, 1.0 - uvH.y));
      let edge = pow(smoothstep(0.0, 1.0, smoothstep(0.0, max(P2.x, 1e-4), edgeDist)), 0.125);
      // The scene pass already mirrors the fog sky here (Schlick-weighted); a hit takes its place.
      let sky = fogEnv(r) * (0.04 + 0.96 * pow(1.0 - cosV, 5.0)) * P2.y;
      refl = (col * P0.y * grazing * P0.x - sky) * glossy * up * atten * edge;
      hitDist = length(q - p);
    }
  }
  if (P2.w == 2.0) { return vec4f(select(vec3f(0.0, 0.0, 0.3), vec3f(1.0, 0.5, 0.0), hit), 0.0); }
  let T = fogTransmittance(eye, p);
  let len = clamp(P0.w * (rough * rough + 0.02) * (hitDist / max(viewDist, 1.0)) * 0.25, 0.0, 0.3);
  return vec4f(refl * T, len);
}
`,
    filter: /* wgsl */ `
@group(0) @binding(0) var volumeRaw: texture_2d<f32>;
@group(0) @binding(1) var volumeSamp: sampler;
${volumeFrameWgsl}
${volumeParamsWgsl}
${fullscreen}
@fragment fn fs(o: VO) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(volumeRaw));
  let len = max(textureSampleLevel(volumeRaw, volumeSamp, o.uv, 0.0).a, texel.y * 1.5);
  let wide = max(len * 0.08, texel.x * 1.5);
  let j = ssrIgn(floor(o.pos.xy) + V.eye.w * 5.588238) - 0.5;
  var acc = vec3f(0.0);
  var wsum = 0.0;
  for (var k = -8; k <= 8; k++) {
    let f = f32(k) / 8.0;
    let wt = exp(-f * f * 2.5);
    let off = vec2f(wide * (j * 1.6 + f * 0.5), len * (j / 8.0 + f));
    acc += textureSampleLevel(volumeRaw, volumeSamp, o.uv + off, 0.0).rgb * wt;
    wsum += wt;
  }
  return vec4f(acc / wsum, 0.0);
}
`,
  }
}
