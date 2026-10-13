import { mat4 } from "wgpu-matrix"
import { ATMOSPHERE_WGSL } from "./atmosphere"
import { BOW_Z, DECK_X0, DECK_X1, DECK_Y, ELEVATOR, ISLAND, STERN_Z } from "../../shared/carrier-spec"
import { type Carrier, hullHalfWidth } from "./carrier-mesh"
import { FRAME_BINDING_WGSL } from "./frame"
import { MESH_LAYOUT } from "./lit"
import { FLOATS_PER_VERT, Mesh, packVerts } from "./mesh"
import { type Lights, lightsFor } from "./lights"
import { turretMountVerts } from "./turret-mounts"
import { NO_TEAM } from "./team"
import type { Renderer, ScenePass } from "./renderer"

/** A ship's pose for drawing: plan position, heave, heading (compass), pitch (bow up) and roll (starboard down), and its
 *  team accent (linear RGB, render/team.ts; neutral when absent). */
export type ShipDrawPose = { x: number; heave: number; z: number; heading: number; pitch: number; roll: number; radar: number; accent?: readonly [number, number, number] }

/** Material id of team-accent faces: coloured per ship from its uniform. */
const ACCENT = 3

type V3 = [number, number, number]

/** An accent quad, wound counter-clockwise seen from `n` whatever order the corners come in. */
function accentQuad(m: Mesh, a: V3, b: V3, c: V3, d: V3, n: V3): void {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const f = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!]
  const l = Math.hypot(n[0], n[1], n[2]) || 1
  const nn: V3 = [n[0] / l, n[1] / l, n[2] / l]
  if (f[0]! * nn[0] + f[1]! * nn[1] + f[2]! * nn[2] >= 0) m.quad(a, b, c, d, nn, [1, 1, 1], ACCENT as 0)
  else m.quad(a, d, c, b, nn, [1, 1, 1], ACCENT as 0)
}

/** A band around an axis-aligned block (x0..x1, z0..z1) between heights y0 and y1, `out` metres proud of its faces. */
function band(m: Mesh, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, out: number): void {
  const a = x0 - out
  const b = x1 + out
  const c = z0 - out
  const d = z1 + out
  accentQuad(m, [a, y0, c], [a, y0, d], [a, y1, d], [a, y1, c], [-1, 0, 0])
  accentQuad(m, [b, y0, c], [b, y0, d], [b, y1, d], [b, y1, c], [1, 0, 0])
  accentQuad(m, [a, y0, c], [b, y0, c], [b, y1, c], [a, y1, c], [0, 0, -1])
  accentQuad(m, [a, y0, d], [b, y0, d], [b, y1, d], [a, y1, d], [0, 0, 1])
}

/**
 * The team accents every carrier wears, from the spec rects (the procedural hull is not touched): a band round the
 * island's upper tier and the radar platform, safety-stripe segments along both deck edges, and a stripe on each bow
 * just above the waterline.
 */
