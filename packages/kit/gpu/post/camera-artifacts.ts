import type { LabControl } from "../../lab-panel"
import type { FinalPass } from "../renderer"
import { cameraFlow } from "./camcorder"

/**
 * What a real night camera adds to the picture, each one its own switch: the tells that make footage read as filmed
 * rather than rendered. Two final passes (`Renderer.setFinalPass`, chained with `FinalPassChain`) so the camera
 * filters (`camcorder.ts`) can sit between them:
 *
 * - **Lens** stage, before a camera filter: autofocus hunting (the frame breathes and defocuses when the subject jumps
 *   to a new depth), condensation creeping in from the edges, lens flare from lights pointed at the lens (aperture
 *   ghosts and a six-blade starburst), dirt and smudges on the front element lit only by bright light, LED PWM banding
 *   from a flickering torch read out by a rolling shutter, a '90s camcorder's infrared monochrome (NightShot) and
 *   sensor gain (grain, chroma blotches and temporal-denoise smear that grow as the scene darkens).
 * - **Codec** stage, last: compression starvation, macroblocks and banding in dark gradients that worsen with camera
 *   motion, stale blocks that drag, and bitrate pumping across each group of pictures.
 *
 * Everything off builds nothing (no textures, pipelines or shader compile) and the renderer composites straight to the
 * canvas. The game feeds `input` every frame: the bright sources aimed at the lens, flickering torches, the subject
 * distance for focus and the exposure gain.
 */
export const CAMERA_ARTIFACT_DEFAULTS = {
  compression: false,
  compressionAmount: 0.7,
  focusHunt: false,
  focusAmount: 0.7,
  sensorGain: false,
  gainAmount: 0.8,
  gainSmear: 0.5,
  pwm: false,
  pwmAmount: 0.8,
  flare: false,
  flareAmount: 0.8,
  dirt: false,
  dirtAmount: 0.7,
  condensation: false,
  /** How far in from the edges the fog has crept (0 edge, 1 most of the frame). */
  condensationAmount: 0.45,
  infrared: false,
  infraredBloom: 0.7,
  /** Infrared's colour: 0 a camcorder's NightShot green, 1 a body camera's grey. */
  infraredTint: 0,
}
export type CameraArtifactSettings = typeof CAMERA_ARTIFACT_DEFAULTS

type V3 = readonly [number, number, number] | readonly number[]
/** A light seen by the lens: `intensity` is its glare at the lens in display-linear units (about 1 = a white patch). */
export type CameraArtifactSource = { pos: V3; intensity: number }
/** A PWM-dimmed torch: its lens, the middle of what it lights and that patch's radius (m), its PWM rate and duty. */
export type CameraArtifactFlicker = { lens: V3; spot: V3; spotRadius: number; hz: number; duty: number; phase: number; level: number }
export type CameraArtifactInput = {
  sources: CameraArtifactSource[]
  flicker: CameraArtifactFlicker[]
  /** Distance to what the camera focuses on (m): the middle of the frame, where the torch lands. */
  focus: number
  /** Exposure gain above base (stops, ≥ 0): the sensor amplifies its noise with it. */
  gain: number
}

export function cameraArtifactControls(options: { group?: string; prefix?: string; subsection?: string } = {}): LabControl[] {
  const { group = "Camera", prefix = "artifacts.", subsection = "Realism" } = options
  const key = (k: keyof CameraArtifactSettings) => ({ key: prefix + k, ...(prefix ? { field: k } : {}) })
  const on = (k: keyof CameraArtifactSettings) => (s: Readonly<Record<string, unknown>>) => s[prefix + k] === true
  const toggle = (k: keyof CameraArtifactSettings, label: string): LabControl => ({ ...key(k), label, group, subsection, type: "toggle" })
  const range = (k: keyof CameraArtifactSettings, label: string, when: keyof CameraArtifactSettings, max = 1): LabControl => ({ ...key(k), label, group, subsection, min: 0, max, step: 0.01, unit: "×", visible: on(when) })
  return [
    toggle("compression", "Compression starvation"),
    range("compressionAmount", "Starvation", "compression"),
    toggle("focusHunt", "Autofocus hunting"),
    range("focusAmount", "Hunt depth", "focusHunt"),
    toggle("sensorGain", "Sensor gain in the dark"),
    range("gainAmount", "Gain noise", "sensorGain", 2),
    range("gainSmear", "Denoise smear", "sensorGain"),
    toggle("pwm", "LED PWM banding"),
    range("pwmAmount", "Banding depth", "pwm"),
    toggle("flare", "Lens flare from torches"),
    range("flareAmount", "Flare", "flare", 2),
    toggle("dirt", "Lens dirt in bright light"),
    range("dirtAmount", "Dirt", "dirt", 2),
    toggle("condensation", "Condensation"),
    range("condensationAmount", "Crept in", "condensation"),
    toggle("infrared", "Infrared monochrome"),
    range("infraredBloom", "IR blooming", "infrared"),
    range("infraredTint", "IR green … grey", "infrared"),
  ]
}

