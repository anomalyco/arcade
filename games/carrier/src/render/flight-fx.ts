import type { LabControl } from "@arcade/kit/lab-panel"
import type { VehicleKind } from "../../shared/vehicles"
import { ATMOSPHERE_WGSL } from "./atmosphere"
import { FRAME_BINDING_WGSL } from "./frame"
import type { Renderer, ScenePass } from "./renderer"

/**
 * Flight juice: typed settings on the dev panel's Flight tab (src/dev/juice-lab.ts), read live each frame. Speeds in
 * m/s, angles in degrees, times in seconds.
 */
export type FlightFxSettings = {
  /** The FOV kick on afterburner light-up and on the vapour cone (degrees, on top of the camera's own boost FOV). */
  fovKick: number
  /** Wingtip trails and over-wing condensation: the load factor and angle of attack where they start and peak. */
  vapourG: number
  vapourFullG: number
  vapourAoa: number
  vapourFullAoa: number
  wingAlpha: number
  /** The vapour cone: a share of the type's afterburner top speed (jets never reach Mach 1 here). */
  coneSpeed: number
  coneAlpha: number
  coneTime: number
  /** Heat shimmer behind the nozzles (pixels of displacement close up). */
  shimmer: boolean
  shimmerPx: number
  /** Afterburner light-up: extra flame brightness and length, decaying over `burnerPulseTime`. */
  burnerPulse: number
  burnerPulseTime: number
  burnerFlicker: number
  /** Low over the sea: spray and a short wake under the jet from this height (m above the waves). */
  sprayHeight: number
  sprayRate: number
  wake: boolean
}

export const FLIGHT_FX_DEFAULTS: Readonly<FlightFxSettings> = {
  fovKick: 2.5,
  vapourG: 7,
  vapourFullG: 13,
  vapourAoa: 5,
  vapourFullAoa: 10,
  wingAlpha: 0.5,
  coneSpeed: 0.9,
  coneAlpha: 0.75,
  coneTime: 0.85,
  shimmer: true,
  shimmerPx: 1.6,
  burnerPulse: 0.9,
  burnerPulseTime: 0.45,
  burnerFlicker: 0.08,
  sprayHeight: 30,
  sprayRate: 400,
  wake: true,
}
export const FLIGHT_FX: FlightFxSettings = { ...FLIGHT_FX_DEFAULTS }
export const FLIGHT_FX_CONTROLS: LabControl[] = [
  { key: "fovKick", label: "FOV kick on light-up", group: "Speed", min: 0, max: 8, step: 0.1, unit: "°" },
  { key: "vapourG", label: "Vapour from", group: "Vapour", min: 1, max: 12, step: 0.1, unit: "g" },
  { key: "vapourFullG", label: "Vapour full at", group: "Vapour", min: 2, max: 16, step: 0.1, unit: "g" },
  { key: "vapourAoa", label: "Vapour from AoA", group: "Vapour", min: 0, max: 30, step: 0.5, unit: "°" },
  { key: "vapourFullAoa", label: "Vapour full at AoA", group: "Vapour", min: 1, max: 40, step: 0.5, unit: "°" },
  { key: "wingAlpha", label: "Over-wing opacity", group: "Vapour", min: 0, max: 1, step: 0.01 },
  { key: "coneSpeed", label: "Vapour cone at (of burner top speed)", group: "Vapour cone", min: 0.6, max: 1, step: 0.01 },
  { key: "coneAlpha", label: "Cone opacity", group: "Vapour cone", min: 0, max: 1, step: 0.01 },
  { key: "coneTime", label: "Cone time", group: "Vapour cone", min: 0.2, max: 2, step: 0.05, unit: "s" },
  { key: "shimmer", label: "Heat shimmer", group: "Engine", type: "toggle" },
  { key: "shimmerPx", label: "Shimmer strength", group: "Engine", min: 0, max: 10, step: 0.1, unit: "px" },
  { key: "burnerPulse", label: "Light-up pulse", group: "Engine", min: 0, max: 4, step: 0.05, unit: "×" },
  { key: "burnerPulseTime", label: "Light-up pulse time", group: "Engine", min: 0.05, max: 1.5, step: 0.05, unit: "s" },
  { key: "burnerFlicker", label: "Flame flicker", group: "Engine", min: 0, max: 0.4, step: 0.01 },
  { key: "sprayHeight", label: "Sea spray below", group: "Low over the sea", min: 0, max: 60, step: 1, unit: "m" },
  { key: "sprayRate", label: "Spray rate (High)", group: "Low over the sea", min: 0, max: 600, step: 10, unit: "/s" },
  { key: "wake", label: "Wake on the water", group: "Low over the sea", type: "toggle" },
]

