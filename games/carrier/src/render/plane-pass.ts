import { mat4 } from "wgpu-matrix"
import { PLANE } from "../../shared/plane"
import { ATMOSPHERE_WGSL } from "./atmosphere"
import { FRAME_BINDING_WGSL } from "./frame"
import { MESH_LAYOUT } from "./lit"
import { FLOATS_PER_VERT, packVerts } from "./mesh"
import type { VehicleKind } from "../../shared/vehicles"
import { ACCENT, type PlaneModel, type PlaneModels } from "./plane-glb"
import { NO_TEAM } from "./team"
import type { Renderer, ScenePass } from "./renderer"

/** A jet as drawn: centre position, orientation (body → world), control surfaces, gear and engine. */
export type PlaneDrawPose = {
  x: number
  y: number
  z: number
  qx: number
  qy: number
  qz: number
  qw: number
  /** Stick -1..1 (the stabilisers deflect with it). */
  pitch: number
  roll: number
  /** Gear 0 (up) .. 1 (down). */
  gear: number
  /** Throttle 0..1 and afterburner 0..1. */
  throttle: number
  burner: number
  /** Tailhook 0 (stowed) .. 1 (down). */
  hook?: number
  /** Leave the canopy out (the cockpit view sits inside it). */
  noCanopy?: boolean
  /** Team accent, linear RGB (render/team.ts); neutral grey when absent. */
  accent?: readonly [number, number, number]
  /** Aircraft type (its model); the Hornet when absent. */
  kind?: VehicleKind
  /** Weapons-bay doors 0 (shut) .. 1 (open). */
  doors?: number
  /** Bombs still aboard (the model's last `stores` stations in release order); all when absent. */
  stores?: number
}

/** Every player's jet (32 + a harness drone) plus every jet parked on four decks (shared/deck-jets.ts). */
export const MAX_PLANES = 45
/** Uniform slots per jet: body, stabilisers, gear, canopy, hook, two bay doors, four stores. */
const PIECES = 12
const SLOT = 256
const SLOT_FLOATS = SLOT / 4
const STAB_MAX = (20 * Math.PI) / 180

/**
 * Lit like the carrier (ship-pass.ts), plus a sun glint so the paint reads as metal and the gold canopy flashes.
 * Faces tagged ACCENT (plane-glb.ts) take the jet's team colour from its uniform, scaled by the vertex red channel,
 * lit like paint (a touch brighter than albedo so the colour carries at a few hundred metres, never emissive).
 */
const PLANE_WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
${ATMOSPHERE_WGSL}
struct Obj { model: mat4x4f, accent: vec4f }
@group(1) @binding(0) var<uniform> O: Obj;

struct VIn { @location(0) pos: vec3f, @location(1) normal: vec4f, @location(2) color: vec4f, @location(3) matAux: vec2f }
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) @interpolate(flat) aux: f32,
  @location(4) @interpolate(flat) mat: f32,
}

@vertex fn vs(v: VIn) -> VOut {
  let w = O.model * vec4f(v.pos, 1.0);
  var o: VOut;
  o.pos = F.viewProj * w;
  o.world = w.xyz;
  o.normal = (O.model * vec4f(v.normal.xyz, 0.0)).xyz;
  o.color = pow(v.color.rgb, vec3f(2.2));
  o.aux = v.matAux.y;
  o.mat = v.matAux.x;
  return o;
}