const COMMON = /* wgsl */ `
struct U {
  a: vec4f,  // width, height, time s, dt s
  b: vec4f,  // flow x/y px per s, reset, seed
  f: vec4f,  // focus blur px, breathing scale, gain stops, 30 fps frame time s
  e: vec4f,  // flare, dirt, condensation, pwm
  g: vec4f,  // sensor gain, infrared, compression, source count
  h: vec4f,  // flicker count, condensation reach, readout s, starvation
  k: vec4f,  // denoise smear, infrared bloom, 30 fps frame index, keyframe
  src: array<vec4f, 4>, // x px, y px, intensity, -
  fa: array<vec4f, 4>,  // lens x y px, spot x y px
  fb: array<vec4f, 4>,  // lens radius px, spot radius px, hz, duty
  fc: array<vec4f, 4>,  // phase, level, -, -
  pad: vec4f, // infrared tint (0 green, 1 grey), held frames after this one, -, -
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var src: texture_2d<f32>;
struct V { @builtin(position) pos: vec4f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: V;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  return o;
}
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn h3(x: u32, y: u32, z: u32) -> f32 { return f32(pcg(x ^ pcg(y ^ pcg(z ^ u32(u.b.w))))) / 4294967295.0; }
fn hf(x: f32, y: f32, z: u32) -> f32 { return h3(bitcast<u32>(i32(floor(x))), bitcast<u32>(i32(floor(y))), z); }
fn vnoise2(p: vec2f, z: u32) -> f32 {
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  return mix(mix(hf(p.x, p.y, z), hf(p.x + 1.0, p.y, z), s.x), mix(hf(p.x, p.y + 1.0, z), hf(p.x + 1.0, p.y + 1.0, z), s.x), s.y);
}
fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn toLin(c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(pow((x + 0.055) / 1.055, vec3f(2.4)), x / 12.92, x <= vec3f(0.04045));
}
fn toSrgb(c: vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}
`

const LOCAL_W = 64, LOCAL_H = 36
/** Small passes: the frame's linear local mean (lens stage) and 8×8 block statistics (codec stage). */
const PRE_WGSL = COMMON + /* wgsl */ `
@group(0) @binding(2) var samp: sampler;
@fragment fn fs_local(v: V) -> @location(0) vec4f {
  let cell = 1.0 / vec2f(${LOCAL_W}.0, ${LOCAL_H}.0);
  let base = floor(v.pos.xy) * cell;
  var c = vec3f(0.0);
  for (var j = 0; j < 5; j++) {
    for (var i = 0; i < 5; i++) {
      c += toLin(textureSampleLevel(src, samp, base + (vec2f(f32(i), f32(j)) + 0.5) * cell / 5.0, 0.0).rgb);
    }
  }
  return vec4f(c / 25.0, 1.0);
}
/**
 * Sensor gain's chroma blotches as a lattice: each texel is one value-noise corner (cb, cr), already eased between its
 * two time slices, so the lens pass reads four texels instead of hashing sixteen corners per pixel.
 */
@fragment fn fs_grain(v: V) -> @location(0) vec4f {
  let c = floor(v.pos.xy);
  let tt = u.a.z * 8.0;
  let tb = u32(tt);
  let tf = fract(tt);
  let cb = mix(hf(c.x, c.y, tb + 101u), hf(c.x, c.y, tb + 102u), tf);
  let cr = mix(hf(c.x + 37.0, c.y + 37.0, tb + 201u), hf(c.x + 37.0, c.y + 37.0, tb + 202u), tf);
  return vec4f(cb, cr, 0.0, 1.0);
}
/** Block mean (display values, as a codec sees them) and luma variance from 16 bilinear taps over the 8×8 block. */
@fragment fn fs_blocks(v: V) -> @location(0) vec4f {
  let o = floor(v.pos.xy) * 8.0;
  var m = vec3f(0.0);
  var s2 = 0.0;
  for (var j = 0; j < 4; j++) {
    for (var i = 0; i < 4; i++) {
      let c = textureSampleLevel(src, samp, (o + vec2f(f32(i), f32(j)) * 2.0 + 1.0) / u.a.xy, 0.0).rgb;
      m += c;
      let y = lum(c);
      s2 += y * y;
    }
  }
  m /= 16.0;
  let y = lum(m);
  return vec4f(m, max(s2 / 16.0 - y * y, 0.0));
}
`

const MAIN_COMMON = COMMON + /* wgsl */ `
@group(0) @binding(2) var hist: texture_2d<f32>;
@group(0) @binding(3) var aux: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;
struct Out { @location(0) color: vec4f, @location(1) hist: vec4f };
/** The last picture again (a later pass holds this frame). */
@fragment fn fs_repeat(v: V) -> @location(0) vec4f { return vec4f(textureLoad(hist, vec2i(v.pos.xy), 0).rgb, 1.0); }
`

