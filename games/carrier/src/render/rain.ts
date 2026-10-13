import { packSea, SEA_UNIFORM_FLOATS, snapSeaOrigin, type Sea } from "../../shared/sea"
import { SEA_WGSL } from "../../shared/sea.wgsl"
import { windMs, type Weather } from "../../shared/weather"
import { FOV } from "./camera"
import { FRAME_BINDING_WGSL } from "./frame"
import { HASH_WGSL } from "./ocean-hash"
import type { RelView } from "./ocean-view"
import type { Renderer, ScenePass } from "./renderer"

/** Drops in the near box at full rain and density 1, and its size (m); the near layer gives the big, crisp streaks. */
const NEAR_N = 14000
const NEAR_BOX = 28
/** The mid layer: fainter, thinner streaks that fill the volume out to ~50 m. */
const FAR_N = 16000
const FAR_BOX = 100
/** Splash slots at full rain; splashes live in a 64 m square around the camera (64 divides the 1024 m sea grid). */
const SPLASH_N = 2600
const SPLASH_BOX = 64
const SPLASH_PERIOD = 0.45
/** Terminal speed of a big raindrop (m/s), and how much of the wind the drops carry. */
const FALL = 8.5
const DRIFT = 0.55
/** Draw buffers hold this much of the slider range (density up to 3x). */
const MAX_SCALE = 2

export const RAIN_FLOATS = 52

/** Live tuning (`carrier.rain.look`). */
export type RainLook = {
  /** Streak opacity, near and mid layers. */
  alpha: number
  farAlpha: number
  /** Streak width (m) and minimum on-screen width (px). */
  width: number
  minPx: number
  /** Motion-blur exposure (s): streak length = relative speed x exposure x weather.streak. */
  exposure: number
  /** Brightness of the drops against the haze colour. */
  bright: number
  splashAlpha: number
  splashSize: number
}

export const RAIN_LOOK_DEFAULT: RainLook = { alpha: 0.45, farAlpha: 0.22, width: 0.012, minPx: 1.2, exposure: 0.06, bright: 1.6, splashAlpha: 0.3, splashSize: 0.8 }

export const RAIN_WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
${HASH_WGSL}
${SEA_WGSL}

struct Rain {
  viewProjRel: mat4x4f,
  offNear: vec4f,   // drift - eye, wrapped to the near box (xyz); w = near box size
  offFar: vec4f,    // same for the far box; w = far box size
  vRel: vec4f,      // drop velocity relative to the camera (m/s); w = exposure (s)
  color: vec4f,     // drop colour; w = near alpha
  counts: vec4f,    // near slots, far slots, near amount (fractional count), far amount
  splash: vec4f,    // eye minus sea origin x, eye height, z; splash amount (fractional count)
  misc: vec4f,      // time (wrapped), flash, far alpha, focal length (px)
  splashColor: vec4f, // rgb; w = alpha
  shape: vec4f,     // streak width (m), min width (px), splash size, unused
}
@group(1) @binding(0) var<uniform> R: Rain;
@group(1) @binding(1) var<uniform> sea: SeaUniform;

struct SO {
  @builtin(position) pos: vec4f,
  @location(0) side: f32,
  @location(1) along: f32,
  @location(2) alpha: f32,
}

fn wrapBox(p: vec3f, box: f32) -> vec3f { return p - box * floor(p / box) - 0.5 * box; }

