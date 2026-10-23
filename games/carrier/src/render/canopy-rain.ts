import type { LabControl } from "@arcade/kit/lab-panel"
import { mulberry32 } from "@arcade/kit/sim/rng"
import { FRAME_BINDING_WGSL } from "./frame"
import type { Renderer, ScenePass } from "./renderer"

export type CanopyRainSettings = {
  on: boolean
  /** Drops hitting the canopy per second at full rain, standing still and at 250 m/s. */
  rate: number
  rateFast: number
  /** Drop radius (fraction of the screen height). */
  size: number
  /** Airspeed (m/s) at which drops stop running down and start streaming back, and the streaming speed per m/s. */
  flowFrom: number
  flow: number
  /** Streak length per unit of on-screen speed (s). */
  streak: number
  opacity: number
  /** Drops on the chase camera's lens: how many at most, their opacity. */
  lens: number
  lensOpacity: number
  /** Preview without a jet (dev): 0 off, 1 the canopy, 2 the chase lens; and the airspeed it pretends (m/s). */
  preview: number
  previewSpeed: number
}

export const CANOPY_RAIN_DEFAULTS: Readonly<CanopyRainSettings> = {
  on: true,
  rate: 26,
  rateFast: 120,
  size: 0.015,
  flowFrom: 35,
  flow: 0.0065,
  streak: 0.1,
  opacity: 0.75,
  lens: 6,
  lensOpacity: 0.4,
  preview: 0,
  previewSpeed: 180,
}
export const CANOPY_RAIN: CanopyRainSettings = { ...CANOPY_RAIN_DEFAULTS }

const G = "Canopy rain"
export const CANOPY_RAIN_CONTROLS: LabControl[] = [
  { key: "on", label: "Rain on canopy and lens", group: G, type: "toggle" },
  { key: "rate", label: "Drops/s, slow", group: G, min: 0, max: 120, step: 1, unit: "/s" },
  { key: "rateFast", label: "Drops/s, 250 m/s", group: G, min: 0, max: 400, step: 5, unit: "/s" },
  { key: "size", label: "Drop size", group: G, min: 0.003, max: 0.03, step: 0.001 },
  { key: "flowFrom", label: "Streams back above", group: G, min: 0, max: 120, step: 1, unit: "m/s" },
  { key: "flow", label: "Stream speed per m/s", group: G, min: 0, max: 0.02, step: 0.0005 },
  { key: "streak", label: "Streak length", group: G, min: 0, max: 0.2, step: 0.005, unit: "s" },
  { key: "opacity", label: "Canopy drop opacity", group: G, min: 0, max: 1, step: 0.01 },
  { key: "lens", label: "Lens drops (chase)", group: G, min: 0, max: 20, step: 1 },
  { key: "lensOpacity", label: "Lens drop opacity", group: G, min: 0, max: 1, step: 0.01 },
  {
    key: "preview",
    label: "Preview without a jet",
    group: G,
    type: "select",
    options: [
      { value: 0, label: "Off" },
      { value: 1, label: "Canopy" },
      { value: 2, label: "Chase lens" },
    ],
  },
  { key: "previewSpeed", label: "Preview airspeed", group: G, min: 0, max: 400, step: 5, unit: "m/s" },
]

const MAX = 320
/** Floats per drop instance: centre (x, y screen units, y up, height 2), velocity (units/s), radius, alpha, seed. */
const INST = 8

const WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
struct CU { tint: vec4f, sky: vec4f, misc: vec4f } // misc: x = aspect, y = streak (s)
@group(1) @binding(0) var<uniform> U: CU;
struct VI { @location(0) a: vec4f, @location(1) b: vec4f }
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) len: f32, @location(2) alpha: f32, @location(3) seed: f32 }

@vertex fn vs(@builtin(vertex_index) vi: u32, d: VI) -> VO {
  var o: VO;
  let c = d.a.xy;
  let vel = d.a.zw;
  let r = d.b.x;
  let sp = length(vel);
  let dir = select(vec2f(0.0, -1.0), vel / sp, sp > 1e-4);
  let n = vec2f(-dir.y, dir.x);
  // A streak trails behind the head along its motion; a resting drop is a round bead.
  let len = sp * U.misc.y;
  let corner = vi % 6u;
  let u = select(-1.0, 1.0, corner == 1u || corner == 2u || corner == 4u);
  let v = select(-1.0, 1.0, corner == 2u || corner == 4u || corner == 5u);
  let along = select(-(len + r), r, v > 0.0);
  let p = c + n * u * r + dir * along;
  o.pos = vec4f(p.x / U.misc.x, p.y, 0.0, 1.0);
  o.uv = vec2f(u, along / r);
  o.len = len / r;
  o.alpha = d.b.y;
  o.seed = d.b.z;
  return o;
}