const LENS_WGSL = MAIN_COMMON + /* wgsl */ `
@group(0) @binding(5) var grain: texture_2d<f32>;
fn S(uv: vec2f) -> vec3f { return toLin(textureSampleLevel(src, samp, uv, 0.0).rgb); }
fn M(uv: vec2f) -> vec3f { return textureSampleLevel(aux, samp, uv, 0.0).rgb; }
/** A defocus disc of radius r px: nine taps on a golden-angle spiral. */
fn disc(q: vec2f, r: f32) -> vec3f {
  let texel = 1.0 / u.a.xy;
  var c = S(q);
  for (var i = 1; i < 9; i++) {
    let t = f32(i) / 8.0;
    let a = f32(i) * 2.39996;
    c += S(q + vec2f(cos(a), sin(a)) * sqrt(t) * r * texel);
  }
  return c / 9.0;
}
/** 1 on the edge of a regular hexagon of circumradius 1 (the six-blade aperture). */
fn hex(p: vec2f) -> f32 {
  let a = atan2(p.y, p.x) + 0.3;
  let sector = a - floor(a / 1.0472 + 0.5) * 1.0472;
  return length(p) * cos(sector) / 0.866;
}
/** One internal reflection: an image of the aperture on the line from the source through the centre. */
fn ghost(px: vec2f, p: vec2f, c: vec2f, k: f32, r: f32, tint: vec3f) -> vec3f {
  let g = c + (c - p) * k;
  let q = (px - g) / r;
  // The hexagon lies inside the unit circle: outside it there is nothing to draw.
  if (dot(q, q) >= 1.0) { return vec3f(0.0); }
  let h = hex(q);
  let body = 1.0 - smoothstep(0.86, 1.0, h);
  let rim = smoothstep(0.55, 0.96, h) * body;
  return tint * (body * 0.45 + rim * 0.7);
}

@fragment fn fs_lens(v: V) -> Out {
  let size = u.a.xy;
  let px = v.pos.xy;
  let uv = px / size;
  let ip = vec2i(px);
  let a2 = vec2f(size.x / size.y, 1.0);
  let sc = size.y / 1080.0;
  let t = u.a.z;
  var res: Out;

  // Autofocus: the lens breathes (magnifies) as it racks and the frame softens while it hunts.
  let q = (uv - 0.5) / u.f.y + 0.5;
  let blur = abs(u.f.x);
  var c = S(q);
  if (blur > 0.35) { c = disc(q, blur); }
  let wide = M(q);

  // Condensation: fog creeps in from the edges in an uneven front; inside it the image blurs and every light
  // spreads into a veil, and the beads along the front catch the light.
  let cond = u.e.z;
  if (cond > 0.001) {
    let p = (uv - 0.5) * 2.0;
    let p2 = p * p;
    let edge = max(sqrt(sqrt(p2.x * p2.x + p2.y * p2.y)), length(p) * 0.72);
    let n = vnoise2(uv * a2 * 4.0 + vec2f(0.0, t * 0.004), 5u) * 0.65 + vnoise2(uv * a2 * 13.0, 6u) * 0.35;
    let front = 1.0 - u.h.y * 0.85;
    let m0 = smoothstep(front - 0.04, front + 0.14, edge + (n - 0.5) * 0.32);
    let m = m0 * cond;
    if (m > 0.001) {
      let fogged = disc(q, (4.0 + 18.0 * m0) * sc);
      // Halos: the neighbourhood's light scattered a long way by the droplets (four wide taps of the local mean).
      let r = 0.06 * vec2f(1.0, a2.x) / a2.x;
      let halo = (M(q + vec2f(r.x, 0.0)) + M(q - vec2f(r.x, 0.0)) + M(q + vec2f(0.0, r.y)) + M(q - vec2f(0.0, r.y))) * 0.25;
      let f = mix(fogged, wide, 0.35 * m0) + (halo * 0.9 + wide * 0.6) * m0 + vec3f(0.0007, 0.0008, 0.0009) * m0;
      c = mix(c, f, m);
    }
  }

  // Lights aimed at the lens: a veil round each (it lights the dirt), the starburst and the ghosts.
  let ns = i32(u.g.w);
  let centre = size * 0.5;
  var veil = 0.0;
  var flare = vec3f(0.0);
  for (var i = 0; i < ns; i++) {
    let s = u.src[i];
    let to = px - s.xy;
    let d = length(to);
    veil += s.z * (exp(-d / (0.2 * size.y)) + 0.05);
    if (u.e.x > 0.0) {
      // The six spikes, cos 3a and sin 3a of the angle turned by 0.3 rad, without an atan2.
      let n = select(vec2f(1.0, 0.0), to / d, d > 1e-6);
      let r = vec2f(n.x * 0.9553365 - n.y * 0.2955202, n.x * 0.2955202 + n.y * 0.9553365);
      let c3 = r.x * (4.0 * r.x * r.x - 3.0);
      let s3 = r.y * (3.0 - 4.0 * r.y * r.y);
      let len = size.y * 0.3 * sqrt(s.z);
      let spikes = pow(abs(c3), 240.0) + 0.3 * pow(abs(s3), 500.0);
      flare += vec3f(1.0, 0.94, 0.86) * s.z * (spikes * exp(-d / max(len, 1.0)) * 0.5 + exp(-d / (0.012 * size.y)) * 0.6 + exp(-d / (0.05 * size.y)) * 0.06);
      let h = size.y;
      var gh = ghost(px, s.xy, centre, -0.42, 0.022 * h, vec3f(0.35, 1.0, 0.55));
      gh += ghost(px, s.xy, centre, 0.35, 0.045 * h, vec3f(1.0, 0.5, 0.2));
      gh += ghost(px, s.xy, centre, 0.72, 0.085 * h, vec3f(0.3, 0.5, 1.0) * 0.7);
      gh += ghost(px, s.xy, centre, 1.08, 0.03 * h, vec3f(0.9, 0.3, 0.85));
      gh += ghost(px, s.xy, centre, 1.55, 0.13 * h, vec3f(0.45, 0.85, 0.5) * 0.4);
      flare += gh * s.z * 0.035;
    }
  }
  c += flare * u.e.x;

  // Dirt on the front element: smudges, specks and a thumb print, invisible until bright light falls on them.
  if (u.e.y > 0.0) {
    let w = uv * a2;
    let smudge = smoothstep(0.52, 0.86, vnoise2(w * 3.2 + 3.0, 21u) * 0.55 + vnoise2(w * 9.0, 22u) * 0.3 + vnoise2(w * 27.0, 23u) * 0.15);
    let cs = 26.0 * sc;
    let cell = floor(px / cs);
    let at = (cell + vec2f(hf(cell.x, cell.y, 31u), hf(cell.x, cell.y, 32u))) * cs;
    let rad = (2.0 + 7.0 * hf(cell.x, cell.y, 33u)) * sc;
    let speck = step(0.82, hf(cell.x, cell.y, 34u)) * (1.0 - smoothstep(rad * 0.5, rad, length(px - at)));
    let fp = (uv - vec2f(0.66, 0.6)) * a2 * vec2f(1.0, 1.3);
    let print = (0.5 + 0.5 * sin(length(fp) * 420.0 + vnoise2(fp * 30.0, 35u) * 4.0)) * (1.0 - smoothstep(0.04, 0.12, length(fp)));
    let mask = smudge * 0.7 + speck * 0.8 + print * 0.45;
    let light = veil + max(lum(wide) - 0.06, 0.0) * 3.0;
    c += vec3f(1.0, 0.95, 0.86) * mask * light * u.e.y * 0.22;
  }

  // PWM: a dimmed LED torch blinks hundreds of times a second; a rolling shutter reads each row at a different
  // moment, so what that torch lights (its lens, the air in its beam, its patch) comes out in rolling bands.
  let nf = i32(u.h.x);
  if (u.e.w > 0.0) {
    for (var i = 0; i < nf; i++) {
      let a = u.fa[i].xy;
      let ab = u.fa[i].zw - a;
      let tt = clamp(dot(px - a, ab) / max(dot(ab, ab), 1e-3), 0.0, 1.0);
      let r = mix(u.fb[i].x, u.fb[i].y, tt);
      let dd = length(px - (a + ab * tt)) / max(r, 1.0);
      let w = exp(-dd * dd * 1.5) * u.fc[i].y;
      let ph = fract((u.f.w + uv.y * u.h.z) * u.fb[i].z + u.fc[i].x);
      let duty = u.fb[i].w;
      let lit = smoothstep(0.0, 0.04, ph) * (1.0 - smoothstep(duty, duty + 0.04, ph));
      c *= mix(1.0, mix(0.35, 1.3, lit), w * u.e.w);
    }
  }

  // NightShot: the sensor without its IR-cut filter, shown as green monochrome; whites bloom, blacks crush.
  let ir = u.g.y;
  if (ir > 0.0) {
    let y = lum(c) * 1.5 + max(lum(wide) - 0.04, 0.0) * 5.0 * u.k.y;
    let ys = clamp((toSrgb(vec3f(y)).x - 0.08) / 0.84, 0.0, 1.0);
    let tint = mix(vec3f(0.34, 0.8, 0.32), vec3f(0.62, 0.64, 0.66), u.pad.x);
    let mono = mix(tint * ys, mix(vec3f(0.86, 1.0, 0.82), vec3f(0.95, 0.96, 0.97), u.pad.x), smoothstep(0.7, 1.0, ys) * 0.8);
    c = mix(c, toLin(mono), ir);
  }

  var d = toSrgb(c);
  // Sensor gain: grain, a faint column pattern and crawling chroma blotches, larger the darker the scene and the
  // more the camera has opened up; then temporal noise reduction smears dark areas that move.
  let gainA = u.g.x;
  var raw = d;
  var smear = 0.0;
  if (gainA > 0.0) {
    let gain = clamp(u.f.z, 0.0, 4.0);
    let dark = 1.0 - smoothstep(0.0, 0.3, lum(toSrgb(wide)));
    let darkPx = 1.0 - smoothstep(0.02, 0.5, lum(d));
    let sigma = gainA * (0.028 + 0.022 * gain) * (0.4 + 0.6 * dark) * (0.5 + darkPx);
    let tk = u32(u.k.z);
    let g1 = hf(px.x, px.y, tk * 3u + 1u) + hf(px.x, px.y, tk * 3u + 2u) - 1.0;
    // Chroma blotches: value noise from the lattice pass (fs_grain), eased between its corners.
    let gp = px / (7.0 * sc);
    let gi = vec2i(floor(gp));
    let gf = fract(gp);
    let ge = gf * gf * (3.0 - 2.0 * gf);
    let g00 = textureLoad(grain, gi, 0).xy;
    let g10 = textureLoad(grain, gi + vec2i(1, 0), 0).xy;
    let g01 = textureLoad(grain, gi + vec2i(0, 1), 0).xy;
    let g11 = textureLoad(grain, gi + vec2i(1, 1), 0).xy;
    let blot = mix(mix(g00, g10, ge.x), mix(g01, g11, ge.x), ge.y) - 0.5;
    let cb = blot.x;
    let cr = blot.y;
    let fpn = (hf(px.x, 0.0, 77u) - 0.5) * 0.35;
    d += vec3f(g1 + fpn) * sigma + vec3f(1.4 * cr, -0.34 * cb - 0.71 * cr, 1.77 * cb) * sigma * 1.8 * (0.3 + dark);
    raw = d;
    smear = u.k.x * 0.88 * (0.25 + 0.75 * darkPx) * min(gainA, 1.0);
    if (u.b.z < 0.5) {
      let h = textureLoad(hist, ip, 0).rgb;
      d = mix(d, h, smear * (1.0 - smoothstep(0.05, 0.22, length(d - h))));
    }
  }
  d = clamp(d, vec3f(0.0), vec3f(1.0));
  res.color = vec4f(d, 1.0);
  // Each held frame after this one (a later pass repeats the picture) smeared this exposure into the history again
  // when the lens ran every frame; the denoise keeps that pace.
  var h = d;
  if (smear > 0.0) {
    for (var i = 0; i < i32(u.pad.y); i++) {
      h = clamp(mix(raw, h, smear * (1.0 - smoothstep(0.05, 0.22, length(raw - h)))), vec3f(0.0), vec3f(1.0));
    }
  }
  res.hist = vec4f(h, 1.0);
  return res;
}
`