@vertex fn streakVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SO {
  var o: SO;
  o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
  o.side = 0.0;
  o.along = 0.0;
  o.alpha = 0.0;
  let nearN = u32(R.counts.x);
  let far = ii >= nearN;
  let local = select(ii, ii - nearN, far);
  let amount = select(R.counts.z, R.counts.w, far);
  let fade = saturate(amount - f32(local));
  if (fade <= 0.0) { return o; }
  let box = select(R.offNear.w, R.offFar.w, far);
  let off = select(R.offNear.xyz, R.offFar.xyz, far);
  let h = rand3(vec3u(local, select(11u, 23u, far), 0x5eedu));
  let rel = wrapBox(h * box + off, box);
  // Fade at the walls so the wrap never shows, and right in front of the lens.
  let edge = abs(rel) / (0.5 * box);
  var a = fade * (1.0 - smoothstep(0.7, 1.0, max(edge.x, max(edge.y, edge.z))));
  let dist = length(rel);
  a *= smoothstep(0.25, 1.2, dist);
  // Every drop is a bit different: size and speed.
  let size = 0.6 + 0.8 * h.x * h.y;
  let v = R.vRel.xyz * (0.85 + 0.3 * fract(h.z * 7.13));
  let head = rel;
  let tail = rel - v * R.vRel.w;
  let ch = R.viewProjRel * vec4f(head, 1.0);
  var ct = R.viewProjRel * vec4f(tail, 1.0);
  if (ch.w < 0.2 || ct.w < 0.2) { return o; }
  let vp = F.viewport.xy;
  let sh = ch.xy / ch.w * vp * 0.5;
  var st = ct.xy / ct.w * vp * 0.5;
  // Drops brushing the lens would smear across the screen: cap the on-screen length.
  let maxLen = vp.y * 0.12;
  let raw = length(sh - st);
  if (raw > maxLen) {
    ct = mix(ch, ct, maxLen / raw);
    st = ct.xy / ct.w * vp * 0.5;
    a *= maxLen / raw * 0.5 + 0.5;
  }
  var d = sh - st;
  let len = length(d);
  d = select(vec2f(0.0, 1.0), d / len, len > 1e-3);
  let n = vec2f(-d.y, d.x);
  // Real width in pixels, clamped to the minimum; thinner-than-a-pixel drops lose opacity instead.
  let wTrue = R.shape.x * size * R.misc.w / ch.w;
  let wPx = max(wTrue, R.shape.y * select(1.0, 0.8, far));
  a *= min(1.0, wTrue / wPx) * 0.6 + 0.4;
  a *= select(R.color.w, R.misc.z, far);
  let corner = vi % 6u;
  let end = select(0.0, 1.0, corner == 1u || corner == 2u || corner == 4u);
  let s = select(-1.0, 1.0, corner == 2u || corner == 4u || corner == 5u);
  var c = select(ct, ch, end > 0.5);
  // Half a pixel past each end so short streaks are still dots.
  let px = n * s * wPx * 0.5 + d * (end - 0.5) * wPx;
  c = vec4f(c.xy + px * 2.0 / vp * c.w, c.z, c.w);
  o.pos = c;
  o.side = s;
  o.along = end;
  o.alpha = a;
  return o;
}

@fragment fn streakFs(o: SO) -> @location(0) vec4f {
  let edge = 1.0 - o.side * o.side;
  let a = o.alpha * edge * (0.25 + 0.75 * o.along);
  let c = R.color.rgb * (1.0 + 3.0 * R.misc.y);
  return vec4f(c * a, a);
}

struct PO {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) alpha: f32,
  @location(2) @interpolate(flat) kind: u32,
}

@vertex fn splashVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> PO {
  var o: PO;
  o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
  o.uv = vec2f(0.0);
  o.alpha = 0.0;
  o.kind = 0u;
  let fade = saturate(R.splash.w - f32(ii));
  if (fade <= 0.0) { return o; }
  let h0 = rand3(vec3u(ii, 37u, 0x5eedu));
  let phase = R.misc.x / ${SPLASH_PERIOD} + h0.x;
  let cycle = u32(floor(phase));
  let age = fract(phase);
  let h = rand3(vec3u(ii, cycle, 0x5b1a5u));
  // Rest position relative to the sea origin, world-anchored for the whole cycle.
  let cam = vec2f(R.splash.x, R.splash.z);
  let rel = h.xy * ${SPLASH_BOX}.0 - cam;
  let q = rel - ${SPLASH_BOX}.0 * floor(rel / ${SPLASH_BOX}.0) - ${SPLASH_BOX / 2}.0;
  let p = cam + q;
  let dsp = seaDisplace(p);
  // Eye-relative surface point (the eye sits at cam, height R.splash.y above the sea's rest level).
  let base = vec3f(q.x + dsp.x, dsp.y - R.splash.y, q.y + dsp.z);
  let dist = length(base);
  var a = fade * (1.0 - smoothstep(${SPLASH_BOX * 0.3}, ${SPLASH_BOX * 0.5}.0, length(q))) * smoothstep(0.5, 2.5, dist);
  let size = R.shape.z * (0.6 + 0.8 * h.z);
  let corner = vi % 6u;
  let uv = vec2f(select(-1.0, 1.0, corner == 1u || corner == 2u || corner == 4u), select(-1.0, 1.0, corner == 2u || corner == 4u || corner == 5u));
  var world: vec3f;
  if (vi < 6u) {
    // Ring on the surface, spreading out.
    let r = size * (0.12 + 0.45 * age);
    world = base + vec3f(uv.x * r, 0.06, uv.y * r);
    a *= (1.0 - age) * (1.0 - age);
    o.kind = 0u;
  } else {
    // Crown: a little upward fleck, rising and falling, facing the camera.
    let right = normalize(vec3f(-base.z, 0.0, base.x) + vec3f(1e-4, 0.0, 0.0));
    let up = 4.0 * age * (1.0 - age);
    let hgt = size * 0.24 * up;
    world = base + right * uv.x * size * 0.035 * (0.5 + age) + vec3f(0.0, (uv.y * 0.5 + 0.5) * hgt + 0.02, 0.0);
    a *= smoothstep(0.0, 0.06, age) * (1.0 - smoothstep(0.3, 0.7, age)) * 0.4;
    o.kind = 1u;
  }
  o.pos = R.viewProjRel * vec4f(world, 1.0);
  o.uv = uv;
  o.alpha = a * R.splashColor.w;
  return o;
}

