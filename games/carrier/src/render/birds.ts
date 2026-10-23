import type { LabControl } from "@arcade/kit/lab-panel"
import { Flock } from "@arcade/kit/sim/boids"
import { mulberry32 } from "@arcade/kit/sim/rng"
import { type Archipelago, terrainHeight } from "../../shared/islands"
import { ATMOSPHERE_WGSL } from "./atmosphere"
import { FRAME_BINDING_WGSL } from "./frame"
import type { Renderer, ScenePass } from "./renderer"

export type BirdSettings = {
  on: boolean
  /** Flocks in the world (the islands' shores get one each, biggest islands first), birds per flock. */
  flocks: number
  size: number
  /** Wingspan (m) and the smallest on-screen size (px), so far flocks still read as specks. */
  span: number
  minPx: number
  /** Height over the water (m), the circle around the shore point (m) and the flock's looseness (m). */
  height: number
  circle: number
  spread: number
  /** A jet within this range (m) scatters a flock; ships scare them at 60% of it. */
  scare: number
  /** Seconds a scattered flock takes to settle back. */
  settle: number
  /** Wingbeats per second. */
  flap: number
}

export const BIRD_DEFAULTS: Readonly<BirdSettings> = { on: true, flocks: 10, size: 16, span: 3, minPx: 2.2, height: 26, circle: 70, spread: 9, scare: 320, settle: 9, flap: 2.6 }
export const BIRDS: BirdSettings = { ...BIRD_DEFAULTS }

const G = "Seabirds"
export const BIRD_CONTROLS: LabControl[] = [
  { key: "on", label: "Seabirds", group: G, type: "toggle" },
  { key: "flocks", label: "Flocks", group: G, min: 0, max: 16, step: 1 },
  { key: "size", label: "Birds per flock", group: G, min: 3, max: 24, step: 1 },
  { key: "span", label: "Wingspan", group: G, min: 0.8, max: 5, step: 0.1, unit: "m" },
  { key: "minPx", label: "Smallest on screen", group: G, min: 0, max: 4, step: 0.1, unit: "px" },
  { key: "height", label: "Height over water", group: G, min: 6, max: 80, step: 1, unit: "m" },
  { key: "circle", label: "Circle radius", group: G, min: 20, max: 200, step: 5, unit: "m" },
  { key: "spread", label: "Flock looseness", group: G, min: 2, max: 30, step: 0.5, unit: "m" },
  { key: "scare", label: "Scatter range (jets)", group: G, min: 50, max: 900, step: 10, unit: "m" },
  { key: "settle", label: "Settle time", group: G, min: 1, max: 30, step: 0.5, unit: "s" },
  { key: "flap", label: "Wingbeat", group: G, min: 0.5, max: 6, step: 0.1, unit: "Hz" },
]

const MAX_FLOCKS = 16
const MAX_SIZE = 24
const MAX_BIRDS = MAX_FLOCKS * MAX_SIZE
/** Floats per bird instance: position, flap phase, velocity, scale. */
const INST = 8
/** Flocks farther than this from the camera neither step nor draw (m). */
const ACTIVE = 3000

const BIRD_WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
${ATMOSPHERE_WGSL}
struct BirdU { misc: vec4f } // x = time (s), y = focal length (px), z = min px, w = unused
@group(1) @binding(0) var<uniform> U: BirdU;

struct VI { @location(0) pos: vec4f, @location(1) vel: vec4f }
struct VO { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) n: vec3f, @location(2) shade: f32 }

// A gull in model space (x right, y up, z forward), wingspan 1: body diamond, then each wing as an inner quad (the arm)
// and an outer triangle (the hand), hinged at the shoulder and the wrist. Vertex: (x, y, z, part) with part 0 body,
// 1 inner wing, 2 outer wing, 3 wingtip (dark).
const V = array<vec4f, 24>(
  vec4f(0.0, 0.0, 0.32, 0.0), vec4f(-0.05, 0.0, 0.0, 0.0), vec4f(0.0, 0.0, -0.3, 0.0),
  vec4f(0.0, 0.0, 0.32, 0.0), vec4f(0.0, 0.0, -0.3, 0.0), vec4f(0.05, 0.0, 0.0, 0.0),
  vec4f(0.04, 0.0, 0.1, 1.0), vec4f(0.04, 0.0, -0.08, 1.0), vec4f(0.24, 0.0, 0.06, 1.0),
  vec4f(0.04, 0.0, -0.08, 1.0), vec4f(0.24, 0.0, -0.06, 1.0), vec4f(0.24, 0.0, 0.06, 1.0),
  vec4f(0.24, 0.0, 0.06, 2.0), vec4f(0.24, 0.0, -0.06, 2.0), vec4f(0.5, 0.0, -0.1, 3.0),
  vec4f(-0.04, 0.0, 0.1, 1.0), vec4f(-0.24, 0.0, 0.06, 1.0), vec4f(-0.04, 0.0, -0.08, 1.0),
  vec4f(-0.04, 0.0, -0.08, 1.0), vec4f(-0.24, 0.0, 0.06, 1.0), vec4f(-0.24, 0.0, -0.06, 1.0),
  vec4f(-0.24, 0.0, 0.06, 2.0), vec4f(-0.5, 0.0, -0.1, 3.0), vec4f(-0.24, 0.0, -0.06, 2.0),
);

