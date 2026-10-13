import type { Boat } from "../../shared/boat"
import { WAKE_FORMAT, WAKE_SIZE, wakeTarget, type WakeTarget } from "./ocean-wake"
import type { Renderer, ScenePass } from "./renderer"

/**
 * Boat wakes, drawn into the ocean's wake field (src/render/ocean-wake.ts) like the carriers' (src/game/wake.ts), so
 * the ocean breaks them into the same chunky foam: a thin churned trail from the waterjets that widens and fades, two
 * faint Kelvin arms, and the bow wave peeling off both chines. Nothing while the hull is in the air. Add it to the
 * "alpha" slot AFTER the carriers' Wake: that pass clears the field and sets its centre, this one draws on top
 * (loadOp "load").
 */
export const BOAT_WAKE = {
  spacing: 3,
  points: 70,
  life: 24,
  halfWidth: 2.6,
  spread: 0.3,
  maxHalfWidth: 9,
  kelvin: 0.354,
  armWidth: 0.9,
  armStrength: 0.45,
  armReach: 140,
  /** Speed (m/s) at full strength. */
  fullSpeed: 12,
}

const FLOATS = 5
const MAX_VERTS = 30_000

/** Half-breadth of the hull at the waterline from the bow back (f, half width), for the bow wave. */
const BOW_LINE: [number, number][] = [
  [8.4, 0.3],
  [6.5, 1.5],
  [4.5, 2.2],
  [2, 2.6],
  [-1, 2.7],
]

const FIELD_WGSL = /* wgsl */ `
struct VIn { @location(0) pos: vec2f, @location(1) aas: vec3f }
struct VOut { @builtin(position) pos: vec4f, @location(0) aas: vec3f }
@vertex fn vs(v: VIn) -> VOut {
  var o: VOut;
  let half = ${WAKE_SIZE / 2}.0;
  o.pos = vec4f(v.pos.x / half, -v.pos.y / half, 0.0, 1.0);
  o.aas = v.aas;
  return o;
}
@fragment fn fs(o: VOut) -> @location(0) vec4f {
  let across = abs(o.aas.x);
  let s = o.aas.z * (1.0 - smoothstep(0.35, 1.0, across));
  return vec4f(s, o.aas.y * step(0.003, s), 0.0, 1.0);
}
`

type Point = { x: number; z: number; t: number; strength: number }
type Trail = { points: Point[]; seen: number }

/** Per frame: `begin(t)`, `boat(id, boat)` for each boat, then `upload()`. Renders in `prepare`. */
export class BoatWake implements ScenePass {
  private buf: GPUBuffer
  private pipe: GPURenderPipeline
  private target: WakeTarget
  private data = new Float32Array(MAX_VERTS * FLOATS)
  private n = 0
  private drawn = 0
  private trails = new Map<number, Trail>()
  private t = 0
  private frame = 0
  private pass: GPURenderPassDescriptor
  private px = new Float64Array(BOAT_WAKE.points + 1)
  private pz = new Float64Array(BOAT_WAKE.points + 1)
  private age = new Float64Array(BOAT_WAKE.points + 1)
  private str = new Float64Array(BOAT_WAKE.points + 1)
  private dist = new Float64Array(BOAT_WAKE.points + 1)
  private nx = new Float64Array(BOAT_WAKE.points + 1)
  private nz = new Float64Array(BOAT_WAKE.points + 1)
  private al = new Float64Array(BOAT_WAKE.points + 1)
  private xs = new Float64Array((BOAT_WAKE.points + 1) * 4)
  private edge = new Float64Array(2)

  constructor(private renderer: Renderer) {
    const d = renderer.context.device
    this.target = wakeTarget(d)
    this.buf = d.createBuffer({ label: "boat-wake", size: this.data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    const module = renderer.module(FIELD_WGSL, "boat-wake-field")
    const max: GPUBlendComponent = { operation: "max", srcFactor: "one", dstFactor: "one" }
    this.pipe = d.createRenderPipeline({
      label: "boat-wake-field",
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: FLOATS * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 8, format: "float32x3" },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format: WAKE_FORMAT, blend: { color: max, alpha: max } }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
    })
    this.pass = { colorAttachments: [{ view: this.target.view, loadOp: "load", storeOp: "store" }] }
  }

  reset(): void {
    this.trails.clear()
  }

  begin(t: number): void {
    this.t = t
    this.n = 0
    this.frame++
  }

  /** One boat's foam (`id` keys its trail). */
  boat(id: number, b: Pick<Boat, "x" | "z" | "heading" | "u" | "wet" | "wetAft">): void {
    let trail = this.trails.get(id)
    if (!trail) this.trails.set(id, (trail = { points: [], seen: 0 }))
    trail.seen = this.frame
    const sh = Math.sin(b.heading)
    const ch = Math.cos(b.heading)
    const strength = Math.min(1, Math.max(0, Math.abs(b.u)) / BOAT_WAKE.fullSpeed) * b.wetAft
    const back = -8.6
    const sx = b.x + back * sh
    const sz = b.z - back * ch
    const pts = trail.points
    const head = pts[0]
    if (!head || Math.hypot(sx - head.x, sz - head.z) >= BOAT_WAKE.spacing) {
      pts.unshift({ x: sx, z: sz, t: this.t, strength })
      if (pts.length > BOAT_WAKE.points) pts.length = BOAT_WAKE.points
    } else if (head.t > this.t) pts.length = 0
    else head.strength = Math.max(head.strength, strength)
    const c = this.target.centre
    if (Math.abs(b.x - c[0]!) > WAKE_SIZE / 2 + 300 || Math.abs(b.z - c[1]!) > WAKE_SIZE / 2 + 300) return
    this.trail(pts, sx, sz, strength)
    this.bow(b, sh, ch, Math.min(1, Math.max(0, b.u) / BOAT_WAKE.fullSpeed) * b.wet)
  }

