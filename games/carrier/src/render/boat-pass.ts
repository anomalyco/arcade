import { mat4 } from "wgpu-matrix"
import { ATMOSPHERE_WGSL } from "./atmosphere"
import { BOAT_ACCENT, type BoatModel } from "./boat-glb"
import { FRAME_BINDING_WGSL } from "./frame"
import { LIGHT_KIND, type LightDef, type Lights, lightsFor } from "./lights"
import { MESH_LAYOUT } from "./lit"
import { FLOATS_PER_VERT, packVerts } from "./mesh"
import { NO_TEAM } from "./team"
import type { Renderer, ScenePass } from "./renderer"

/** A boat as drawn: origin position (y = heave), heading, pitch (bow up), roll (starboard down), its moving parts and
 *  team accent (linear RGB; neutral when absent). */
export type BoatDrawPose = {
  x: number
  y: number
  z: number
  heading: number
  pitch: number
  roll: number
  /** Radar bar angle (rad), turret yaw (+ toward port) and gun elevation (+ up), nozzle steer −1..1. */
  radar: number
  yaw: number
  gun: number
  nozzle: number
  accent?: readonly [number, number, number]
}

export const MAX_BOATS = 24
/** Uniform slots per boat: body, radar, turret, gun, two nozzles. */
const PIECES = 6
const SLOT = 256
const SLOT_FLOATS = SLOT / 4
/** Full nozzle deflection (rad). */
const NOZZLE = 0.4

/**
 * The boat at night (COLREGs for a power-driven vessel): red sidelight to port (+X), green to starboard, a white
 * masthead light on the mast, a white stern light, and the team-coloured mast cap as a slow amber beacon. Model space.
 */
export function boatLights(): LightDef[] {
  const RED: [number, number, number] = [1.0, 0.07, 0.04]
  const GREEN: [number, number, number] = [0.12, 1.0, 0.3]
  const k = (c: [number, number, number], s: number): [number, number, number] => [c[0] * s, c[1] * s, c[2] * s]
  return [
    { p: [2.05, 2.85, 1.7], color: k(RED, 16), size: 0.22, px: 1.8 },
    { p: [-2.05, 2.85, 1.7], color: k(GREEN, 16), size: 0.22, px: 1.8 },
    { p: [0, 4.3, -0.62], color: k([1, 1, 1], 18), size: 0.24, px: 2 },
    { p: [0, 2.05, -8.45], color: k([1, 0.9, 0.72], 8), size: 0.2, px: 1.4 },
    { p: [0, 5.0, -0.92], color: k([1.0, 0.52, 0.12], 9), size: 0.2, px: 1.3, kind: LIGHT_KIND.beacon, phase: 0.7 },
  ]
}

/** Lit like the jets (plane-pass.ts): sun, sky, sea bounce, rim, and a glint for the gold glass and the gun metal. */
const BOAT_WGSL = /* wgsl */ `
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
  let below = saturate(0.35 - n.y * 0.65);
  let seaLight = (F.sunColor.rgb * F.sunDir.w * max(sun.y, 0.0) * 0.3 + bounce * F.sunColor.w * 0.6) * below;
  let v = normalize(F.eye.xyz - o.world);
  let rim = pow(1.0 - max(dot(n, v), 0.0), 4.0) * smoothstep(-0.2, 0.6, dot(n, sun)) * 0.45;
  let h = normalize(v + sun);
  let shiny = o.aux;
  let spec = pow(max(dot(n, h), 0.0), mix(40.0, 200.0, shiny)) * mix(0.12, 1.4, shiny) * F.sunDir.w * ndl;
  let r = reflect(-v, n);
  let env = mix(F.horizon.rgb, F.zenith.rgb, clamp(r.y, 0.0, 1.0)) * shiny * 0.3 * pow(1.0 - max(dot(n, v), 0.0), 2.0);
  var albedo = o.color;
  if (o.mat > ${BOAT_ACCENT - 0.5}) { albedo = O.accent.rgb * o.color.r * 1.15; }
  let c = albedo * (direct + ambient + seaLight + F.sunColor.rgb * rim * rimLight()) + F.sunColor.rgb * spec + env;
  return vec4f(applyFog(c, o.world), 1.0);
}
`

type Buf = { buf: GPUBuffer; verts: number }

/**
 * Draws up to MAX_BOATS boats ("opaque" slot, before the ocean so early-z rejects the water under them). Per frame:
 * `begin()`, `add(pose)` per boat, `upload()`. The model maps to the world exactly like ShipPass (ship space). Every boat
 * added hangs its nav lights on the renderer's Lights (src/render/lights.ts) when there is one.
 */
