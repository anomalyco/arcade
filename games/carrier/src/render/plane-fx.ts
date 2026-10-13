import { ATMOSPHERE_WGSL } from "./atmosphere"
import { FRAME_BINDING_WGSL } from "./frame"
import { type Lights, lightsFor } from "./lights"
import type { VehicleKind } from "../../shared/vehicles"
import type { PlaneModel, PlaneModels } from "./plane-glb"
import type { Renderer, ScenePass } from "./renderer"

/** Flame cones: rings along the length × segments around, built from the vertex index (no vertex buffer). */
const RINGS = 10
const SEGS = 14
const CONE_VERTS = RINGS * SEGS * 6
/** Two cones per nozzle (core and plume), two nozzles per jet. */
const MAX_FLAMES = 33 * 4
const FLAME_FLOATS = 20

const FLAME_WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
struct Flame { model: mat4x4f, p: vec4f } // p: intensity, burner, kind (0 core, 1 plume), phase
@group(1) @binding(0) var<storage, read> flames: array<Flame>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) u: f32,
  @location(3) @interpolate(flat) p: vec4f,
}

const TAU: f32 = 6.2831853;

fn radius(u: f32, kind: f32) -> f32 {
  // Swells just behind the nozzle, then tapers to a point.
  if (kind > 1.5) {
    // Bursts (spray, fireball): a column, widest just above its base, tapering to a rounded top.
    return (1.0 - 0.55 * u) * (0.75 + 0.25 * sin(min(u * 1.6, 1.0) * 3.14159)) * sqrt(max(1.0 - u * u * u, 0.0));
  }
  let swell = 1.0 + 0.22 * sin(min(u * 2.2, 1.0) * 3.14159) * kind;
  return swell * pow(max(1.0 - u, 0.0), mix(0.85, 0.55, kind));
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let f = flames[ii];
  let quad = vi / 6u;
  let corner = vi % 6u;
  let ring = quad / ${SEGS}u;
  let seg = quad % ${SEGS}u;
  var dr = array<u32, 6>(0u, 1u, 1u, 0u, 1u, 0u);
  var ds = array<u32, 6>(0u, 0u, 1u, 0u, 1u, 1u);
  let u = f32(ring + dr[corner]) / ${RINGS}.0;
  let a = f32(seg + ds[corner]) / ${SEGS}.0 * TAU;
  let r = radius(u, f.p.z);
  let local = vec3f(cos(a) * r, sin(a) * r, u);
  let w = f.model * vec4f(local, 1.0);
  var o: VOut;
  o.pos = F.viewProj * w;
  o.world = w.xyz;
  o.normal = normalize((f.model * vec4f(cos(a), sin(a), 0.0, 0.0)).xyz);
  o.u = u;
  o.p = f.p;
  return o;
}

@fragment fn fs(o: VOut) -> @location(0) vec4f {
  let v = normalize(F.eye.xyz - o.world);
  let face = abs(dot(normalize(o.normal), v));
  let thick = pow(face, 1.4);
  let u = o.u;
  let burner = o.p.y;
  let core = o.p.z < 0.5;
  // White-hot at the nozzle, yellow, orange, then a dim red tail.
  var col = mix(vec3f(1.0, 0.92, 0.78), vec3f(1.0, 0.55, 0.16), smoothstep(0.0, 0.45, u));
  col = mix(col, vec3f(0.85, 0.2, 0.05), smoothstep(0.45, 1.0, u));
  if (core) { col = mix(vec3f(0.75, 0.85, 1.0), vec3f(1.0, 0.8, 0.5), u); }
  if (o.p.z > 1.5 && o.p.z < 2.5) {
    // Spray column: white water, sunlit, fading up its height.
    let spray = F.sunColor.rgb * (F.sunDir.w * 0.25 + F.sunColor.w * 0.6);
    return vec4f(spray * o.p.x * pow(face, 2.0) * (1.0 - smoothstep(0.1, 1.0, u)) * smoothstep(0.0, 0.08, u), 0.0);
  }
  // Shock diamonds in the afterburner plume.
  let diamonds = 1.0 + burner * 0.9 * pow(max(sin(u * 5.5 * TAU - o.p.w), 0.0), 3.0) * (1.0 - u);
  let fade = (1.0 - smoothstep(0.55, 1.0, u)) * smoothstep(0.0, 0.04, u + 0.02);
  let k = o.p.x * thick * fade * diamonds * select(1.0, 2.2, core);
  return vec4f(col * k, 0.0);
}
`

const TRAIL_WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
${ATMOSPHERE_WGSL}
struct VIn { @location(0) pos: vec3f, @location(1) av: vec2f }
struct VOut { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) av: vec2f }

@vertex fn vs(v: VIn) -> VOut {
  var o: VOut;
  o.pos = F.viewProj * vec4f(v.pos, 1.0);
  o.world = v.pos;
  o.av = v.av;
  return o;
}

@fragment fn fs(o: VOut) -> @location(0) vec4f {
  let edge = 1.0 - o.av.y * o.av.y;
  let a = o.av.x * edge;
  let lit = F.sunColor.rgb * (F.sunDir.w * 0.35 + F.sunColor.w * 0.9);
  let c = applyFog(lit, o.world);
  return vec4f(c * a, a);
}
`