  private trail(pts: Point[], sx: number, sz: number, strength: number): void {
    if (pts.length < 2) return
    const { px, pz, age, str, dist, nx, nz } = this
    const W = BOAT_WAKE
    const n = pts.length + 1
    px[0] = sx
    pz[0] = sz
    age[0] = 0
    str[0] = strength
    dist[0] = 0
    for (let i = 1; i < n; i++) {
      const p = pts[i - 1]!
      px[i] = p.x
      pz[i] = p.z
      age[i] = Math.max(0, this.t - p.t)
      str[i] = p.strength
      dist[i] = dist[i - 1]! + Math.hypot(px[i]! - px[i - 1]!, pz[i]! - pz[i - 1]!)
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1)
      const b = Math.min(n - 1, i + 1)
      const dx = px[a]! - px[b]!
      const dz = pz[a]! - pz[b]!
      const l = Math.hypot(dx, dz) || 1
      nx[i] = -dz / l
      nz[i] = dx / l
    }
    const tail = (i: number) => Math.min(1, (n - 1 - i) / 3)
    this.ribbon(
      n,
      (i, side, out) => {
        const w = Math.min(W.maxHalfWidth, W.halfWidth + age[i]! * W.spread)
        out[0] = px[i]! + nx[i]! * w * side
        out[1] = pz[i]! + nz[i]! * w * side
      },
      (i) => str[i]! * Math.exp(-age[i]! / (W.life * 0.5)) * tail(i),
      (i) => Math.min(1, age[i]! / W.life),
    )
    for (const arm of [-1, 1]) {
      this.ribbon(
        n,
        (i, side, out) => {
          const c = (2.2 + dist[i]! * W.kelvin) * arm + W.armWidth * (1 + dist[i]! / 80) * side
          out[0] = px[i]! + nx[i]! * c
          out[1] = pz[i]! + nz[i]! * c
        },
        (i) => str[i]! * W.armStrength * Math.max(0, 1 - dist[i]! / W.armReach) * Math.min(1, dist[i]! / 6) * tail(i),
        () => 0.5,
      )
    }
  }

  private bow(b: Pick<Boat, "x" | "z">, sh: number, ch: number, strength: number): void {
    if (strength <= 0.02) return
    const n = BOW_LINE.length
    for (const side of [-1, 1]) {
      this.ribbon(
        n,
        (i, e, out) => {
          const [f, hw] = BOW_LINE[i]!
          const reach = (0.8 + 2.2 * strength) * (0.4 + 0.6 * (i / (n - 1)))
          const ls = (e < 0 ? hw - 0.3 : hw + reach) * side
          out[0] = b.x + f * sh + ls * ch
          out[1] = b.z - f * ch + ls * sh
        },
        (i) => strength * (0.5 + 0.5 * (i / (n - 1))),
        () => 0,
      )
    }
  }

  private ribbon(n: number, edge: (i: number, side: -1 | 1, out: Float64Array) => void, alpha: (i: number) => number, ageOf: (i: number) => number): void {
    if (this.n + (n - 1) * 6 > MAX_VERTS) return
    const { al, xs } = this
    const cx = this.target.centre[0]!
    const cz = this.target.centre[1]!
    const e = this.edge
    for (let i = 0; i < n; i++) {
      al[i] = alpha(i)
      edge(i, -1, e)
      xs[i * 4] = e[0]! - cx
      xs[i * 4 + 1] = e[1]! - cz
      edge(i, 1, e)
      xs[i * 4 + 2] = e[0]! - cx
      xs[i * 4 + 3] = e[1]! - cz
    }
    for (let i = 1; i < n; i++) {
      const j = i - 1
      if (al[i]! <= 0.003 && al[j]! <= 0.003) continue
      const gj = ageOf(j)
      const gi = ageOf(i)
      this.vert(xs[j * 4]!, xs[j * 4 + 1]!, -1, gj, al[j]!)
      this.vert(xs[j * 4 + 2]!, xs[j * 4 + 3]!, 1, gj, al[j]!)
      this.vert(xs[i * 4 + 2]!, xs[i * 4 + 3]!, 1, gi, al[i]!)
      this.vert(xs[j * 4]!, xs[j * 4 + 1]!, -1, gj, al[j]!)
      this.vert(xs[i * 4 + 2]!, xs[i * 4 + 3]!, 1, gi, al[i]!)
      this.vert(xs[i * 4]!, xs[i * 4 + 1]!, -1, gi, al[i]!)
    }
  }

  private vert(x: number, z: number, across: number, age: number, strength: number): void {
    const o = this.n * FLOATS
    const d = this.data
    d[o] = x
    d[o + 1] = z
    d[o + 2] = across
    d[o + 3] = age
    d[o + 4] = Math.min(1, strength)
    this.n++
  }

  upload(): void {
    for (const [id, tr] of this.trails) if (tr.seen !== this.frame) this.trails.delete(id)
    if (this.n) this.renderer.context.device.queue.writeBuffer(this.buf, 0, this.data, 0, this.n * FLOATS)
    this.drawn = this.n
  }

  prepare(enc: GPUCommandEncoder): void {
    if (!this.drawn) return
    const p = enc.beginRenderPass(this.pass)
    p.setPipeline(this.pipe)
    p.setVertexBuffer(0, this.buf)
    p.draw(this.drawn)
    p.end()
  }

  draw(): void {}
}