export class BoatPass implements ScenePass {
  private body: Buf
  private radar: Buf
  private turret: Buf
  private gun: Buf
  private jetL: Buf
  private jetR: Buf
  private uniform: GPUBuffer
  private group: GPUBindGroup
  private pipe: GPURenderPipeline
  private staging = new Float32Array(SLOT_FLOATS * MAX_BOATS * PIECES)
  private draws: { piece: Buf; slot: number }[] = []
  private slots = 0
  private count = 0
  private m = mat4.create()
  private s = mat4.create()
  private t = mat4.create()
  /** Night lights, and the boats' light set on them. */
  lights: Lights | null
  private lightSet = -1

  constructor(
    private renderer: Renderer,
    readonly model: BoatModel,
  ) {
    const ctx = renderer.context
    const d = ctx.device
    const upload = (v: ArrayLike<number>, label: string): Buf => {
      const data = packVerts(v)
      const buf = d.createBuffer({ label, size: Math.max(16, data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(buf, 0, data)
      return { buf, verts: v.length / FLOATS_PER_VERT }
    }
    this.body = upload(model.body, "boat-body")
    this.radar = upload(model.radar.verts, "boat-radar")
    this.turret = upload(model.turret.verts, "boat-turret")
    this.gun = upload(model.gun.verts, "boat-gun")
    this.jetL = upload(model.jetL.verts, "boat-jet-l")
    this.jetR = upload(model.jetR.verts, "boat-jet-r")
    const layout = d.createBindGroupLayout({
      label: "boat-obj",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 80 } }],
    })
    this.uniform = d.createBuffer({ label: "boat-obj", size: this.staging.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.group = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uniform, size: 80 } }] })
    const module = renderer.module(BOAT_WGSL, "boat")
    this.pipe = d.createRenderPipeline({
      label: "boat",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, layout] }),
      vertex: { module, entryPoint: "vs", buffers: [MESH_LAYOUT] },
      fragment: { module, entryPoint: "fs", targets: [{ format: ctx.color }] },
      primitive: { topology: "triangle-list", cullMode: "none", frontFace: "ccw" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: true, depthCompare: "greater-equal" },
      multisample: { count: ctx.samples },
    })
    this.lights = lightsFor(renderer)
    if (this.lights) this.lightSet = this.lights.addLights(boatLights(), MAX_BOATS)
  }

  begin(): void {
    if (this.lightSet > 0) this.lights?.beginSet(this.lightSet)
    this.count = 0
    this.slots = 0
    this.draws.length = 0
  }

  /** The model matrix of a pose (model space → world) into `out`, as ShipPass places a carrier. */
  modelMatrix(p: BoatDrawPose, out: Float32Array): Float32Array {
    mat4.translation([p.x, p.y, p.z], out)
    mat4.rotateY(out, Math.PI - p.heading, out)
    mat4.rotateX(out, -p.pitch, out)
    mat4.rotateZ(out, p.roll, out)
    return out
  }

  private put(piece: Buf, m: Float32Array, a: readonly [number, number, number]): void {
    if (!piece.verts || this.slots >= MAX_BOATS * PIECES) return
    const at = this.slots * SLOT_FLOATS
    this.staging.set(m, at)
    this.staging[at + 16] = a[0]
    this.staging[at + 17] = a[1]
    this.staging[at + 18] = a[2]
    this.staging[at + 19] = 1
    this.draws.push({ piece, slot: this.slots++ })
  }

  /** Queues one boat. `id` staggers its beacon. */
  add(p: BoatDrawPose, id = 0): void {
    if (this.count >= MAX_BOATS) return
    this.count++
    const a = p.accent ?? NO_TEAM
    const m = this.modelMatrix(p, this.m)
    this.put(this.body, m, a)
    if (this.lights && this.lightSet > 0) this.lights.jet(this.lightSet, m, 0, 0, id)
    const md = this.model
    mat4.translate(m, md.radar.pivot, this.s)
    mat4.rotateY(this.s, p.radar, this.s)
    this.put(this.radar, this.s, a)
    mat4.translate(m, md.turret.pivot, this.s)
    mat4.rotateY(this.s, p.yaw, this.s)
    this.put(this.turret, this.s, a)
    mat4.translate(this.s, md.gun.pivot, this.t)
    mat4.rotateX(this.t, -p.gun, this.t)
    this.put(this.gun, this.t, a)
    const steer = Math.max(-1, Math.min(1, p.nozzle)) * NOZZLE
    for (const [piece, part] of [
      [this.jetL, md.jetL],
      [this.jetR, md.jetR],
    ] as const) {
      mat4.translate(m, part.pivot, this.s)
      mat4.rotateY(this.s, steer, this.s)
      this.put(piece, this.s, a)
    }
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