const CODEC_WGSL = MAIN_COMMON + /* wgsl */ `
fn B(i: vec2i) -> vec4f { return textureLoad(aux, clamp(i, vec2i(0), vec2i(textureDimensions(aux)) - 1), 0); }
@fragment fn fs_codec(v: V) -> Out {
  let px = v.pos.xy;
  let ip = vec2i(px);
  var res: Out;
  let c = textureLoad(src, ip, 0).rgb;
  let q = clamp(u.g.z * u.h.w, 0.0, 1.5);
  let bi = vec2i(floor(px / 8.0));
  var bm = B(bi);
  // Starved: 16×16 macroblocks go flat together.
  let big = smoothstep(0.55, 1.0, q);
  if (big > 0.0) {
    let b2 = (bi / 2) * 2;
    let m16 = (B(b2) + B(b2 + vec2i(1, 0)) + B(b2 + vec2i(0, 1)) + B(b2 + vec2i(1, 1))) * 0.25;
    bm = vec4f(mix(bm.rgb, m16.rgb, big), max(bm.a, m16.a * big));
  }
  let yb = lum(bm.rgb);
  let dark = 1.0 - smoothstep(0.05, 0.4, yb);
  let flat = 1.0 - smoothstep(0.0003, 0.003, bm.a);
  let loss = clamp(q * (0.35 + 0.65 * flat) * (0.25 + 0.75 * dark) * 1.3, 0.0, 0.97);
  // DC coarsely quantised in the dark (the banding steps), plus a little of each block's slope from its neighbours, so
  // a dark gradient becomes a staircase of tiles.
  let levels = mix(110.0, 14.0, clamp(q * dark, 0.0, 1.0));
  let dc = floor(bm.rgb * levels + 0.5) / levels;
  let gx = B(bi + vec2i(1, 0)).rgb - B(bi - vec2i(1, 0)).rgb;
  let gy = B(bi + vec2i(0, 1)).rgb - B(bi - vec2i(0, 1)).rgb;
  let f = fract(px / 8.0) - 0.5;
  // Fades in with quality loss, so a zero amount reconstructs the source exactly.
  let plane = mix(bm.rgb, dc + (gx * f.x + gy * f.y) * 0.3, clamp(q * 4.0, 0.0, 1.0));
  var rec = plane + (c - bm.rgb) * (1.0 - loss);
  // Chroma is cheap to drop: it goes to the block's.
  let cm = bm.rgb - vec3f(yb);
  rec = mix(rec, vec3f(lum(rec)) + cm, loss * 0.7);
  // Mosquito noise round edges in busy blocks.
  rec += vec3f(hf(px.x, px.y, u32(u.k.z) + 400u) - 0.5) * sqrt(bm.a) * q * 0.7 * (1.0 - flat);
  // Skipped blocks: flat dark blocks keep the last frame's content until the next keyframe refreshes them, so they
  // drag behind a pan.
  if (u.b.z < 0.5 && u.k.w < 0.5) {
    // Whole regions skip together (the encoder spends nothing on a flat dark patch), not single blocks.
    let tick = u32(u.k.z * 0.5);
    let hold = vnoise2(vec2f(bi) / 5.0 + f32(tick % 7u) * 3.7, tick + 501u);
    if (hold < q * 0.5 * flat * dark) { rec = textureLoad(hist, ip, 0).rgb; }
  }
  res.color = vec4f(clamp(rec, vec3f(0.0), vec3f(1.0)), 1.0);
  res.hist = res.color;
  return res;
}
`

