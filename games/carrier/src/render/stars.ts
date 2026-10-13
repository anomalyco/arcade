import { ATMOSPHERE_WGSL } from "./atmosphere"
import { FRAME_BINDING_WGSL } from "./frame"
import type { RelView } from "./ocean-view"
import type { Renderer, ScenePass } from "./renderer"

/** Fixed stars, Milky Way stars, and the soft glow blobs along the Milky Way. */
const STARS = 7000
const BAND_STARS = 4500
const BLOBS = 360
const COUNT = STARS + BAND_STARS + BLOBS

/**
 * Stars, the Milky Way and the moon ("sky" slot, after the sky): instanced point sprites on the celestial sphere,
 * turned by the day cycle's star rotation, fading with the night and hidden under an overcast (Frame zenith.w), and the
 * moon disc with its phase lit by the true sun. Drawn at infinity with no depth, so islands, clouds and the sea cover
 * them. The moon sits where the sky paints its key-light disc at night (DayNight.moonView), so it covers that plain
 * disc and its glitter path on the sea lines up.
 */
const STARS_WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
${ATMOSPHERE_WGSL}
struct StarU {
  viewProjRel: mat4x4f,
  rot0: vec4f, rot1: vec4f, rot2: vec4f,
  p: vec4f,        // star brightness, glow brightness, pixels per radian, moon visibility
  moon: vec4f,     // painted moon direction, angular radius
  moonSun: vec4f,  // true sun direction (lights the phase), moon brightness
  moonDark: vec4f, // dark limb colour, unused
}
@group(1) @binding(0) var<uniform> U: StarU;
@group(1) @binding(1) var<storage, read> stars: array<vec4f>;

const TAU: f32 = 6.2831853;

fn hash11(n: u32) -> f32 {
  var h = n * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return f32((h >> 22u) ^ h) * (1.0 / 4294967296.0);
}

struct SO {
  @builtin(position) pos: vec4f,
  @location(0) corner: vec2f,
  @location(1) @interpolate(flat) color: vec3f,
  @location(2) @interpolate(flat) blob: f32,
}

const CORNERS = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));

@vertex fn vsStar(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SO {
  let s = stars[ii];
  let dir = normalize(U.rot0.xyz * s.x + U.rot1.xyz * s.y + U.rot2.xyz * s.z);
  var o: SO;
  o.corner = CORNERS[vi];
  let clip = U.viewProjRel * vec4f(dir * 20000.0, 1.0);
  let blob = s.w < 0.0;
  // Extinction toward the horizon: stars thin out and vanish in the low haze.
  let low = smoothstep(-0.01, select(0.1, 0.25, blob), dir.y);
  let veil = 1.0 - overcast();
  var bright: f32;
  var px: f32;
  if (blob) {
    px = -s.w * U.p.z;
    bright = U.p.y * (0.5 + hash11(ii * 3u + 1u));
    o.color = vec3f(0.55, 0.62, 0.9) * bright * low * veil;
  } else {
    let m = s.w;
    px = 1.2 + 1.4 * m;
    // Twinkle at whole cycles per TIME_WRAP (3600 s), so the wrap never jumps.
    let f = TAU * (5400.0 + floor(hash11(ii * 7u + 3u) * 4000.0)) / 3600.0;
    let tw = 1.0 + 0.28 * sin(F.eye.w * f + hash11(ii) * TAU) * (1.0 - low * 0.6);
    bright = U.p.x * (0.3 + 1.2 * m * m) * tw;
    // Temperature: mostly blue-white, a few warm.
    let k = hash11(ii * 5u + 2u);
    let tint = select(select(vec3f(0.82, 0.9, 1.0), vec3f(1.0, 0.9, 0.75), k > 0.78), vec3f(1.0, 0.72, 0.55), k > 0.95);
    o.color = tint * bright * low * veil;
  }
  o.blob = select(0.0, 1.0, blob);
  let hidden = dir.y < -0.01 || clip.w <= 0.0 || max(o.color.r, max(o.color.g, o.color.b)) < 1e-4;
  o.pos = clip + vec4f(o.corner * px * 2.0 * F.viewport.zw * clip.w, 0.0, 0.0);
  o.pos.z = 0.0;
  if (hidden) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); }
  return o;
}

@fragment fn fsStar(o: SO) -> @location(0) vec4f {
  let d2 = dot(o.corner, o.corner);
  let core = select(exp(-d2 * 5.0), exp(-d2 * 2.5) * (1.0 - smoothstep(0.6, 1.0, d2)), o.blob > 0.5);
  return vec4f(o.color * core, 0.0);
}

struct MO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