@vertex fn vs(@builtin(vertex_index) vi: u32, inst: VI) -> VO {
  var o: VO;
  let v = V[vi];
  let part = v.w;
  var p = v.xyz;
  let side = sign(p.x);
  // Wingbeat: the arm swings about the shoulder, the hand lags and swings further (an M on the downstroke).
  let ph = inst.pos.w;
  let beat = sin(ph);
  let arm = 0.55 * beat + 0.12;
  let hand = 0.75 * sin(ph - 0.7) + 0.05;
  if (part >= 1.0) {
    let sx = abs(p.x) - 0.04;
    var y = sx * sin(arm);
    var x = 0.04 + sx * cos(arm);
    if (part >= 2.0) {
      let r = abs(p.x) - 0.24;
      let wx = 0.04 + 0.2 * cos(arm);
      let wy = 0.2 * sin(arm);
      x = wx + r * cos(arm + hand);
      y = wy + r * sin(arm + hand);
    }
    p = vec3f(side * x, y, p.z);
  }
  // Orientation from the velocity: nose along it, banked a little into turns is skipped (birds read as specks).
  let fwd = normalize(inst.vel.xyz + vec3f(0.0, 0.0, 1e-4));
  let right = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)) + vec3f(1e-4, 0.0, 0.0));
  let up = cross(right, fwd);
  // Never smaller than misc.z pixels on screen.
  let dist = length(inst.pos.xyz - F.eye.xyz);
  let scale = max(inst.vel.w, U.misc.z * dist / U.misc.y);
  let world = inst.pos.xyz + (right * -p.x + up * p.y + fwd * p.z) * scale;
  o.pos = F.viewProj * vec4f(world, 1.0);
  o.world = world;
  // A wing's normal tilts with the arm; good enough for faceted light.
  let tilt = select(0.0, side * (arm + select(0.0, hand, part >= 2.0)), part >= 1.0);
  o.n = normalize(up * cos(tilt) + right * sin(tilt));
  o.shade = select(1.0, 0.18, part >= 3.0);
  return o;
}