/** The passes' shaders, for validation. */
export const CAMERA_ARTIFACT_WGSL = { pre: PRE_WGSL, lens: LENS_WGSL, codec: CODEC_WGSL }

const UNIFORM_FLOATS = 96
const MAX_SOURCES = 4

export type CameraArtifactStage = "lens" | "codec"
type Targets = { width: number; height: number; source: GPUTexture; sourceView: GPUTextureView; hist: [GPUTexture, GPUTexture]; histViews: [GPUTextureView, GPUTextureView]; aux: GPUTexture; auxView: GPUTextureView; grain: GPUTexture; grainView: GPUTextureView }

/** One stage of the camera artifacts as a final pass. Share `settings` and `input` between the two stages. */
export class CameraArtifacts implements FinalPass {
  input: CameraArtifactInput = { sources: [], flicker: [], focus: 10, gain: 0 }
  private targets: Targets | null = null
  private pipes: { pre?: GPURenderPipeline; grain?: GPURenderPipeline; main?: GPURenderPipeline; repeat?: GPURenderPipeline } = {}
  private layouts: { pre: GPUBindGroupLayout; main: GPUBindGroupLayout } | null = null
  private groups: { pre: GPUBindGroup; main: [GPUBindGroup, GPUBindGroup] } | null = null
  private sampler: GPUSampler | null = null
  private uniform: GPUBuffer | null = null
  private readonly data = new Float32Array(UNIFORM_FLOATS)
  private readonly prev = new Float32Array(20)
  private readonly inverse = new Float32Array(16)
  private flow: [number, number] = [0, 0]
  private parity = 0
  private valid = false
  private lastTime = 0
  /** Frames the chain left this pass out of since it last drew, and as many before that (`skip`). */
  private skipped = 0
  private echoes = 0
  /** Autofocus in dioptres: where the lens is, its velocity, what it is racking to, how long the subject has been off. */
  private af = { lens: 0.1, v: 0, aim: 0.1, off: 0, hunt: 0 }
  /** Bitrate envelope: how starved the encoder is (fast attack on motion, slow recovery). */
  private starve = 0
  /** Multiplies every effect's amount this frame (a game clearing the picture while you read a map), leaving the knobs alone. */
  strengthScale = 1