@fragment fn splashFs(o: PO) -> @location(0) vec4f {
  var a: f32;
  if (o.kind == 0u) {
    let r = length(o.uv);
    a = smoothstep(0.45, 0.85, r) * (1.0 - smoothstep(0.85, 1.0, r)) * 0.3;
  } else {
    a = (1.0 - o.uv.x * o.uv.x) * (0.4 + 0.6 * (o.uv.y * 0.5 + 0.5));
  }
  a *= o.alpha;
  let c = R.splashColor.rgb * (1.0 + 3.0 * R.misc.y);
  return vec4f(c * a, a);
}
`

/**
 * GPU rain ("alpha" slot): a camera-centred, wrapped volume of instanced streaks in two layers, each stretched along
 * the drop's velocity relative to the camera (fall plus wind minus camera motion), depth-tested against the scene, plus
 * splash rings and crowns sitting on the displaced sea near the camera. Everything is procedural: no per-drop state,
 * one small uniform per frame. Drops are presentation only (not synced); the rain amount comes from the weather.
 */
export class Rain implements ScenePass {
  readonly look: RainLook = { ...RAIN_LOOK_DEFAULT }
  private device: GPUDevice
  private streaks: GPURenderPipeline
  private splashes: GPURenderPipeline
  private ubuf: GPUBuffer
  private sbuf: GPUBuffer
  private group: GPUBindGroup
  private u = new Float32Array(RAIN_FLOATS)
  private seaU = new Float32Array(SEA_UNIFORM_FLOATS)
  /** World-frame drift of the drops (m), integrated so wind changes never jump. */
  private drift = new Float64Array(3)
  private lastEye = new Float64Array(3)
  private camVel = new Float64Array(3)
  private have = false
  private nNear = 0
  private nFar = 0
  private nSplashes = 0

  constructor(r: Renderer) {
    const ctx = r.context
    const d = (this.device = ctx.device)
    const module = r.module(RAIN_WGSL, "rain")
    const layout = d.createBindGroupLayout({
      label: "rain",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      ],
    })
    const blend: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } }
    const pipe = (vs: string, fs: string) =>
      d.createRenderPipeline({
        label: `rain-${vs}`,
        layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, layout] }),
        vertex: { module, entryPoint: vs },
        fragment: { module, entryPoint: fs, targets: [{ format: ctx.color, blend }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: ctx.depth, depthWriteEnabled: false, depthCompare: "greater-equal" },
        multisample: { count: ctx.samples },
      })
    this.streaks = pipe("streakVs", "streakFs")
    this.splashes = pipe("splashVs", "splashFs")
    this.ubuf = d.createBuffer({ label: "rain-u", size: RAIN_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.sbuf = d.createBuffer({ label: "rain-sea", size: SEA_UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.group = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.ubuf } }, { binding: 1, resource: { buffer: this.sbuf } }] })
  }

  /**
   * Call every frame. `dt` is the frame time (s), `t` sea time, `wind` the sea's unit wind direction (the weather's
   * windDir turns it), `sea` the (weather-scaled) sea the splashes sit on, `frame` the packed Frame (for the haze and
   * sun colours), `flash` the lightning flash 0..1, `fov` the camera's vertical field of view.
   */
  update(dt: number, t: number, view: RelView, w: Weather, wind: readonly [number, number], sea: Sea | null, frame: Float32Array, flash = 0, fov = FOV): void {
    const u = this.u
    const k = this.look
    const e = view.eye
    // Camera velocity (smoothed), for streak direction relative to the lens; teleports reset it.
    if (this.have && dt > 0) {
      const a = 1 - Math.exp(-dt / 0.12)
      for (let i = 0; i < 3; i++) {
        const v = (e[i]! - this.lastEye[i]!) / dt
        this.camVel[i] = Math.abs(v) > 400 ? 0 : this.camVel[i]! + (v - this.camVel[i]!) * a
      }
    }
    this.have = true
    this.lastEye.set(e)
    const turn = (w.windDir * Math.PI) / 180
    const wx = wind[0] * Math.cos(turn) - wind[1] * Math.sin(turn)
    const wz = wind[0] * Math.sin(turn) + wind[1] * Math.cos(turn)
    const ws = windMs(w) * DRIFT
    const vx = wx * ws
    const vz = wz * ws
    const step = Math.min(dt, 0.1)
    this.drift[0] = (this.drift[0]! + vx * step) % 1e6
    this.drift[1] = (this.drift[1]! - FALL * step) % 1e6
    this.drift[2] = (this.drift[2]! + vz * step) % 1e6

    u.set(view.viewProjRel, 0)
    const wrap = (v: number, box: number) => v - box * Math.floor(v / box)
    for (let i = 0; i < 3; i++) {
      u[16 + i] = wrap(this.drift[i]! - e[i]!, NEAR_BOX)
      u[20 + i] = wrap(this.drift[i]! - e[i]!, FAR_BOX)
    }
    u[19] = NEAR_BOX
    u[23] = FAR_BOX
    u[24] = vx - this.camVel[0]!
    u[25] = -FALL - this.camVel[1]!
    u[26] = vz - this.camVel[2]!
    u[27] = k.exposure * w.streak

    // Drops pick up the haze colour (the light around them) and a little sun.
    const sunI = frame[23]! * 0.04
    const bright = k.bright
    u[28] = frame[32]! * bright + frame[24]! * sunI
    u[29] = frame[33]! * bright + frame[25]! * sunI
    u[30] = frame[34]! * bright + frame[26]! * sunI
    u[31] = k.alpha
    // Rain thins out above the cloud base and when the camera is very high.
    const high = 1 - Math.min(1, Math.max(0, (e[1]! - 600) / 1400))
    const amount = Math.min(MAX_SCALE, Math.max(0, w.rain * w.density)) * high
    const nearN = NEAR_N * MAX_SCALE
    const farN = FAR_N * MAX_SCALE
    u[32] = nearN
    u[33] = farN
    u[34] = NEAR_N * amount
    u[35] = FAR_N * amount
    this.nNear = Math.ceil(NEAR_N * amount)
    this.nFar = Math.ceil(FAR_N * amount)

    const ox = snapSeaOrigin(e[0]!)
    const oz = snapSeaOrigin(e[2]!)
    u[36] = e[0]! - ox
    u[37] = e[1]!
    u[38] = e[2]! - oz
    const low = 1 - Math.min(1, Math.max(0, (e[1]! - 40) / 80))
    const splashes = sea ? SPLASH_N * Math.min(MAX_SCALE, Math.max(0, w.rain * w.splash)) * low : 0
    u[39] = splashes
    this.nSplashes = Math.ceil(splashes)
    u[40] = ((t % 3600) + 3600) % 3600
    u[41] = flash
    u[42] = k.farAlpha
    u[43] = frame[37]! / (2 * Math.tan(fov / 2))
    u[44] = frame[32]! * 1.5 + frame[24]! * sunI * 2
    u[45] = frame[33]! * 1.5 + frame[25]! * sunI * 2
    u[46] = frame[34]! * 1.5 + frame[26]! * sunI * 2
    u[47] = k.splashAlpha
    u[48] = k.width
    u[49] = k.minPx
    u[50] = k.splashSize
    this.device.queue.writeBuffer(this.ubuf, 0, u)
    if (sea && this.nSplashes) {
      packSea(sea, t, this.seaU, ox, oz)
      this.device.queue.writeBuffer(this.sbuf, 0, this.seaU)
    }
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.nNear && !this.nFar && !this.nSplashes) return
    pass.setBindGroup(1, this.group)
    if (this.nSplashes) {
      pass.setPipeline(this.splashes)
      pass.draw(12, this.nSplashes)
    }
    if (this.nNear || this.nFar) {
      pass.setPipeline(this.streaks)
      // instance_index includes firstInstance: the far layer starts after every near slot.
      if (this.nNear) pass.draw(6, this.nNear)
      if (this.nFar) pass.draw(6, this.nFar, 0, NEAR_N * MAX_SCALE)
    }
  }
}