@fragment fn fs(o: VO, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var n = select(-o.n, o.n, front);
  // Gulls: white below and on the body, pale grey mantle above, dark wingtips.
  let top = n.y > 0.0;
  let albedo = select(vec3f(0.92, 0.93, 0.95), vec3f(0.62, 0.66, 0.72), top) * o.shade;
  let sun = F.sunDir.xyz;
  let ndl = abs(dot(n, sun)) * 0.8 + 0.2 * max(dot(n, sun), 0.0);
  let direct = F.sunColor.rgb * F.sunDir.w * ndl;
  let ambient = mix(ambientBounce(), ambientSky(n), n.y * 0.5 + 0.5) * F.sunColor.w;
  return vec4f(applyFog(albedo * (direct + ambient), o.world), 1.0);
}
`

type Site = { flock: Flock; cx: number; cz: number; r: number; dir: number; ang: number; y: number; scatter: number }

/**
 * Seabirds: small flocks of gulls wheeling over island shores (a shore point per island, biggest islands first, all
 * from the world seed), each a kit boids `Flock` following an anchor that circles the point. A jet or a ship passing
 * close scatters the flock (it breaks up and climbs) and it settles back over several seconds. Silent by design.
 * Instanced low-poly gulls ("opaque" slot), flapping in the vertex shader, never smaller than a speck on screen.
 */
export class Birds implements ScenePass {
  private device: GPUDevice
  private pipe: GPURenderPipeline
  private inst: GPUBuffer
  private ubuf: GPUBuffer
  private group: GPUBindGroup
  private data = new Float32Array(MAX_BIRDS * INST)
  private u = new Float32Array(4)
  private sites: Site[] = []
  private count = 0
  private time = 0
  private seed = -1

  constructor(r: Renderer) {
    const ctx = r.context
    const d = (this.device = ctx.device)
    const module = r.module(BIRD_WGSL, "birds")
    const layout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }] })
    this.pipe = d.createRenderPipeline({
      label: "birds",
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
      fragment: { module, entryPoint: "fs", targets: [{ format: ctx.color }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: true, depthCompare: "greater-equal" },
      multisample: { count: ctx.samples },
    })
    this.inst = d.createBuffer({ label: "birds-inst", size: this.data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.ubuf = d.createBuffer({ label: "birds-u", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.group = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.ubuf } }] })
  }

  /** Flock sites for a world (deterministic from its seed): one shore point per island, biggest islands first. */
  setWorld(arch: Archipelago): void {
    this.seed = arch.seed
    this.sites = []
    const rnd = mulberry32((arch.seed ^ 0xb1d5eed) >>> 0)
    const islands = [...arch.islands].sort((a, b) => b.radius - a.radius)
    for (const isl of islands) {
      if (this.sites.length >= MAX_FLOCKS) break
      const a = rnd() * Math.PI * 2
      const dx = Math.cos(a)
      const dz = Math.sin(a)
      // Walk out from the centre to the waterline, then a little past it.
      let r = 0
      const max = isl.radius * 3 + 400
      while (r < max && terrainHeight(arch, isl.x + dx * r, isl.z + dz * r) > 0) r += 8
      if (r >= max) continue
      const off = 30 + rnd() * 40
      const cx = isl.x + dx * (r + off)
      const cz = isl.z + dz * (r + off)
      const flock = new Flock(MAX_SIZE, (arch.seed * 31 + this.sites.length * 977) >>> 0, cx, BIRD_DEFAULTS.height, cz, 20)
      this.sites.push({ flock, cx, cz, r: 0.7 + rnd() * 0.6, dir: rnd() < 0.5 ? -1 : 1, ang: rnd() * Math.PI * 2, y: 0.75 + rnd() * 0.5, scatter: 0 })
    }
  }

  /** Flocks for scripts (`carrier.birds.flocks`): centre, live scatter. */
  get flocks(): readonly { x: number; z: number; scatter: number }[] {
    return this.sites.map((s) => ({ x: s.cx, z: s.cz, scatter: s.scatter }))
  }

  /**
   * Steps every flock near the camera. `jets` and `ships` are flat [x, y, z, …] lists of what scares them.
   * `fov` and `height` give the focal length for the smallest on-screen size.
   */
  update(dt: number, eye: ArrayLike<number>, jets: ArrayLike<number>, ships: ArrayLike<number>, fov: number, height: number): void {
    const k = BIRDS
    this.count = 0
    if (!k.on || this.seed < 0) return
    dt = Math.min(dt, 0.05)
    this.time += dt
    const n = Math.min(MAX_SIZE, Math.max(1, Math.round(k.size)))
    const flocks = Math.min(this.sites.length, Math.round(k.flocks))
    const d = this.data
    for (let f = 0; f < flocks; f++) {
      const s = this.sites[f]!
      const ex = s.cx - eye[0]!
      const ez = s.cz - eye[2]!
      if (ex * ex + ez * ez > ACTIVE * ACTIVE) continue
      // Scared by anything close (3D for jets so one passing high above doesn't count).
      let threat = 0
      const ay = k.height * s.y
      for (let i = 0; i + 2 < jets.length; i += 3) {
        const dd = Math.hypot(jets[i]! - s.cx, jets[i + 1]! - ay, jets[i + 2]! - s.cz)
        if (dd < k.scare + k.circle) threat = 1
      }
      for (let i = 0; i + 2 < ships.length; i += 3) {
        const dd = Math.hypot(ships[i]! - s.cx, ships[i + 2]! - s.cz)
        if (dd < k.scare * 0.6 + k.circle) threat = 1
      }
      s.scatter = threat ? Math.min(1, s.scatter + dt * 3) : Math.max(0, s.scatter - dt / k.settle)
      const sc = s.scatter
      // The anchor circles the shore point; scattered, it climbs and the circle and the flock open up.
      const rad = k.circle * s.r * (1 + sc * 1.5)
      const speed = 9 + sc * 5
      s.ang += (s.dir * speed * dt) / Math.max(10, rad)
      const ax = s.cx + Math.cos(s.ang) * rad
      const az = s.cz + Math.sin(s.ang) * rad
      const avx = -Math.sin(s.ang) * s.dir * speed
      const avz = Math.cos(s.ang) * s.dir * speed
      s.flock.step(dt, n, ax, ay + sc * 40, az, avx, avz, k.spread * (1 + sc * 2.5), sc)
      const fl = s.flock
      for (let i = 0; i < n; i++) {
        const o = this.count * INST
        d[o] = fl.x[i]!
        d[o + 1] = fl.y[i]!
        d[o + 2] = fl.z[i]!
        // Each bird its own wingbeat; scattered birds flap harder, settled ones glide some of the time.
        const glide = sc > 0.2 ? 1 : 0.55 + 0.45 * Math.sin(this.time * 0.6 + i * 1.7 + f)
        d[o + 3] = (this.time * k.flap * (1 + sc * 0.6) * Math.PI * 2 + i * 2.39) * (glide > 0.3 ? 1 : 0) + (glide > 0.3 ? 0 : 0.2)
        d[o + 4] = fl.vx[i]!
        d[o + 5] = fl.vy[i]! * 0.3
        d[o + 6] = fl.vz[i]!
        d[o + 7] = k.span * (0.85 + 0.3 * (((i * 7919) % 13) / 13))
        this.count++
      }
    }
    if (!this.count) return
    this.device.queue.writeBuffer(this.inst, 0, d, 0, this.count * INST)
    this.u[0] = this.time
    this.u[1] = height / (2 * Math.tan(fov / 2))
    this.u[2] = k.minPx
    this.device.queue.writeBuffer(this.ubuf, 0, this.u)
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.count) return
    pass.setPipeline(this.pipe)
    pass.setBindGroup(1, this.group)
    pass.setVertexBuffer(0, this.inst)
    pass.draw(24, this.count)
  }
}