export function buildShipAccents(): number[] {
  const m = new Mesh()
  // Island (on the starboard edge, −X). Upper tier: x −37.8..−26 (authoring x 26..37.8, mirrored), z from 4 m aft of the bridge tier's
  // back to 1 m behind the forward face (carrier-mesh.ts buildIslandAt), top at deck + 26.4.
  const fwd = ISLAND.z1 - 6
  band(m, ISLAND.x0 + 0.6, ISLAND.z0 + 14, ISLAND.x1 - 3, fwd - 1, DECK_Y + 24.2, DECK_Y + 26.1, 0.12)
  // Radar platform block (mast at authoring x 31.4, 12 m aft of the forward face; block ±4.4 x ±2.8, 2.2 m tall).
  band(m, -31.4 - 4.4, fwd - 12 - 2.8, -31.4 + 4.4, fwd - 12 + 2.8, DECK_Y + 37.6, DECK_Y + 39.4, 0.1)
  // Deck-edge safety stripes: 8 m segments every 16 m along both edges, clear of the island and the elevator.
  const y = DECK_Y + 0.05
  for (let z = STERN_Z + 8; z + 8 <= BOW_Z - 6; z += 16) {
    if (!(z + 8 > ELEVATOR.z0 && z < ELEVATOR.z1)) accentQuad(m, [DECK_X1 - 1.15, y, z], [DECK_X1 - 0.35, y, z], [DECK_X1 - 0.35, y, z + 8], [DECK_X1 - 1.15, y, z + 8], [0, 1, 0])
    if (!(z + 8 > ISLAND.z0 - 2 && z < ISLAND.z1 + 2)) accentQuad(m, [DECK_X0 + 0.25, y, z], [DECK_X0 + 0.95, y, z], [DECK_X0 + 0.95, y, z + 8], [DECK_X0 + 0.25, y, z + 8], [0, 1, 0])
  }
  // Bow stripes just above the waterline, following the hull's flare.
  const y0 = 3.2
  const y1 = 6.2
  for (const side of [-1, 1]) {
    for (let z = 84; z < 158; z += 4) {
      const z1 = Math.min(158, z + 4)
      const p = (zz: number, yy: number): V3 => [side * (hullHalfWidth(yy, zz) + 0.12), yy, zz]
      accentQuad(m, p(z, y0), p(z1, y0), p(z1, y1), p(z, y1), [side, 0, 0])
    }
  }
  return m.v
}

/** Ships drawn at once (the player plus a full room). */
export const MAX_SHIPS = 33

/** The carrier lit like the static world (lit.ts), with a model matrix per object so it can move and the radar turn. */
const SHIP_WGSL = /* wgsl */ `
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
  @location(3) @interpolate(flat) mat: f32,
  @location(4) @interpolate(flat) aux: f32,
}

@vertex fn vs(v: VIn) -> VOut {
  let w = O.model * vec4f(v.pos, 1.0);
  var o: VOut;
  o.pos = F.viewProj * w;
  o.world = w.xyz;
  o.normal = (O.model * vec4f(v.normal.xyz, 0.0)).xyz;
  o.color = pow(v.color.rgb, vec3f(2.2));
  o.mat = v.matAux.x;
  o.aux = v.matAux.y;
  return o;
}

fn lightSurface(albedo: vec3f, n: vec3f, world: vec3f) -> vec3f {
  let sun = F.sunDir.xyz;
  let ndl = max(dot(n, sun), 0.0);
  let direct = F.sunColor.rgb * F.sunDir.w * ndl;
  let sky = ambientSky(n);
  let bounce = ambientBounce();
  let ambient = mix(bounce, sky, n.y * 0.5 + 0.5) * F.sunColor.w;
  let v = normalize(F.eye.xyz - world);
  let rim = pow(1.0 - max(dot(n, v), 0.0), 4.0) * smoothstep(-0.2, 0.6, dot(n, sun)) * 0.45;
  return albedo * (direct + ambient + F.sunColor.rgb * rim * rimLight());
}

@fragment fn fs(o: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var n = normalize(o.normal);
  n = select(-n, n, front);
  var c: vec3f;
  if (o.mat > 0.5 && o.mat < 1.5) { c = o.color * (2.0 + o.aux * 4.0); }
  else if (o.mat > ${ACCENT - 0.5}) { c = lightSurface(O.accent.rgb * o.color.r * 1.1, n, o.world); }
  else { c = lightSurface(o.color, n, o.world); }
  return vec4f(applyFog(c, o.world), 1.0);
}
`

const SLOT = 256
const SLOT_FLOATS = SLOT / 4

/**
 * Draws up to MAX_SHIPS carriers ("opaque" slot). Call `begin()`, `add(pose)` per ship, then `upload()` each frame.
 * Ship space: +Z bow, +X port, −X starboard (the island side), origin on the waterline amidships. A proper rotation maps +Z to the
 * heading, so the model is never mirrored.
 */