/** The quality tier's share of the flight juice (src/quality.ts `flightFx`: High 1, Balanced 0.65, Low 0.3). */
let qualityScale = 1
export const setFlightFxQuality = (scale: number): void => {
  qualityScale = Math.max(0, Math.min(1, scale))
}
export const flightFxQuality = (): number => qualityScale

/** Wingtip trails and over-wing condensation (0..1) from the load factor and the angle of attack (degrees). */
export function vapourAmount(g: number, aoaDeg: number): number {
  const s = FLIGHT_FX
  const fromG = (g - s.vapourG) / Math.max(0.1, s.vapourFullG - s.vapourG)
  const fromAoa = (aoaDeg - s.vapourAoa) / Math.max(0.1, s.vapourFullAoa - s.vapourAoa)
  return Math.max(0, Math.min(1, Math.max(fromG, fromAoa * 0.85)))
}

/** Upper wing surface, model space (x left, y up, z nose): root and tip leading and trailing edges, per side +X. */
type Wing = { root: [x: number, y: number, le: number, te: number]; tip: [x: number, y: number, le: number, te: number] }
const WINGS: Record<VehicleKind, Wing> = {
  hornet: { root: [1.5, 1.32, 0.7, -3.9], tip: [6.6, 1.0, -2.15, -3.6] },
  f35: { root: [1.6, 1.5, 0.6, -4.3], tip: [6.2, 1.55, -2.3, -3.7] },
}

const FLOATS = 7
const MAX_VERTS = 24_000
const CONE_SEGS = 28
const CONE_RINGS = 6
const RING_SEGS = 40
const KIND = { wing: 1, cone: 2, ring: 3 } as const

const WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
${ATMOSPHERE_WGSL}
struct VIn { @location(0) pos: vec3f, @location(1) uv: vec2f, @location(2) ak: vec2f }
struct VOut { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) uv: vec2f, @location(2) @interpolate(flat) kind: f32, @location(3) a: f32 }

@vertex fn vs(v: VIn) -> VOut {
  var o: VOut;
  o.pos = F.viewProj * vec4f(v.pos, 1.0);
  o.world = v.pos;
  o.uv = v.uv;
  o.a = v.ak.x;
  o.kind = v.ak.y;
  return o;
}

fn hash2(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
}