@fragment fn fs(o: VO) -> @location(0) vec4f {
  // Distance to the capsule from the head (0) back along the tail (len), in drop radii.
  let t = clamp(-o.uv.y, 0.0, o.len);
  let q = vec2f(o.uv.x, o.uv.y + t);
  // The tail thins toward its end.
  let w = mix(1.0, 0.35, select(0.0, t / max(o.len, 1e-3), o.len > 0.0));
  let d = length(q / vec2f(w, 1.0));
  if (d > 1.0) { discard; }
  let edge = smoothstep(1.0, 0.75, d);
  // A lens of water: a dark rim, a lighter body carrying the sky (refraction flips it), and a small bright highlight.
  // Refraction turns the world over inside a drop: the bright sky gathers at its bottom, the dark sea at its top.
  let rim = smoothstep(0.6, 0.95, d);
  let hl = smoothstep(0.3, 0.0, length(q - vec2f(-0.32, 0.38)));
  let flip = smoothstep(0.5, -0.7, q.y);
  let body = mix(U.tint.rgb * 0.45, U.sky.rgb * 1.5 + U.tint.rgb * 0.3, flip);
  let col = mix(body, U.tint.rgb * 0.12, rim) + U.tint.rgb * hl * 2.2;
  let a = o.alpha * edge * (0.7 + 0.3 * rim) * select(1.0, 0.8, t > 0.0);
  return vec4f(col * a, a);
}
`

type Drop = { x: number; y: number; vx: number; vy: number; r: number; a: number; age: number; life: number; lens: boolean; seed: number }

/**
 * Rain on the canopy (cockpit view) and a few drops on the chase camera's lens, drawn over the scene ("alpha" slot,
 * screen space, no depth). Drops land at a rate set by the rain and the airspeed; standing still they bead and run
 * down, flying they stream back and out across the canopy, faster and longer with speed. Lens drops are rare, still
 * beads that slowly slide. Presentation only; the amount comes from the weather's rain.
 */
export class CanopyRain implements ScenePass {
  private device: GPUDevice
  private pipe: GPURenderPipeline
  private inst: GPUBuffer
  private ubuf: GPUBuffer
  private group: GPUBindGroup
  private data = new Float32Array(MAX * INST)
  private u = new Float32Array(12)
  private drops: Drop[] = []
  private owed = 0
  private lensOwed = 0
  private n = 0
  private rnd = mulberry32(0xca70e)

  constructor(r: Renderer) {
    const ctx = r.context
    const d = (this.device = ctx.device)
    const module = r.module(WGSL, "canopy-rain")
    const layout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }] })
    const blend: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } }
    this.pipe = d.createRenderPipeline({
      label: "canopy-rain",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, layout] }),
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: INST * 4,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x4" },
              { shaderLocation: 1, offset: 16, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format: ctx.color, blend }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: false, depthCompare: "always" },
      multisample: { count: ctx.samples },
    })
    this.inst = d.createBuffer({ label: "canopy-rain-inst", size: this.data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.ubuf = d.createBuffer({ label: "canopy-rain-u", size: this.u.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.group = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.ubuf } }] })
  }

  /** Drops on screen now (scripts). */
  get count(): number {
    return this.drops.length
  }

  /**
   * Every frame. `rain` 0..1+ (weather rain × density), `cockpit` 0..1 (inside the canopy), `chase` true when the
   * camera rides behind a jet, `speed` the airspeed (m/s), `aspect` width / height, `frame` the packed Frame (for the
   * colours of the light around the drops).
   */
  update(dt: number, rain: number, cockpit: number, chase: boolean, speed: number, aspect: number, frame: Float32Array): void {
    const k = CANOPY_RAIN
    dt = Math.min(dt, 0.1)
    const wet = k.on ? Math.max(0, Math.min(2, rain)) : 0
    const inside = cockpit > 0.5
    // New drops.
    const fast = Math.min(1, speed / 250)
    if (inside && wet > 0) {
      this.owed += wet * (k.rate + (k.rateFast - k.rate) * fast) * dt
      while (this.owed >= 1 && this.drops.length < MAX) {
        this.owed--
        this.spawn(false, aspect)
      }
    } else this.owed = 0
    const lensCount = this.drops.reduce((n, d) => n + (d.lens ? 1 : 0), 0)
    if (!inside && chase && wet > 0 && lensCount < k.lens) {
      this.lensOwed += wet * 0.8 * dt
      if (this.lensOwed >= 1) {
        this.lensOwed = 0
        this.spawn(true, aspect)
      }
    }
    // Move: streaming back from the windscreen's middle at speed, running down when slow.
    const flow = Math.max(0, speed - k.flowFrom) * k.flow
    const out: Drop[] = []
    for (const d of this.drops) {
      d.age += dt
      const gone = d.lens ? !chase || inside : !inside
      if (d.age > d.life || (gone && d.age > 0.25)) continue
      if (gone) d.age = Math.max(d.age, d.life - 0.25)
      if (d.lens) {
        d.vx = 0
        d.vy = d.age > 0.8 ? -0.015 * d.r * 60 : 0
      } else if (flow > 0) {
        // Away from a point low in the middle of the windscreen, mostly upward (air runs back over the canopy).
        const dx = d.x
        const dy = d.y + 0.9
        const l = Math.hypot(dx, dy) + 1e-3
        const wob = Math.sin(d.age * 9 + d.seed * 40) * 0.15
        const s = flow * (0.7 + 0.6 * d.seed)
        d.vx = (dx / l + wob) * s
        d.vy = (dy / l) * s
      } else {
        // Beads sit, then the bigger ones run down in little jerks.
        const run = d.r > k.size * 1.1 && d.age > 0.6
        d.vx = Math.sin(d.age * 3 + d.seed * 20) * 0.01
        d.vy = run ? -0.12 * (0.6 + 0.8 * Math.max(0, Math.sin(d.age * 5 + d.seed * 9))) : 0
      }
      d.x += d.vx * dt
      d.y += d.vy * dt
      if (Math.abs(d.x) > aspect + 0.1 || Math.abs(d.y) > 1.1) continue
      out.push(d)
    }
    this.drops = out
    this.n = 0
    const data = this.data
    for (const d of out) {
      const fadeIn = Math.min(1, d.age / 0.05)
      const fadeOut = Math.min(1, (d.life - d.age) / 0.25)
      const o = this.n * INST
      data[o] = d.x
      data[o + 1] = d.y
      data[o + 2] = d.vx
      data[o + 3] = d.vy
      data[o + 4] = d.r
      data[o + 5] = d.a * fadeIn * fadeOut * (d.lens ? k.lensOpacity : k.opacity)
      data[o + 6] = d.seed
      this.n++
    }
    if (!this.n) return
    this.device.queue.writeBuffer(this.inst, 0, data, 0, this.n * INST)
    const u = this.u
    // Drops catch the light around them: the haze colour plus a little sun; their bodies carry the sky above.
    const sun = frame[23]! * 0.05
    u[0] = frame[32]! + frame[24]! * sun
    u[1] = frame[33]! + frame[25]! * sun
    u[2] = frame[34]! + frame[26]! * sun
    u[4] = frame[28]! * 0.6 + frame[32]! * 0.4
    u[5] = frame[29]! * 0.6 + frame[33]! * 0.4
    u[6] = frame[30]! * 0.6 + frame[34]! * 0.4
    u[8] = aspect
    u[9] = k.streak
    this.device.queue.writeBuffer(this.ubuf, 0, u)
  }

  private spawn(lens: boolean, aspect: number): void {
    const r = this.rnd
    const k = CANOPY_RAIN
    const big = r()
    this.drops.push({
      x: (r() * 2 - 1) * aspect,
      y: r() * 2 - 1,
      vx: 0,
      vy: 0,
      r: k.size * (lens ? 1.6 + big * 1.2 : 0.45 + big * big * 1.3),
      a: lens ? 1 : 0.6 + 0.4 * r(),
      age: 0,
      life: lens ? 4 + r() * 4 : 1.2 + r() * 2.5,
      lens,
      seed: r(),
    })
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.n) return
    pass.setPipeline(this.pipe)
    pass.setBindGroup(1, this.group)
    pass.setVertexBuffer(0, this.inst)
    pass.draw(6, this.n)
  }
}