  constructor(private readonly device: GPUDevice, private readonly format: GPUTextureFormat, readonly settings: CameraArtifactSettings, readonly stage: CameraArtifactStage, private readonly seed = 7) {}

  get active(): boolean {
    const s = this.settings
    const on = this.stage === "codec" ? s.compression : s.focusHunt || s.sensorGain || s.pwm || s.flare || s.dirt || s.condensation || s.infrared
    if (!on) {
      this.valid = false
      // Off holds no full-size textures; the next frame on allocates them again.
      if (this.targets) this.releaseTargets()
    }
    return on
  }

  source(width: number, height: number): GPUTextureView {
    if (!this.targets || this.targets.width !== width || this.targets.height !== height) this.resize(width, height)
    return this.targets!.sourceView
  }

  /** Camera state as the last frame left it (automation). */
  get state() { return { focusBlur: this.data[8]!, breath: this.data[9]!, starve: this.starve, flow: [...this.flow] } }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, frame: Float32Array): void {
    const t = this.targets
    if (!t) return
    this.ensure()
    const time = frame[19]!
    const dt = time - this.lastTime
    const continuous = this.valid && dt >= 0 && dt < 0.25
    if (continuous && dt > 0) {
      const [fx, fy] = cameraFlow(frame, this.prev, t.width, t.height, this.inverse)
      const k = 1 - Math.exp(-dt / 0.05)
      this.flow[0] += (fx / dt - this.flow[0]) * k
      this.flow[1] += (fy / dt - this.flow[1]) * k
    } else if (!continuous) this.flow = [0, 0]
    this.prev.set(frame.subarray(0, 20))
    this.echoes = continuous ? Math.min(this.skipped, 4) : 0
    this.skipped = 0
    this.pack(frame, time, continuous ? Math.max(dt, 0) : 0, !continuous, t.width, t.height)
    this.device.queue.writeBuffer(this.uniform!, 0, this.data)
    const read = this.parity, write = 1 - read
    const small = (view: GPUTextureView, pipe: GPURenderPipeline) => {
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] })
      pass.setPipeline(pipe)
      pass.setBindGroup(0, this.groups!.pre)
      pass.draw(3)
      pass.end()
    }
    small(t.auxView, this.pipes.pre!)
    if (this.stage === "lens" && this.data[16]! > 0) small(t.grainView, this.pipes.grain!)
    const main = encoder.beginRenderPass({ colorAttachments: [
      { view: target, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } },
      { view: t.histViews[write], loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } },
    ] })
    main.setPipeline(this.pipes.main!)
    main.setBindGroup(0, this.groups!.main[read])
    main.draw(3)
    main.end()
    this.parity = write
    this.valid = true
    this.lastTime = time
  }

  /** A frame a later pass holds, drawn without this one (`FinalPassChain`). */
  skip(_frame: Float32Array): void {
    if (this.valid) this.skipped++
  }

  /**
   * Draws the last picture again without reading the source, for a frame a later pass holds (`FinalPassChain`); false
   * when there is none yet.
   */
  repeat(encoder: GPUCommandEncoder, target: GPUTextureView): boolean {
    const t = this.targets
    if (!t || !this.valid) return false
    this.ensure()
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
    pass.setPipeline(this.pipes.repeat!)
    // The group that reads the history written last.
    pass.setBindGroup(0, this.groups!.main[this.parity])
    pass.draw(3)
    pass.end()
    return true
  }

  dispose(): void {
    this.releaseTargets()
    this.uniform?.destroy()
  }

  private releaseTargets() {
    const t = this.targets
    t?.source.destroy(); t?.hist.forEach(h => h.destroy()); t?.aux.destroy(); t?.grain.destroy()
    this.targets = null
    this.groups = null
  }

  private stepFocus(dt: number, focus: number, amount: number) {
    const af = this.af
    const subject = 1 / Math.max(0.3, focus)
    if (dt <= 0) { Object.assign(af, { lens: subject, v: 0, aim: subject, off: 0, hunt: 0 }); return }
    // Contrast-detect AF: it waits a moment after the subject changes depth, starts the wrong way, swings past and
    // settles; small changes it ignores.
    af.off = Math.abs(subject - af.aim) > 0.08 ? af.off + dt : 0
    if (af.off > 0.18) {
      af.aim = subject
      af.off = 0
      af.hunt = 0.14
      af.v = Math.sign(af.lens - subject || 1) * (1.5 + 2.5 * amount)
    }
    for (let left = dt; left > 1e-6; left -= 1 / 240) {
      const h = Math.min(left, 1 / 240)
      if (af.hunt > 0) af.hunt -= h
      else {
        const omega = 11, zeta = 0.85 - 0.6 * amount
        af.v += (omega * omega * (af.aim - af.lens) - 2 * zeta * omega * af.v) * h
      }
      af.lens += af.v * h
    }
  }

  private pack(frame: Float32Array, time: number, dt: number, reset: boolean, width: number, height: number) {
    const s = this.settings, u = this.data, inp = this.input
    const codec = this.stage === "codec"
    const k = Math.max(0, Math.min(1, this.strengthScale))
    const sc = height / 1080
    // Focus.
    const fa = s.focusHunt && !codec ? s.focusAmount * k : 0
    this.stepFocus(dt, inp.focus, fa)
    const subject = 1 / Math.max(0.3, inp.focus)
    const blur = fa > 0 ? Math.max(-14, Math.min(14, (this.af.lens - subject) * 10 * fa)) * sc : 0
    const breath = 1 + fa * 0.03 * Math.max(-1, Math.min(1, this.af.lens - 0.3))
    // Bitrate: motion (screen heights per second) starves the encoder at once; it recovers over about a second.
    const motion = Math.hypot(this.flow[0], this.flow[1]) / height
    const demand = 0.3 + 1.5 * Math.min(motion, 1.2)
    const rate = demand > this.starve ? 0.06 : 0.9
    this.starve = reset ? demand : this.starve + (demand - this.starve) * (1 - Math.exp(-dt / rate))
    // Group of pictures: a keyframe each second, quality sagging between them.
    const fps = 30, index = Math.floor(time * fps), gop = (index % fps) / fps
    const pump = this.starve * (0.6 + 0.55 * gop)
    // Project the sources and flicker patches.
    const p11 = Math.hypot(frame[1]!, frame[5]!, frame[9]!)
    const project = (p: V3): [number, number, number] | null => {
      const x = p[0]!, y = p[1]!, z = p[2]!
      const cx = frame[0]! * x + frame[4]! * y + frame[8]! * z + frame[12]!
      const cy = frame[1]! * x + frame[5]! * y + frame[9]! * z + frame[13]!
      const cw = frame[3]! * x + frame[7]! * y + frame[11]! * z + frame[15]!
      if (!(cw > 0.05)) return null
      return [((cx / cw) * 0.5 + 0.5) * width, (0.5 - (cy / cw) * 0.5) * height, cw]
    }
    const pxPerMetre = (w: number) => (p11 / w) * height * 0.5
    u.fill(0)
    let ns = 0
    if (!codec) for (const src of inp.sources) {
      if (ns >= MAX_SOURCES || !(src.intensity > 1e-4)) continue
      const p = project(src.pos)
      // Ghosts persist with the source a little off frame; past that the lens hood hides it.
      if (!p || p[0] < -0.25 * width || p[0] > 1.25 * width || p[1] < -0.25 * height || p[1] > 1.25 * height) continue
      u.set([p[0], p[1], src.intensity, 0], 28 + ns * 4)
      ns++
    }
    let nf = 0
    if (!codec && s.pwm) for (const f of inp.flicker) {
      if (nf >= MAX_SOURCES || !(f.level > 0)) continue
      const a = project(f.lens), b = project(f.spot)
      if (!a && !b) continue
      const lens = a ?? b!, spot = b ?? a!
      u.set([lens[0], lens[1], spot[0], spot[1]], 44 + nf * 4)
      u.set([Math.max(6 * sc, pxPerMetre(lens[2]) * 0.6), Math.max(10 * sc, pxPerMetre(spot[2]) * f.spotRadius), f.hz, f.duty], 60 + nf * 4)
      u.set([f.phase, f.level, 0, 0], 76 + nf * 4)
      nf++
    }
    const lens = !codec
    u.set([
      width, height, time, dt,
      this.flow[0], this.flow[1], reset ? 1 : 0, this.seed,
      blur, breath, Math.max(0, inp.gain), index / fps,
      lens && s.flare ? s.flareAmount * k : 0, lens && s.dirt ? s.dirtAmount * k : 0, lens && s.condensation ? k : 0, lens && s.pwm ? s.pwmAmount * k : 0,
      lens && s.sensorGain ? s.gainAmount * k : 0, lens && s.infrared ? k : 0, codec && s.compression ? s.compressionAmount * k : 0, ns,
      nf, s.condensationAmount, 1 / 32, pump,
      s.gainSmear, s.infraredBloom, index, index % fps === 0 ? 1 : 0,
    ], 0)
    u[92] = s.infraredTint
    u[93] = this.echoes
  }

  private resize(width: number, height: number) {
    const d = this.device
    this.releaseTargets()
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    const make = (label: string) => d.createTexture({ label, size: [width, height], format: this.format, usage })
    const source = make(`camera ${this.stage} source`)
    const hist: [GPUTexture, GPUTexture] = [make(`camera ${this.stage} history a`), make(`camera ${this.stage} history b`)]
    const auxSize = this.stage === "lens" ? [LOCAL_W, LOCAL_H] : [Math.ceil(width / 8), Math.ceil(height / 8)]
    const aux = d.createTexture({ label: `camera ${this.stage} ${this.stage === "lens" ? "local mean" : "blocks"}`, size: auxSize, format: "rgba16float", usage })
    // Sensor gain's chroma lattice: one texel per blotch cell (7 px at 1080 lines) and a spare row and column.
    const cell = (7 * height) / 1080
    const grain = d.createTexture({ label: `camera ${this.stage} grain lattice`, size: this.stage === "lens" ? [Math.ceil(width / cell) + 2, Math.ceil(height / cell) + 2] : [1, 1], format: "rg32float", usage })
    this.targets = { width, height, source, sourceView: source.createView(), hist, histViews: [hist[0].createView(), hist[1].createView()], aux, auxView: aux.createView(), grain, grainView: grain.createView() }
    this.valid = false
    this.groups = null
  }

  private ensure() {
    const d = this.device
    if (!this.layouts) {
      const F = GPUShaderStage.FRAGMENT, FV = GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX
      this.layouts = {
        pre: d.createBindGroupLayout({ label: "camera artifacts pre", entries: [
          { binding: 0, visibility: FV, buffer: { type: "uniform" } },
          { binding: 1, visibility: F, texture: { sampleType: "float" } },
          { binding: 2, visibility: F, sampler: { type: "filtering" } },
        ] }),
        main: d.createBindGroupLayout({ label: "camera artifacts", entries: [
          { binding: 0, visibility: FV, buffer: { type: "uniform" } },
          { binding: 1, visibility: F, texture: { sampleType: "float" } },
          { binding: 2, visibility: F, texture: { sampleType: "float" } },
          { binding: 3, visibility: F, texture: { sampleType: "float" } },
          { binding: 4, visibility: F, sampler: { type: "filtering" } },
          { binding: 5, visibility: F, texture: { sampleType: "unfilterable-float" } },
        ] }),
      }
      this.sampler = d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
      this.uniform = d.createBuffer({ label: "camera artifacts", size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    }
    if (!this.pipes.main) {
      const L = this.layouts
      const lens = this.stage === "lens"
      const preModule = d.createShaderModule({ label: "camera artifacts pre", code: PRE_WGSL })
      this.pipes.pre = d.createRenderPipeline({ label: `camera ${this.stage} pre`, layout: d.createPipelineLayout({ bindGroupLayouts: [L.pre] }), vertex: { module: preModule, entryPoint: "vs" }, fragment: { module: preModule, entryPoint: lens ? "fs_local" : "fs_blocks", targets: [{ format: "rgba16float" }] }, primitive: { topology: "triangle-list" } })
      const module = d.createShaderModule({ label: `camera ${this.stage}`, code: lens ? LENS_WGSL : CODEC_WGSL })
      const mainLayout = d.createPipelineLayout({ bindGroupLayouts: [L.main] })
      this.pipes.main = d.createRenderPipeline({ label: `camera ${this.stage}`, layout: mainLayout, vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: lens ? "fs_lens" : "fs_codec", targets: [{ format: this.format }, { format: this.format }] }, primitive: { topology: "triangle-list" } })
      this.pipes.repeat = d.createRenderPipeline({ label: `camera ${this.stage} repeat`, layout: mainLayout, vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs_repeat", targets: [{ format: this.format }] }, primitive: { topology: "triangle-list" } })
      if (lens) this.pipes.grain = d.createRenderPipeline({ label: "camera lens grain lattice", layout: d.createPipelineLayout({ bindGroupLayouts: [L.pre] }), vertex: { module: preModule, entryPoint: "vs" }, fragment: { module: preModule, entryPoint: "fs_grain", targets: [{ format: "rg32float" }] }, primitive: { topology: "triangle-list" } })
    }
    if (!this.groups) {
      const t = this.targets!, L = this.layouts
      this.groups = {
        pre: d.createBindGroup({ layout: L.pre, entries: [{ binding: 0, resource: { buffer: this.uniform! } }, { binding: 1, resource: t.sourceView }, { binding: 2, resource: this.sampler! }] }),
        main: [0, 1].map(i => d.createBindGroup({ layout: L.main, entries: [
          { binding: 0, resource: { buffer: this.uniform! } },
          { binding: 1, resource: t.sourceView },
          { binding: 2, resource: t.histViews[i]! },
          { binding: 3, resource: t.auxView },
          { binding: 4, resource: this.sampler! },
          { binding: 5, resource: t.grainView },
        ] })) as [GPUBindGroup, GPUBindGroup],
      }
    }
  }
}