/** Wingtip vapour: points every ~1/30 s, kept TRAIL_LIFE seconds. */
const TRAIL_LIFE = 1.6
const TRAIL_POINTS = 64
const TRAIL_FLOATS = 5
const MAX_TRAIL_VERTS = 33 * 2 * TRAIL_POINTS * 6

type TrailPoint = { x: number; y: number; z: number; t: number; a: number }
type Trails = { tips: TrailPoint[][]; seen: number }

export type FlameInput = { model: Float32Array; throttle: number; burner: number; phase: number }

/**
 * Engine flames and wingtip vapour ("alpha" slot). Per frame: `begin(eye, time)`, then `plane(id, model, throttle,
 * burner, vapour)` for each jet (model = its model matrix from PlanePass.modelMatrix), then `upload()`.
 */
export class PlaneFx implements ScenePass {
  private flamePipe: GPURenderPipeline
  private flameBuf: GPUBuffer
  private flameGroup: GPUBindGroup
  private flameData = new Float32Array(MAX_FLAMES * FLAME_FLOATS)
  private flames = 0
  private trailPipe: GPURenderPipeline
  private trailBuf: GPUBuffer
  private trailData = new Float32Array(MAX_TRAIL_VERTS * TRAIL_FLOATS)
  private trailVerts = 0
  private trails = new Map<number, Trails>()
  private eye: [number, number, number] = [0, 0, 0]
  private time = 0
  private lights: Lights | null = null
  /** Each model's light set (src/render/lights.ts). */
  private lightSets: Partial<Record<VehicleKind, number>> = {}

