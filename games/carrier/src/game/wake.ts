import { BEAM_WL, LENGTH } from "../../shared/carrier-spec"
import type { Sea } from "../../shared/sea"
import type { Ship } from "../../shared/ship"
import { WAKE_FORMAT, WAKE_SIZE, setWakeCentre, wakeTarget, type WakeTarget } from "../render/ocean-wake"
import type { Renderer, ScenePass } from "../render/renderer"

/**
 * Ship wakes as foam strength drawn into the ocean's wake field (src/render/ocean-wake.ts), Sea of Thieves-style: the
 * ocean shader turns it into the same chunky, broken foam as its crest foam and surf, on the water itself, so wakes
 * ride the swell and break up with it. Per hull: a narrow churned stern trail that widens slowly and fades with age,
 * the two thin arms of the Kelvin wedge, and a thin bow wave peeling off both sides of the stem.
 */
export const WAKE = {
  /** Trail point spacing (m) and length (points). */
  spacing: 9,
  points: 72,
  /** Seconds for the churned trail to fade, its half width at the stern and how fast it spreads (m/s). */
  life: 70,
  halfWidth: 15,
  spread: 0.18,
  maxHalfWidth: 30,
  /** Kelvin arm half-angle (tan 19.47°), its line half width (m), strength and how far back it reaches (m). */
  kelvin: 0.354,
  armWidth: 2.6,
  armStrength: 0.4,
  armReach: 420,
  /** Speed (m/s) at which the foam reaches full strength. */
  fullSpeed: 11,
}

const FLOATS = 5 // x, z (relative to the field centre), across (-1..1), age (0..1), strength
const MAX_VERTS = 60_000