@fragment fn fs(o: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var n = normalize(o.normal);
  n = select(-n, n, front);
  let sun = F.sunDir.xyz;
  let ndl = max(dot(n, sun), 0.0);
  let direct = F.sunColor.rgb * F.sunDir.w * ndl;
  let sky = ambientSky(n);
  let bounce = ambientBounce();
  let ambient = mix(bounce, sky, n.y * 0.5 + 0.5) * F.sunColor.w;
  // The sunlit sea below throws light back up (more with a high sun): undersides and the inner faces of the fins stay
  // in the paint's grey family seen from below, not a navy silhouette.
  let below = saturate(0.35 - n.y * 0.65);
  let seaLight = (F.sunColor.rgb * F.sunDir.w * max(sun.y, 0.0) * 0.3 + bounce * F.sunColor.w * 0.6) * below;
  let v = normalize(F.eye.xyz - o.world);
  let rim = pow(1.0 - max(dot(n, v), 0.0), 4.0) * smoothstep(-0.2, 0.6, dot(n, sun)) * 0.45;
  let h = normalize(v + sun);
  let shiny = o.aux;
  let spec = pow(max(dot(n, h), 0.0), mix(60.0, 220.0, shiny)) * mix(0.18, 1.6, shiny) * F.sunDir.w * ndl;
  // The sky reflected in the canopy.
  let r = reflect(-v, n);
  let env = mix(F.horizon.rgb, F.zenith.rgb, clamp(r.y, 0.0, 1.0)) * shiny * 0.35 * pow(1.0 - max(dot(n, v), 0.0), 2.0);
  var albedo = o.color;
  if (o.mat > ${ACCENT - 0.5}) { albedo = O.accent.rgb * o.color.r * 1.15; }
  let c = albedo * (direct + ambient + seaLight + F.sunColor.rgb * rim * rimLight()) + F.sunColor.rgb * spec + env;
  return vec4f(applyFog(c, o.world), 1.0);
}
`

/** A model's pieces on the GPU. */
type Buf = { buf: GPUBuffer; verts: number }
type GpuModel = { model: PlaneModel; body: Buf; stabL: Buf; stabR: Buf; gear: Buf; canopy: Buf; hook: Buf; doorL: Buf | null; doorR: Buf | null; stores: Buf[] }

/**
 * Draws up to MAX_PLANES jets ("opaque" slot), each with its own type's model (plane-glb.ts registry): body, both
 * stabilisers on their spindles, the gear when it is down, canopy, tailhook, bay doors and the bombs still aboard.
 * Call `begin()`, `add(pose)` per jet, then `upload()` each frame. The model maps to the world by a proper rotation.
 */
export class PlanePass implements ScenePass {
  private gpu: Record<VehicleKind, GpuModel>
  private uniform: GPUBuffer
  private group: GPUBindGroup
  private pipe: GPURenderPipeline
  private staging = new Float32Array(SLOT_FLOATS * MAX_PLANES * PIECES)
  /** This frame's draws: a piece and its uniform slot. */
  private draws: { piece: Buf; slot: number }[] = []
  private slots = 0
  private count = 0
  private m = mat4.create()
  private s = mat4.create()
  private q = new Float32Array(4)

  constructor(
    private renderer: Renderer,
    readonly models: PlaneModels,
  ) {
    const ctx = renderer.context
    const d = ctx.device
    const upload = (v: ArrayLike<number>, label: string): Buf => {
      const data = packVerts(v)
      const buf = d.createBuffer({ label, size: Math.max(16, data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(buf, 0, data)
      return { buf, verts: v.length / FLOATS_PER_VERT }
    }
    const gpu = (model: PlaneModel): GpuModel => {
      const k = model.kind
      return {
        model,
        body: upload(model.body, `plane-${k}-body`),
        stabL: upload(model.stabL.verts, `plane-${k}-stab-l`),
        stabR: upload(model.stabR.verts, `plane-${k}-stab-r`),
        gear: upload(model.gear, `plane-${k}-gear`),
        canopy: upload(model.canopy, `plane-${k}-canopy`),
        hook: upload(model.hook.verts, `plane-${k}-hook`),
        doorL: model.doorL && upload(model.doorL.verts, `plane-${k}-door-l`),
        doorR: model.doorR && upload(model.doorR.verts, `plane-${k}-door-r`),
        stores: model.stores.map((st, i) => upload(st.verts, `plane-${k}-store-${i}`)),
      }
    }
    this.gpu = { hornet: gpu(models.hornet), f35: gpu(models.f35) }
    const layout = d.createBindGroupLayout({
      label: "plane-obj",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 80 } }],
    })
    this.uniform = d.createBuffer({ label: "plane-obj", size: this.staging.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.group = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uniform, size: 80 } }] })
    const module = renderer.module(PLANE_WGSL, "plane")
    this.pipe = d.createRenderPipeline({
      label: "plane",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, layout] }),
      vertex: { module, entryPoint: "vs", buffers: [MESH_LAYOUT] },
      fragment: { module, entryPoint: "fs", targets: [{ format: ctx.color }] },
      // Thin wings and fins are modelled as closed solids, but draw both faces: cheap at 1-2k triangles, and safe.
      primitive: { topology: "triangle-list", cullMode: "none", frontFace: "ccw" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: true, depthCompare: "greater-equal" },
      multisample: { count: ctx.samples },
    })
  }

  /** The Hornet's model (the default type). */
  get model(): PlaneModel {
    return this.models.hornet
  }

  begin(): void {
    this.count = 0
    this.slots = 0
    this.draws.length = 0
  }

  /** The model matrix of a pose (model space → world) into `out`. */
  modelMatrix(p: PlaneDrawPose, out: Float32Array): Float32Array {
    this.q[0] = p.qx
    this.q[1] = p.qy
    this.q[2] = p.qz
    this.q[3] = p.qw
    mat4.fromQuat(this.q, this.s)
    mat4.translation([p.x, p.y, p.z], out)
    mat4.multiply(out, this.s, out)
    mat4.translate(out, [0, -this.models[p.kind ?? "hornet"].centre, 0], out)
    return out
  }

  /** Queues `piece` with transform `m` and the jet's accent. */
  private put(piece: Buf | null, m: Float32Array, a: readonly [number, number, number]): void {
    if (!piece || !piece.verts || this.slots >= MAX_PLANES * PIECES) return
    const at = this.slots * SLOT_FLOATS
    this.staging.set(m, at)
    this.staging[at + 16] = a[0]
    this.staging[at + 17] = a[1]
    this.staging[at + 18] = a[2]
    this.staging[at + 19] = 1
    this.draws.push({ piece, slot: this.slots++ })
  }

  add(p: PlaneDrawPose): void {
    if (this.count >= MAX_PLANES) return
    this.count++
    const g = this.gpu[p.kind ?? "hornet"]
    const model = g.model
    const a = p.accent ?? NO_TEAM
    const m = this.modelMatrix(p, this.m)
    this.put(g.body, m, a)
    // Stabilisers: pitch moves both (positive about local X lifts the trailing edge), roll moves them differentially.
    const pitch = Math.max(-1, Math.min(1, p.pitch))
    const roll = Math.max(-1, Math.min(1, p.roll))
    const turn = (piece: Buf | null, pivot: readonly number[], rx: number, rz: number) => {
      mat4.translate(m, pivot, this.s)
      if (rx) mat4.rotateX(this.s, rx, this.s)
      if (rz) mat4.rotateZ(this.s, rz, this.s)
      this.put(piece, this.s, a)
    }
    turn(g.stabL, model.stabL.pivot, (pitch * 0.8 - roll * 0.5) * STAB_MAX, 0)
    turn(g.stabR, model.stabR.pivot, (pitch * 0.8 + roll * 0.5) * STAB_MAX, 0)
    // Gear retracts upward into the belly and vanishes when stowed.
    const gear = Math.max(0, Math.min(1, p.gear))
    if (gear > 0.02) {
      mat4.translate(m, [0, 0.5, 0], this.s)
      mat4.scale(this.s, [1, gear, 1], this.s)
      mat4.translate(this.s, [0, -0.5, 0], this.s)
      this.put(g.gear, this.s, a)
    }
    if (!p.noCanopy) this.put(g.canopy, m, a)
    turn(g.hook, model.hook.pivot, Math.max(0, Math.min(1, p.hook ?? 0)) * model.hookDown, 0)
    // Bay doors: the inner edges swing down, the left about +Z and the right about -Z.
    if (model.doorL && model.doorR) {
      const d = Math.max(0, Math.min(1, p.doors ?? 0))
      const k = d * d * (3 - 2 * d)
      turn(g.doorL, model.doorL.pivot, 0, k * model.doorOpen)
      turn(g.doorR, model.doorR.pivot, 0, -k * model.doorOpen)
    }
    // Stores still aboard: the last `stores` of the release order (the next to go is the first of them).
    const n = model.stores.length
    const left = Math.max(0, Math.min(n, p.stores ?? n))
    for (let i = n - left; i < n; i++) {
      mat4.translate(m, model.stores[i]!.pivot, this.s)
      this.put(g.stores[i]!, this.s, a)
    }
  }

  /** A released store (a falling bomb): station `index` of type `kind`'s model at (x, y, z), nose along (dx, dy, dz). */
  addStore(kind: VehicleKind, index: number, x: number, y: number, z: number, dx: number, dy: number, dz: number): void {
    const piece = this.gpu[kind].stores[index]
    const l = Math.hypot(dx, dy, dz)
    if (!piece || l < 1e-6) return
    const fx = dx / l
    const fy = dy / l
    const fz = dz / l
    // Basis: +Z along the flight path, +X level (up × Z), +Y = Z × X.
    let rx = fz
    let rz = -fx
    const rl = Math.hypot(rx, rz)
    if (rl < 1e-5) {
      rx = 1
      rz = 0
    } else {
      rx /= rl
      rz /= rl
    }
    const m = this.s
    m.set([rx, 0, rz, 0, fy * rz, fz * rx - fx * rz, -fy * rx, 0, fx, fy, fz, 0, x, y, z, 1])
    this.put(piece, m, NO_TEAM)
  }

  upload(): void {
    if (this.slots) this.renderer.context.device.queue.writeBuffer(this.uniform, 0, this.staging, 0, this.slots * SLOT_FLOATS)
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.draws.length) return
    pass.setPipeline(this.pipe)
    for (const d of this.draws) {
      pass.setBindGroup(1, this.group, [d.slot * SLOT])
      pass.setVertexBuffer(0, d.piece.buf)
      pass.draw(d.piece.verts)
    }
  }
}
