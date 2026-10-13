import { mat4 } from "wgpu-matrix"
import { WEAPON_MOUNTS, type WeaponKind } from "../../shared/carrier-spec"
import { ATMOSPHERE_WGSL } from "./atmosphere"
import type { Carrier } from "./carrier-mesh"
import { FRAME_BINDING_WGSL } from "./frame"
import { MESH_LAYOUT } from "./lit"
import { FLOATS_PER_VERT, packVerts } from "./mesh"
import type { Renderer, ScenePass } from "./renderer"
import { MAX_SHIPS, type ShipDrawPose, buildShipAccents } from "./ship-pass"
import { buildShipWeapons } from "./ship-weapons"
import { NO_TEAM } from "./team"
import { turretMountVerts } from "./turret-mounts"

/** Material id of team-accent faces (as ship-pass.ts). */
const ACCENT = 3

/** Lit exactly like ship-pass.ts (one model matrix per object). */
const TURRET_WGSL = /* wgsl */ `
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
/** Objects per ship: hull, radar (harness only), then a turret and a barrel per mount. */
const PER_SHIP = 2 + WEAPON_MOUNTS.length * 2
/** Turrets beyond this distance from the eye are not drawn (a few pixels at most). */
const CULL = 9000


type Range = { first: number; count: number }

/**
 * The ship weapons' moving parts, per ship ("opaque" slot): every mount's turret trained to its yaw and its barrel or
 * launcher elevated to its pitch (shared/gunnery.ts angles), on the ship's live pose. Call `begin()`, `add(pose,
 * angles)` per ship, then `upload()` each frame. `angles` is [yaw0, pitch0, yaw1, pitch1, ...] in `WEAPON_MOUNTS`
 * order (null: every turret at rest).
 * With `hull` (the gunnery harness) it also draws the carrier itself, its mounts baked in, so no rest-pose turrets show.
 */
export class TurretPass implements ScenePass {
  private buf: GPUBuffer
  /** Turret and barrel vertex ranges per weapon kind. */
  private parts = new Map<WeaponKind, { turret: Range; barrel: Range }>()
  private hullRange: Range | null = null
  private radarRange: Range | null = null
  private radarPivot: [number, number, number] = [0, 0, 0]
  private uniform: GPUBuffer
  private group: GPUBindGroup
  private pipe: GPURenderPipeline
  private staging = new Float32Array(SLOT_FLOATS * MAX_SHIPS * PER_SHIP)
  /** Each slot's vertex range (slot i draws ranges[i]). */
  private ranges: Range[] = []
  private at = new Float32Array(3)
  private count = 0
  private ships = 0
  private m = mat4.create()
  private t = mat4.create()
  private b = mat4.create()
  private eye: ArrayLike<number> | null = null
  private rest = new Float32Array(WEAPON_MOUNTS.length * 2)

  constructor(
    private renderer: Renderer,
    opts: { hull?: Carrier } = {},
  ) {
    const d = renderer.context.device
    const verts: number[] = []
    const range = (v: ArrayLike<number>): Range => {
      const first = verts.length / FLOATS_PER_VERT
      for (let i = 0; i < v.length; i++) verts.push(v[i]!)
      return { first, count: v.length / FLOATS_PER_VERT }
    }
    if (opts.hull) {
      this.hullRange = range([...opts.hull.hull.v, ...buildShipAccents(), ...turretMountVerts()])
      this.radarRange = range(opts.hull.radar.v)
      this.radarPivot = opts.hull.radarPivot
    }
    const weapons = buildShipWeapons()
    for (const w of weapons) if (!this.parts.has(w.kind)) this.parts.set(w.kind, { turret: range(w.turret.v), barrel: range(w.barrel.v) })
    for (const [i, w] of weapons.entries()) {
      this.rest[i * 2] = w.restYaw
      this.rest[i * 2 + 1] = w.restPitch
    }
    const data = packVerts(verts)
    this.buf = d.createBuffer({ label: "turrets", size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(this.buf, 0, data)
    const layout = d.createBindGroupLayout({
      label: "turret-obj",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 80 } }],
    })
    this.uniform = d.createBuffer({ label: "turret-obj", size: this.staging.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.group = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uniform, size: 80 } }] })
    const module = renderer.module(TURRET_WGSL, "turrets")
    const ctx = renderer.context
    this.pipe = d.createRenderPipeline({
      label: "turrets",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, layout] }),
      vertex: { module, entryPoint: "vs", buffers: [MESH_LAYOUT] },
      fragment: { module, entryPoint: "fs", targets: [{ format: ctx.color }] },
      primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: true, depthCompare: "greater-equal" },
      multisample: { count: ctx.samples },
    })
  }

  /** Start of a frame; `eye` (world) culls far turrets. */
  begin(eye: ArrayLike<number> | null = null): void {
    this.count = 0
    this.ships = 0
    this.eye = eye
  }

  private slot(model: Float32Array, accent: readonly number[] | undefined, range: Range): void {
    const o = this.count * SLOT_FLOATS
    this.staging.set(model, o)
    const a = accent ?? NO_TEAM
    this.staging[o + 16] = a[0]!
    this.staging[o + 17] = a[1]!
    this.staging[o + 18] = a[2]!
    this.staging[o + 19] = 1
    this.ranges[this.count] = range
    this.count++
  }

  /** One ship: its pose and its turrets' angles (null: all at rest). */
  add(p: ShipDrawPose, angles: ArrayLike<number> | null = null): void {
    if (this.ships >= MAX_SHIPS) return
    this.ships++
    const m = this.m
    this.at[0] = p.x
    this.at[1] = p.heave
    this.at[2] = p.z
    mat4.translation(this.at, m)
    mat4.rotateY(m, Math.PI - p.heading, m)
    mat4.rotateX(m, -p.pitch, m)
    mat4.rotateZ(m, p.roll, m)
    if (this.hullRange && this.radarRange) {
      this.slot(m as Float32Array, p.accent, this.hullRange)
      mat4.translate(m, this.radarPivot, this.t)
      mat4.rotateY(this.t, p.radar, this.t)
      this.slot(this.t as Float32Array, p.accent, this.radarRange)
    }
    const e = this.eye
    if (e && Math.hypot(p.x - e[0]!, p.z - e[2]!) > CULL) return
    const a = angles ?? this.rest
    const weapons = buildShipWeapons()
    for (let i = 0; i < weapons.length; i++) {
      const w = weapons[i]!
      const part = this.parts.get(w.kind)!
      mat4.translate(m, w.yawPivot, this.t)
      mat4.rotateY(this.t, a[i * 2]!, this.t)
      this.slot(this.t as Float32Array, p.accent, part.turret)
      mat4.translate(this.t, w.pitchPivot, this.b)
      mat4.rotateX(this.b, -a[i * 2 + 1]!, this.b)
      this.slot(this.b as Float32Array, p.accent, part.barrel)
    }
  }

  upload(): void {
    if (this.count) this.renderer.context.device.queue.writeBuffer(this.uniform, 0, this.staging, 0, this.count * SLOT_FLOATS)
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.count) return
    pass.setPipeline(this.pipe)
    pass.setVertexBuffer(0, this.buf)
    for (let i = 0; i < this.count; i++) {
      const r = this.ranges[i]!
      pass.setBindGroup(1, this.group, [i * SLOT])
      pass.draw(r.count, 1, r.first)
    }
  }
}