@fragment fn fs(o: VOut) -> @location(0) vec4f {
  let t = F.eye.w;
  // Condensation is sunlit cloud: the sun's colour plus the sky's ambient, fogged with distance.
  let lit = F.sunColor.rgb * (F.sunDir.w * 0.55 + F.sunColor.w * 1.1);
  var a = 0.0;
  var c = lit;
  if (o.kind < 1.5) {
    // Over-wing condensation: x spanwise, y chordwise (0 leading edge); tufts streaming aft, soft at every edge.
    let n = vnoise(vec2f(o.uv.x * 7.0, o.uv.y * 3.0 - t * 9.0)) * 0.6 + vnoise(vec2f(o.uv.x * 19.0, o.uv.y * 7.0 - t * 17.0)) * 0.4;
    let edge = smoothstep(0.0, 0.25, o.uv.y) * (1.0 - smoothstep(0.55, 1.0, o.uv.y)) * smoothstep(0.0, 0.12, o.uv.x) * (1.0 - smoothstep(0.75, 1.0, o.uv.x));
    a = o.a * edge * smoothstep(0.25, 0.75, n);
  } else if (o.kind < 2.5) {
    // Vapour cone: x around, y front (0) to rear (1); striated condensation, densest at the shock (rear) edge.
    let n = vnoise(vec2f(o.uv.x * 46.0, o.uv.y * 2.5 + t * 3.0)) * 0.55 + vnoise(vec2f(o.uv.x * 13.0, o.uv.y * 6.0)) * 0.45;
    let shape = pow(o.uv.y, 1.4) * (1.0 - smoothstep(0.88, 1.0, o.uv.y));
    a = o.a * shape * smoothstep(0.2, 0.7, n);
    c = lit * 1.1;
  } else {
    // Shock ring: x around, y across (-1..1).
    let n = vnoise(vec2f(o.uv.x * 30.0, o.uv.y * 2.0));
    a = o.a * (1.0 - o.uv.y * o.uv.y) * (0.5 + 0.5 * n);
  }
  c = applyFog(c, o.world);
  return vec4f(c * a, a);
}
`

type Cone = { age: number; strength: number }
type Ring = { x: number; y: number; z: number; dx: number; dy: number; dz: number; age: number; strength: number }

/**
 * Flight juice on the GPU ("alpha" slot): over-wing condensation in hard pulls, the vapour
 * cone when a jet passes its cone speed and the shock ring it leaves. One premultiplied pipeline, geometry built on the
 * CPU each frame (a few thousand vertices). Per frame: `begin(eye, dt)`, `wing(...)` / `cone(...)`
 * per jet, then `upload()`.
 */
export class FlightFx implements ScenePass {
  private pipe: GPURenderPipeline
  private buf: GPUBuffer
  private data = new Float32Array(MAX_VERTS * FLOATS)
  private n = 0
  private drawn = 0
  private eye = [0, 0, 0]
  private dt = 0
  private cones = new Map<number, Cone>()
  private rings: Ring[] = []

  constructor(private renderer: Renderer) {
    const ctx = renderer.context
    const d = ctx.device
    this.buf = d.createBuffer({ label: "flight-fx", size: this.data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    const m = renderer.module(WGSL, "flight-fx")
    const premul: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" } }
    this.pipe = d.createRenderPipeline({
      label: "flight-fx",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout] }),
      vertex: {
        module: m,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: FLOATS * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x2" },
              { shaderLocation: 2, offset: 20, format: "float32x2" },
            ],
          },
        ],
      },
      fragment: { module: m, entryPoint: "fs", targets: [{ format: ctx.color, blend: premul }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: false, depthCompare: "greater-equal" },
      multisample: { count: ctx.samples },
    })
  }

  begin(eye: ArrayLike<number>, dt: number): void {
    this.eye[0] = eye[0]!
    this.eye[1] = eye[1]!
    this.eye[2] = eye[2]!
    this.dt = dt
    this.n = 0
  }

  private vert(x: number, y: number, z: number, u: number, v: number, a: number, kind: number): void {
    const o = this.n * FLOATS
    const d = this.data
    d[o] = x
    d[o + 1] = y
    d[o + 2] = z
    d[o + 3] = u
    d[o + 4] = v
    d[o + 5] = a
    d[o + 6] = kind
    this.n++
  }

  /** A quad a-b-c-d (a, b along one edge) with per-corner uv and alpha. */
  private quad(p: ArrayLike<number>, uv: ArrayLike<number>, al: ArrayLike<number>, kind: number): void {
    if (this.n + 6 > MAX_VERTS) return
    for (const i of [0, 1, 2, 0, 2, 3]) this.vert(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!, uv[i * 2]!, uv[i * 2 + 1]!, al[i]!, kind)
  }

  /** Over-wing condensation on a jet (model matrix `m`), `amount` 0..1. */
  wing(m: Float32Array, kind: VehicleKind, amount: number): void {
    const a = amount * FLIGHT_FX.wingAlpha
    if (a < 0.01) return
    const w = WINGS[kind]
    const pt = (x: number, y: number, z: number, out: number[], o: number) => {
      out[o] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
      out[o + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
      out[o + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
    }
    const q: number[] = Array(12).fill(0)
    // Two layers hugging the upper surface, the higher one thinner, on both wings.
    for (const [lift, k] of [
      [0.12, 1],
      [0.42, 0.55],
    ] as const) {
      for (const side of [1, -1]) {
        const [rx, ry, rle, rte] = w.root
        const [tx, ty, tle, tte] = w.tip
        pt(side * rx, ry + lift, rle, q, 0)
        pt(side * tx, ty + lift, tle, q, 3)
        pt(side * tx, ty + lift * 0.7, tte - 0.6, q, 6)
        pt(side * rx, ry + lift, rte - 1.2, q, 9)
        this.quad(q, [0, 0, 1, 0, 1, 1, 0, 1], [a * k, a * k, a * k, a * k], KIND.wing)
      }
    }
  }

  /** The vapour cone on jet `id` (model matrix `m`, its centre height `centre`), started by `boom`. */
  cone(id: number, m: Float32Array, centre: number): void {
    const c = this.cones.get(id)
    if (!c) return
    c.age += this.dt
    const T = FLIGHT_FX.coneTime
    if (c.age > T) {
      this.cones.delete(id)
      return
    }
    const k = c.age / T
    const env = smooth(c.age / 0.06) * (1 - smooth((k - 0.25) / 0.75))
    const alpha = env * c.strength * FLIGHT_FX.coneAlpha
    if (alpha < 0.01) return
    // Bell from just behind the canopy, flaring out past the wingtips, sliding back a little as it fades.
    const slide = -2.5 * k
    const z0 = 2.6 + slide
    const z1 = -4.6 + slide
    const r0 = 1.2
    const r1 = 7.4 + 1.2 * k
    const cy = centre + 0.4
    const [ex, ey, ez] = this.eye as [number, number, number]
    const ring = (u: number, out: number[]) => {
      const z = z0 + (z1 - z0) * u
      const r = r0 + (r1 - r0) * Math.pow(u, 0.55)
      for (let s = 0; s <= CONE_SEGS; s++) {
        const a = (s / CONE_SEGS) * Math.PI * 2
        const lx = Math.cos(a) * r
        const ly = cy + Math.sin(a) * r
        const o = s * 4
        const wx = m[0]! * lx + m[4]! * ly + m[8]! * z + m[12]!
        const wy = m[1]! * lx + m[5]! * ly + m[9]! * z + m[13]!
        const wz = m[2]! * lx + m[6]! * ly + m[10]! * z + m[14]!
        // Rim: the shell reads where it is seen edge on (the normal is mostly radial).
        const nx = m[0]! * Math.cos(a) + m[4]! * Math.sin(a)
        const ny = m[1]! * Math.cos(a) + m[5]! * Math.sin(a)
        const nz = m[2]! * Math.cos(a) + m[6]! * Math.sin(a)
        const vx = ex - wx
        const vy = ey - wy
        const vz = ez - wz
        const vl = Math.hypot(vx, vy, vz) || 1
        const rim = 1 - Math.abs((nx * vx + ny * vy + nz * vz) / vl)
        out[o] = wx
        out[o + 1] = wy
        out[o + 2] = wz
        out[o + 3] = 0.35 + 0.65 * rim * rim
      }
    }
    let prev: number[] = Array((CONE_SEGS + 1) * 4).fill(0)
    let next: number[] = Array((CONE_SEGS + 1) * 4).fill(0)
    ring(0, prev)
    for (let r = 1; r <= CONE_RINGS; r++) {
      const u0 = (r - 1) / CONE_RINGS
      const u1 = r / CONE_RINGS
      ring(u1, next)
      for (let s = 0; s < CONE_SEGS; s++) {
        const a = s * 4
        const b = (s + 1) * 4
        this.quad(
          [prev[a]!, prev[a + 1]!, prev[a + 2]!, prev[b]!, prev[b + 1]!, prev[b + 2]!, next[b]!, next[b + 1]!, next[b + 2]!, next[a]!, next[a + 1]!, next[a + 2]!],
          [s / CONE_SEGS, u0, (s + 1) / CONE_SEGS, u0, (s + 1) / CONE_SEGS, u1, s / CONE_SEGS, u1],
          [alpha * prev[a + 3]!, alpha * prev[b + 3]!, alpha * next[b + 3]!, alpha * next[a + 3]!],
          KIND.cone,
        )
      }
      ;[prev, next] = [next, prev]
    }
  }

  /** Starts a vapour cone on jet `id` and leaves a shock ring at (x, y, z) across its path (dx, dy, dz unit). */
  boom(id: number, x: number, y: number, z: number, dx: number, dy: number, dz: number, strength = 1): void {
    this.cones.set(id, { age: 0, strength })
    if (this.rings.length < 8) this.rings.push({ x, y, z, dx, dy, dz, age: 0, strength })
  }

  private shockRings(): void {
    const dt = this.dt
    this.rings = this.rings.filter((r) => (r.age += dt) < 0.7)
    for (const r of this.rings) {
      const k = r.age / 0.7
      const R = 5 + 30 * Math.sqrt(k)
      const W = 2 + 6 * k
      const a = 0.22 * r.strength * (1 - k) * (1 - k) * smooth(r.age / 0.04)
      let ax = -r.dz
      let az = r.dx
      let al = Math.hypot(ax, az)
      if (al < 1e-3) {
        ax = 1
        az = 0
        al = 1
      }
      ax /= al
      az /= al
      const bx = r.dy * az
      const by = r.dz * ax - r.dx * az
      const bz = -r.dy * ax
      const at = (ang: number, rad: number, out: number[], o: number) => {
        const c = Math.cos(ang) * rad
        const s = Math.sin(ang) * rad
        out[o] = r.x + ax * c + bx * s
        out[o + 1] = r.y + by * s
        out[o + 2] = r.z + az * c + bz * s
      }
      const q: number[] = Array(12).fill(0)
      for (let i = 0; i < RING_SEGS; i++) {
        const a0 = (i / RING_SEGS) * Math.PI * 2
        const a1 = ((i + 1) / RING_SEGS) * Math.PI * 2
        at(a0, R - W, q, 0)
        at(a1, R - W, q, 3)
        at(a1, R + W, q, 6)
        at(a0, R + W, q, 9)
        this.quad(q, [i / RING_SEGS, -1, (i + 1) / RING_SEGS, -1, (i + 1) / RING_SEGS, 1, i / RING_SEGS, 1], [a, a, a, a], KIND.ring)
      }
    }
  }

  upload(): void {
    this.shockRings()
    for (const [id, c] of this.cones) if (c.age > FLIGHT_FX.coneTime) this.cones.delete(id)
    this.drawn = this.n
    if (this.n) this.renderer.context.device.queue.writeBuffer(this.buf, 0, this.data, 0, this.n * FLOATS)
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.drawn) return
    pass.setPipeline(this.pipe)
    pass.setVertexBuffer(0, this.buf)
    pass.draw(this.drawn)
  }
}

const smooth = (x: number) => {
  const t = Math.max(0, Math.min(1, x))
  return t * t * (3 - 2 * t)
}