  constructor(
    private renderer: Renderer,
    private models: PlaneModels,
  ) {
    const ctx = renderer.context
    const d = ctx.device
    this.setLights(lightsFor(renderer))
    this.flameBuf = d.createBuffer({ label: "plane-flames", size: this.flameData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    const layout = d.createBindGroupLayout({ label: "plane-flames", entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }] })
    this.flameGroup = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.flameBuf } }] })
    const fm = renderer.module(FLAME_WGSL, "plane-flame")
    const add: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" } }
    this.flamePipe = d.createRenderPipeline({
      label: "plane-flame",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, layout] }),
      vertex: { module: fm, entryPoint: "vs" },
      fragment: { module: fm, entryPoint: "fs", targets: [{ format: ctx.color, blend: add }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: false, depthCompare: "greater-equal" },
      multisample: { count: ctx.samples },
    })
    this.trailBuf = d.createBuffer({ label: "plane-trails", size: this.trailData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    const tm = renderer.module(TRAIL_WGSL, "plane-trail")
    const premul: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" } }
    this.trailPipe = d.createRenderPipeline({
      label: "plane-trail",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout] }),
      vertex: {
        module: tm,
        entryPoint: "vs",
        buffers: [{ arrayStride: TRAIL_FLOATS * 4, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x2" }] }],
      },
      fragment: { module: tm, entryPoint: "fs", targets: [{ format: ctx.color, blend: premul }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: false, depthCompare: "greater-equal" },
      multisample: { count: ctx.samples },
    })
  }

  /**
   * Night lights (src/render/lights.ts) for every jet drawn here: wingtip nav lights, fin strobes and engine glow at
   * each model's own wingtips, fins and nozzles (one light set per model).
   */
  setLights(lights: Lights | null): void {
    this.lights = lights
    this.lightSets = {}
    if (lights) for (const m of Object.values(this.models) as PlaneModel[]) this.lightSets[m.kind] = lights.addJet(m)
  }

  begin(eye: ArrayLike<number>, time: number): void {
    this.lights?.beginJets()
    this.eye[0] = eye[0]!
    this.eye[1] = eye[1]!
    this.eye[2] = eye[2]!
    this.time = time
    this.flames = 0
    this.trailVerts = 0
  }

  /** One jet of type `kind`: flames from its throttle and burner at its own nozzles, vapour from its tips while
   *  `vapour` > 0 (0..1). */
  plane(id: number, m: Float32Array, throttle: number, burner: number, vapour: number, kind: VehicleKind = "hornet"): void {
    const model = this.models[kind]
    const set = this.lightSets[kind]
    if (set !== undefined) this.lights?.jet(set, m, throttle, burner, id)
    const r = model.nozzleRadius
    const heat = Math.max(0, throttle - 0.55) / 0.45
    for (const n of model.nozzles) {
      // Plume and core: length and brightness from throttle, much longer and brighter with the burner lit.
      this.flame(m, n, r * (0.9 + 0.15 * burner), 1.2 + 1.6 * heat + 6.8 * burner, 0.25 * heat + 2.6 * burner, burner, 1)
      if (burner > 0.05) this.flame(m, n, r * 0.62, 2.2 + 2.6 * burner, 3.2 * burner, burner, 0)
    }
    this.trail(id, m, vapour, model)
  }

  /** A crash at (x, y, z), `age` seconds ago: a white spray column on the sea, a fireball on land or a ship. */
  burst(x: number, y: number, z: number, age: number, water: boolean): void {
    if (age < 0 || age > 3 || this.flames >= MAX_FLAMES) return
    const o = this.flames * FLAME_FLOATS
    const d = this.flameData
    const grow = 1 - Math.exp(-age * 3)
    const r = (water ? 5 : 9) * (0.3 + grow)
    const h = (water ? 26 : 18) * (0.25 + grow)
    // Radial x, z; the cone's length along +y.
    d.set([r, 0, 0, 0, 0, 0, r, 0, 0, h, 0, 0, x, y - 1, z, 1], o)
    const fade = Math.max(0, 1 - age / 3)
    d[o + 16] = (water ? 0.6 : 3) * fade * fade
    d[o + 17] = water ? 0 : 1
    d[o + 18] = water ? 2 : 1
    d[o + 19] = (age * 13) % (Math.PI * 2)
    this.flames++
  }

  private flame(m: Float32Array, n: [number, number, number], radius: number, length: number, intensity: number, burner: number, kind: number): void {
    if (this.flames >= MAX_FLAMES || intensity < 0.01) return
    const o = this.flames * FLAME_FLOATS
    const d = this.flameData
    // Nozzle frame: x, y radial (scaled by radius), +z backward along the plume (scaled by length).
    for (let c = 0; c < 3; c++) {
      d[o + c] = m[c]! * radius
      d[o + 4 + c] = m[4 + c]! * radius
      d[o + 8 + c] = -m[8 + c]! * length
      d[o + 12 + c] = m[c]! * n[0] + m[4 + c]! * n[1] + m[8 + c]! * n[2] + m[12 + c]!
    }
    d[o + 3] = d[o + 7] = d[o + 11] = 0
    d[o + 15] = 1
    d[o + 16] = intensity
    d[o + 17] = burner
    d[o + 18] = kind
    d[o + 19] = (this.time * 31) % (Math.PI * 2)
    this.flames++
  }

  private trail(id: number, m: Float32Array, vapour: number, model: PlaneModel): void {
    let tr = this.trails.get(id)
    if (!tr || tr.tips.length !== model.tips.length) {
      tr = { tips: model.tips.map(() => []), seen: this.time }
      this.trails.set(id, tr)
    }
    tr.seen = this.time
    model.tips.forEach((tip, i) => {
      const pts = tr.tips[i]!
      const x = m[0]! * tip[0] + m[4]! * tip[1] + m[8]! * tip[2] + m[12]!
      const y = m[1]! * tip[0] + m[5]! * tip[1] + m[9]! * tip[2] + m[13]!
      const z = m[2]! * tip[0] + m[6]! * tip[1] + m[10]! * tip[2] + m[14]!
      const last = pts[pts.length - 1]
      if (last && Math.hypot(x - last.x, y - last.y, z - last.z) > 80) pts.length = 0
      const head = { x, y, z, t: this.time, a: vapour }
      if (!last || this.time - (pts[pts.length - 2]?.t ?? -1) > 1 / 30) pts.push(head)
      else pts[pts.length - 1] = head
      while (pts.length > TRAIL_POINTS || (pts.length && this.time - pts[0]!.t > TRAIL_LIFE)) pts.shift()
      this.ribbon(pts)
    })
  }

  private ribbon(pts: TrailPoint[]): void {
    const d = this.trailData
    const [ex, ey, ez] = this.eye
    const side = (i: number): [number, number, number, number] => {
      const p = pts[i]!
      const a = pts[Math.max(0, i - 1)]!
      const b = pts[Math.min(pts.length - 1, i + 1)]!
      const tx = b.x - a.x
      const ty = b.y - a.y
      const tz = b.z - a.z
      const vx = ex - p.x
      const vy = ey - p.y
      const vz = ez - p.z
      let sx = ty * vz - tz * vy
      let sy = tz * vx - tx * vz
      let sz = tx * vy - ty * vx
      const l = Math.hypot(sx, sy, sz) || 1
      const age = (this.time - p.t) / TRAIL_LIFE
      const w = 0.15 + 0.7 * age
      // Fade where the ribbon passes close to the camera (it streams back toward the chase view).
      const dist = Math.hypot(vx, vy, vz)
      const near = Math.max(0, Math.min(1, (dist - 20) / 60))
      sx = (sx / l) * w
      sy = (sy / l) * w
      sz = (sz / l) * w
      return [sx, sy, sz, p.a * (1 - age) * (1 - age) * 0.32 * near * near]
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      if (this.trailVerts + 6 > MAX_TRAIL_VERTS) return
      const p = pts[i]!
      const q = pts[i + 1]!
      if (p.a < 0.01 && q.a < 0.01) continue
      const [ax, ay, az, aa] = side(i)
      const [bx, by, bz, ba] = side(i + 1)
      const put = (x: number, y: number, z: number, a: number, v: number) => {
        const o = this.trailVerts * TRAIL_FLOATS
        d[o] = x
        d[o + 1] = y
        d[o + 2] = z
        d[o + 3] = a
        d[o + 4] = v
        this.trailVerts++
      }
      put(p.x - ax, p.y - ay, p.z - az, aa, -1)
      put(p.x + ax, p.y + ay, p.z + az, aa, 1)
      put(q.x + bx, q.y + by, q.z + bz, ba, 1)
      put(p.x - ax, p.y - ay, p.z - az, aa, -1)
      put(q.x + bx, q.y + by, q.z + bz, ba, 1)
      put(q.x - bx, q.y - by, q.z - bz, ba, -1)
    }
  }

  upload(): void {
    for (const [id, tr] of this.trails) if (this.time - tr.seen > 2) this.trails.delete(id)
    const q = this.renderer.context.device.queue
    if (this.flames) q.writeBuffer(this.flameBuf, 0, this.flameData, 0, this.flames * FLAME_FLOATS)
    if (this.trailVerts) q.writeBuffer(this.trailBuf, 0, this.trailData, 0, this.trailVerts * TRAIL_FLOATS)
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.trailVerts) {
      pass.setPipeline(this.trailPipe)
      pass.setVertexBuffer(0, this.trailBuf)
      pass.draw(this.trailVerts)
    }
    if (this.flames) {
      pass.setPipeline(this.flamePipe)
      pass.setBindGroup(1, this.flameGroup)
      pass.draw(CONE_VERTS, this.flames)
    }
  }
}

export type { TrailPoint }