export class ShipPass implements ScenePass {
  private hull: { buf: GPUBuffer; verts: number }
  private radar: { buf: GPUBuffer; verts: number }
  private pivot: [number, number, number]
  private uniform: GPUBuffer
  private group: GPUBindGroup
  private pipe: GPURenderPipeline
  private staging = new Float32Array(SLOT_FLOATS * MAX_SHIPS * 2)
  private count = 0
  private m = mat4.create()
  private r = mat4.create()
  /** Night lights (src/render/lights.ts): every ship added here gets them. */
  lights: Lights | null

  constructor(
    private renderer: Renderer,
    carrier: Carrier,
  ) {
    this.lights = lightsFor(renderer)
    const ctx = renderer.context
    const d = ctx.device
    const upload = (v: ArrayLike<number>, label: string) => {
      const data = packVerts(v)
      const buf = d.createBuffer({ label, size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(buf, 0, data)
      return { buf, verts: v.length / FLOATS_PER_VERT }
    }
    // The deck stays empty: aircraft are spawned by the game, not baked into the hull. Only the weapons' fixed
    // pedestals are baked in: their turrets and barrels train and elevate in src/render/turret-pass.ts.
    this.hull = upload([...carrier.hull.v, ...buildShipAccents(), ...turretMountVerts()], "ship-hull")
    this.radar = upload(carrier.radar.v, "ship-radar")
    this.pivot = carrier.radarPivot
    const layout = d.createBindGroupLayout({
      label: "ship-obj",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 80 } }],
    })
    this.uniform = d.createBuffer({ label: "ship-obj", size: this.staging.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.group = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uniform, size: 80 } }] })
    const module = renderer.module(SHIP_WGSL, "ship")
    this.pipe = d.createRenderPipeline({
      label: "ship",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, layout] }),
      vertex: { module, entryPoint: "vs", buffers: [MESH_LAYOUT] },
      fragment: { module, entryPoint: "fs", targets: [{ format: ctx.color }] },
      primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: true, depthCompare: "greater-equal" },
      multisample: { count: ctx.samples },
    })
  }

  begin(): void {
    this.count = 0
    this.lights?.beginShips()
  }

  add(p: ShipDrawPose): void {
    if (this.count >= MAX_SHIPS) return
    this.lights?.ship(p)
    const m = this.m
    mat4.translation([p.x, p.heave, p.z], m)
    mat4.rotateY(m, Math.PI - p.heading, m)
    mat4.rotateX(m, -p.pitch, m)
    mat4.rotateZ(m, p.roll, m)
    const o = this.count * 2 * SLOT_FLOATS
    this.staging.set(m, o)
    mat4.translate(m, this.pivot, this.r)
    mat4.rotateY(this.r, p.radar, this.r)
    this.staging.set(this.r, o + SLOT_FLOATS)
    const a = p.accent ?? NO_TEAM
    for (const at of [o + 16, o + SLOT_FLOATS + 16]) {
      this.staging[at] = a[0]
      this.staging[at + 1] = a[1]
      this.staging[at + 2] = a[2]
      this.staging[at + 3] = 1
    }
    this.count++
  }

  upload(): void {
    if (this.count) this.renderer.context.device.queue.writeBuffer(this.uniform, 0, this.staging, 0, this.count * 2 * SLOT_FLOATS)
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.count) return
    pass.setPipeline(this.pipe)
    for (let i = 0; i < this.count; i++) {
      pass.setBindGroup(1, this.group, [i * 2 * SLOT])
      pass.setVertexBuffer(0, this.hull.buf)
      pass.draw(this.hull.verts)
      pass.setBindGroup(1, this.group, [(i * 2 + 1) * SLOT])
      pass.setVertexBuffer(0, this.radar.buf)
      pass.draw(this.radar.verts)
    }
  }
}