/** Quad around the disc (1.6 x its radius, for the soft rim and the dark limb against the halo). */
const MOON_PAD: f32 = 1.6;

fn moonFrame() -> mat3x3f {
  let d = normalize(U.moon.xyz);
  let r = normalize(vec3f(-d.z, 0.0, d.x));
  let u = cross(r, d);
  return mat3x3f(r, u, d);
}

@vertex fn vsMoon(@builtin(vertex_index) vi: u32) -> MO {
  let c = CORNERS[vi];
  let fr = moonFrame();
  let k = tan(U.moon.w) * MOON_PAD;
  let dir = fr[2] + (fr[0] * c.x + fr[1] * c.y) * k;
  var o: MO;
  o.pos = U.viewProjRel * vec4f(dir * 20000.0, 1.0);
  o.pos.z = 0.0;
  o.uv = c * MOON_PAD;
  return o;
}

/** A few soft maria, fixed on the face. */
fn maria(p: vec2f) -> f32 {
  var m = 0.0;
  m += 1.0 - smoothstep(0.12, 0.36, length(p - vec2f(-0.28, 0.3)));
  m += 1.0 - smoothstep(0.1, 0.3, length(p - vec2f(0.08, 0.42)));
  m += 1.0 - smoothstep(0.14, 0.4, length(p - vec2f(-0.05, -0.05)));
  m += 1.0 - smoothstep(0.08, 0.22, length(p - vec2f(0.38, -0.22)));
  m += 1.0 - smoothstep(0.06, 0.18, length(p - vec2f(0.15, -0.55)));
  return saturate(m);
}