/** Hull half-breadth at the waterline from the bow back (f, half width): carrier-mesh.ts STATIONS at y = 0. */
const BOW_LINE: [number, number][] = [
  [165, 9],
  [160, 17.5],
  [153, 21.5],
  [143, 24],
  [128, 25],
  [104, 25.6],
  [60, 25.6],
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
  // Strongest down the middle of each strip, soft at its edges; the ocean breaks it into foam clusters.
  let across = abs(o.aas.x);
  let s = o.aas.z * (1.0 - smoothstep(0.35, 1.0, across));
  return vec4f(s, o.aas.y * step(0.003, s), 0.0, 1.0);
}
`

type Point = { x: number; z: number; t: number; strength: number }
type Trail = { points: Point[]; seen: number }

/** Per frame: `begin(sea, t, eye)`, `ship(id, ship)` for each hull, then `upload()`. Renders in `prepare`. */
export class Wake implements ScenePass {
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
  private px = new Float64Array(WAKE.points + 1)
  private pz = new Float64Array(WAKE.points + 1)
  private age = new Float64Array(WAKE.points + 1)
  private str = new Float64Array(WAKE.points + 1)
  private dist = new Float64Array(WAKE.points + 1)
  private nx = new Float64Array(WAKE.points + 1)
  private nz = new Float64Array(WAKE.points + 1)
  private al = new Float64Array(WAKE.points + 1)
  private xs = new Float64Array((WAKE.points + 1) * 4)
  private bowAlong = new Float64Array(BOW_LINE.length)

  constructor(private renderer: Renderer) {
    const d = renderer.context.device
    this.target = wakeTarget(d)
    this.buf = d.createBuffer({ label: "wake", size: this.data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    const module = renderer.module(FIELD_WGSL, "wake-field")
    const max: GPUBlendComponent = { operation: "max", srcFactor: "one", dstFactor: "one" }
    this.pipe = d.createRenderPipeline({
      label: "wake-field",
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
    this.pass = { colorAttachments: [{ view: this.target.view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] }
    for (let i = 1; i < BOW_LINE.length; i++) this.bowAlong[i] = this.bowAlong[i - 1]! + (BOW_LINE[i - 1]![0] - BOW_LINE[i]![0])
  }

  reset(): void {
    this.trails.clear()
  }

  begin(_sea: Sea, t: number, eye: readonly number[]): void {
    this.t = t
    this.n = 0
    this.frame++
    setWakeCentre(this.target, eye[0]!, eye[2]!)
  }

  /** Adds one hull's foam. `id` keys its trail (the player is -1). */
  ship(id: number, s: Ship): void {
    let trail = this.trails.get(id)
    if (!trail) this.trails.set(id, (trail = { points: [], seen: 0 }))
    trail.seen = this.frame
    const sh = Math.sin(s.heading)
    const ch = Math.cos(s.heading)
    const strength = Math.min(1, Math.max(0, s.u) / WAKE.fullSpeed)
    // The trail starts at the transom.
    const back = -LENGTH / 2 + 4
    const sx = s.x + back * sh
    const sz = s.z - back * ch
    const pts = trail.points
    const head = pts[0]
    if (!head || Math.hypot(sx - head.x, sz - head.z) >= WAKE.spacing) {
      pts.unshift({ x: sx, z: sz, t: this.t, strength })
      if (pts.length > WAKE.points) pts.length = WAKE.points
    } else if (head.t > this.t) {
      pts.length = 0
    }
    const c = this.target.centre
    if (Math.abs(s.x - c[0]!) > WAKE_SIZE / 2 + 800 || Math.abs(s.z - c[1]!) > WAKE_SIZE / 2 + 800) return
    this.trail(pts, sx, sz, strength)
    this.bow(s, sh, ch, strength)
  }

  private trail(pts: Point[], sx: number, sz: number, strength: number): void {
    if (pts.length < 2) return
    const { px, pz, age, str, dist, nx, nz } = this
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
    // Churned centre: as wide as the stern, spreading slowly, fading over WAKE.life.
    this.ribbon(
      n,
      (i, side, out) => {
        const w = Math.min(WAKE.maxHalfWidth, WAKE.halfWidth + age[i]! * WAKE.spread)
        out[0] = px[i]! + nx[i]! * w * side
        out[1] = pz[i]! + nz[i]! * w * side
      },
      (i) => str[i]! * Math.exp(-age[i]! / (WAKE.life * 0.5)) * tail(i),
      (i) => Math.min(1, age[i]! / WAKE.life),
    )
    // Kelvin arms: thin lines diverging from the stern quarters.
    for (const arm of [-1, 1]) {
      this.ribbon(
        n,
        (i, side, out) => {
          const c = (BEAM_WL * 0.42 + dist[i]! * WAKE.kelvin) * arm + WAKE.armWidth * (1 + dist[i]! / 300) * side
          out[0] = px[i]! + nx[i]! * c
          out[1] = pz[i]! + nz[i]! * c
        },
        (i) => str[i]! * WAKE.armStrength * Math.max(0, 1 - dist[i]! / WAKE.armReach) * Math.min(1, dist[i]! / 25) * tail(i),
        () => 0.5,
      )
    }
  }

  /** The bow wave: a thin foam band peeling off each side of the stem. */
  private bow(s: Ship, sh: number, ch: number, strength: number): void {
    if (strength <= 0.02) return
    const n = BOW_LINE.length
    for (const side of [-1, 1]) {
      this.ribbon(
        n,
        (i, edge, out) => {
          const [f, hw] = BOW_LINE[i]!
          const reach = (2.5 + 5 * strength) * (0.4 + 0.6 * (1 - i / (n - 1)))
          const ls = (edge < 0 ? hw - 1 : hw + reach) * side
          out[0] = s.x + f * sh + ls * ch
          out[1] = s.z - f * ch + ls * sh
        },
        (i) => strength * (1 - i / (n - 1)) ** 0.8,
        () => 0,
      )
    }
  }

  private edge = new Float64Array(2)

  /** Emits a strip: `edge(i, side, out)` gives the plan position of each side at station i. */
  private ribbon(n: number, edge: (i: number, side: -1 | 1, out: Float64Array) => void, alpha: (i: number) => number, ageOf: (i: number) => number): void {
    if (this.n + (n - 1) * 6 > MAX_VERTS) return
    const EPS = 0.003
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
      if (al[i]! <= EPS && al[j]! <= EPS) continue
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

  /** Clears the field and draws this frame's foam into it, before the main pass samples it. */
  prepare(enc: GPUCommandEncoder): void {
    const p = enc.beginRenderPass(this.pass)
    if (this.drawn) {
      p.setPipeline(this.pipe)
      p.setVertexBuffer(0, this.buf)
      p.draw(this.drawn)
    }
    p.end()
  }

  /** Nothing in the main pass: the ocean draws the foam. */
  draw(): void {}
}