@fragment fn fsMoon(o: MO) -> @location(0) vec4f {
  let r = length(o.uv);
  let disc = 1.0 - smoothstep(0.96, 1.02, r);
  // Faceted sphere: the face is cut into chunky flat cells, like the rest of the low-poly world.
  let cell = floor(o.uv * 5.0 + 0.5) / 5.0;
  let q = mix(o.uv, cell, 0.55);
  let z = sqrt(max(1.0 - dot(q, q), 0.0));
  let fr = moonFrame();
  let n = normalize(fr[0] * q.x + fr[1] * q.y - fr[2] * z);
  let lit = smoothstep(-0.12, 0.12, dot(n, U.moonSun.xyz));
  let albedo = mix(1.0, 0.68, maria(o.uv)) * (0.94 + 0.06 * z);
  let bright = vec3f(0.92, 0.95, 1.0) * U.moonSun.w * albedo;
  let c = mix(U.moonDark.rgb, bright, lit);
  let a = disc * U.p.w;
  return vec4f(c * a, a);
}
`

/** Uniform floats: mat4, 3 rotation columns, p, moon, moonSun, moonDark. */
const U_FLOATS = 16 + 12 + 4 * 4

export type StarInput = {
  /** Column-major celestial → world rotation (DayNight.stars). */
  rot: readonly number[]
  /** 0..1 star brightness (night, before the overcast). */
  stars: number
  /** Painted moon direction (DayNight.moonView) and the true sun direction. */
  moonView: readonly number[]
  sun: readonly number[]
  /** Moon brightness (HDR), visibility 0..1 (pale in daylight), and its dark limb colour. */
  moonBright: number
  moonAlpha: number
  moonDark: readonly number[]
  /** Vertical field of view (radians) and viewport height, for the glow blobs' angular size. */
  fov: number
  height: number
}

/** Star brightness scale, Milky Way glow, moon size. Live-tunable: `carrier.stars.look`. */
export const STARS_LOOK = { stars: 5, glow: 0.035, moonRadius: 2.1 }

export class Stars implements ScenePass {
  look = { ...STARS_LOOK }
  private device: GPUDevice
  private starPipe: GPURenderPipeline
  private moonPipe: GPURenderPipeline
  private buf: GPUBuffer
  private group: GPUBindGroup
  private data = new Float32Array(U_FLOATS)
  private drawStars = false
  private drawMoon = false

  constructor(r: Renderer) {
    const ctx = r.context
    const d = (this.device = ctx.device)
    const module = r.module(STARS_WGSL, "stars")
    const layout = d.createBindGroupLayout({
      label: "stars",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    })
    const pl = d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, layout] })
    const depthStencil: GPUDepthStencilState = { format: ctx.depth, depthWriteEnabled: false, depthCompare: "always" }
    const add: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one" }, alpha: { srcFactor: "zero", dstFactor: "one" } }
    const over: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "zero", dstFactor: "one" } }
    this.starPipe = d.createRenderPipeline({
      label: "stars",
      layout: pl,
      vertex: { module, entryPoint: "vsStar" },
      fragment: { module, entryPoint: "fsStar", targets: [{ format: ctx.color, blend: add }] },
      primitive: { topology: "triangle-list" },
      depthStencil,
      multisample: { count: ctx.samples },
    })
    this.moonPipe = d.createRenderPipeline({
      label: "moon",
      layout: pl,
      vertex: { module, entryPoint: "vsMoon" },
      fragment: { module, entryPoint: "fsMoon", targets: [{ format: ctx.color, blend: over }] },
      primitive: { topology: "triangle-list" },
      depthStencil,
      multisample: { count: ctx.samples },
    })
    this.buf = d.createBuffer({ label: "stars-u", size: U_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const field = starField(0x5ea57a75)
    const sbuf = d.createBuffer({ label: "stars", size: field.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(sbuf, 0, field)
    this.group = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.buf } }, { binding: 1, resource: { buffer: sbuf } }] })
  }

  update(view: RelView, s: StarInput): void {
    const u = this.data
    u.set(view.viewProjRel, 0)
    for (let c = 0; c < 3; c++) {
      u[16 + c * 4] = s.rot[c * 3]!
      u[17 + c * 4] = s.rot[c * 3 + 1]!
      u[18 + c * 4] = s.rot[c * 3 + 2]!
    }
    u[28] = s.stars * this.look.stars
    u[29] = s.stars * this.look.glow
    u[30] = s.height / (2 * Math.tan(s.fov / 2))
    u[31] = s.moonAlpha
    u[32] = s.moonView[0]!
    u[33] = s.moonView[1]!
    u[34] = s.moonView[2]!
    u[35] = (this.look.moonRadius * Math.PI) / 180
    u[36] = s.sun[0]!
    u[37] = s.sun[1]!
    u[38] = s.sun[2]!
    u[39] = s.moonBright
    u[40] = s.moonDark[0]!
    u[41] = s.moonDark[1]!
    u[42] = s.moonDark[2]!
    this.drawStars = s.stars > 0.002
    this.drawMoon = s.moonAlpha > 0.002 && s.moonView[1]! > -0.05
    this.device.queue.writeBuffer(this.buf, 0, u)
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.drawStars && !this.drawMoon) return
    pass.setBindGroup(1, this.group)
    if (this.drawStars) {
      pass.setPipeline(this.starPipe)
      pass.draw(6, COUNT)
    }
    if (this.drawMoon) {
      pass.setPipeline(this.moonPipe)
      pass.draw(6)
    }
  }
}

/**
 * The celestial sphere: STARS uniform stars (magnitude m in 0..1, most faint), BAND_STARS packed along a tilted great
 * circle (the Milky Way), and BLOBS soft glows along it (w = −angular radius). Deterministic.
 */
function starField(seed: number): Float32Array<ArrayBuffer> {
  let s = seed >>> 0
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd())
  const out = new Float32Array(COUNT * 4)
  const put = (i: number, x: number, y: number, z: number, w: number) => {
    const l = Math.hypot(x, y, z) || 1
    out.set([x / l, y / l, z / l, w], i * 4)
  }
  let i = 0
  for (; i < STARS; i++) {
    const z = rnd() * 2 - 1
    const a = rnd() * 2 * Math.PI
    const r = Math.sqrt(1 - z * z)
    put(i, r * Math.cos(a), r * Math.sin(a), z, rnd() ** 7)
  }
  // The band: a great circle with normal g, tilted across the arc.
  const g = [0.35, 0.55, 0.76]
  const gl = Math.hypot(g[0]!, g[1]!, g[2]!)
  const n = g.map((v) => v / gl) as [number, number, number]
  const e1 = [n[1], -n[0], 0]
  const e1l = Math.hypot(e1[0]!, e1[1]!)
  const a1 = [e1[0]! / e1l, e1[1]! / e1l, 0]
  const a2 = [n[1] * a1[2]! - n[2] * a1[1]!, n[2] * a1[0]! - n[0] * a1[2]!, n[0] * a1[1]! - n[1] * a1[0]!]
  const band = (spread: number) => {
    const t = rnd() * 2 * Math.PI
    const off = gauss() * spread
    return [0, 1, 2].map((k) => a1[k]! * Math.cos(t) + a2[k]! * Math.sin(t) + n[k]! * off) as [number, number, number]
  }
  for (; i < STARS + BAND_STARS; i++) {
    const [x, y, z] = band(0.08)
    put(i, x, y, z, rnd() ** 9 * 0.7)
  }
  for (; i < COUNT; i++) {
    const [x, y, z] = band(0.06)
    put(i, x, y, z, -(0.06 + rnd() * 0.09))
  }
  return out
}
