import { SEA_UNIFORM_FLOATS, type Sea, packSea, snapSeaOrigin } from "../../shared/sea"
import { SEA_WGSL } from "../../shared/sea.wgsl"
import { ATMOSPHERE_WGSL } from "../render/atmosphere"
import { FRAME_BINDING_WGSL } from "../render/frame"
import type { Renderer, ScenePass } from "../render/renderer"

/** How the zones look (live: every value is read each frame). */
export type ZoneLook = {
  /** Boundary band on the water (m wide; never thinner than ~2 px). */
  band: number
  /** Boundary glow (× the zone colour). */
  ring: number
  /** Tint over the water inside (alpha). */
  fill: number
  /** The light curtain standing on the boundary: height (m) and strength. */
  wallHeight: number
  wall: number
  /** The boundary's dash marks turn this fast (°/s). */
  spin: number
}

export const ZONE_LOOK_DEFAULTS: Readonly<ZoneLook> = {
  band: 16,
  ring: 3.2,
  fill: 0.07,
  wallHeight: 240,
  wall: 0.55,
  spin: 4,
}
export const ZONE_LOOK: ZoneLook = { ...ZONE_LOOK_DEFAULTS }

/** One zone to draw this frame. */
export type ZoneDraw = {
  x: number
  z: number
  r: number
  /** The zone's colour (linear): its holder's, neutral white, or the capturer's blend. */
  color: readonly [number, number, number]
  /** The capturing side's colour and how far it has got (0..1): an arc of the boundary from north, clockwise. */
  capColor: readonly [number, number, number]
  progress: number
  /** Contested: the zone flashes. */
  contested: boolean
  /** An upcoming spot: a dashed ghost ring only. */
  next: boolean
  /** Dash pattern phase (rad). */
  spin: number
}

const MAX_ZONES = 4
const ZONE_FLOATS = 16
/** Disc mesh: segments around, rings out to DISC_EDGE × r (rings bunch toward the boundary). */
const SEGMENTS = 160
const RINGS = 30
const DISC_EDGE = 1.08
const WALL_SEGMENTS = 160

const WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
${ATMOSPHERE_WGSL}
${SEA_WGSL}

struct Zone {
  c: vec4f,    // centre minus sea origin (x, z), radius, next (0/1)
  col: vec4f,  // colour rgb, progress
  cap: vec4f,  // capturer rgb, contested flash 0..1
  misc: vec4f, // dash phase, band width, 0, 0
}
struct Look {
  a: vec4f, // ring, fill, wall height, wall
  b: vec4f, // 0, 0, sea origin x, z
}
@group(1) @binding(0) var<uniform> sea: SeaUniform;
@group(1) @binding(1) var<uniform> Z: array<Zone, ${MAX_ZONES}>;
@group(1) @binding(2) var<uniform> L: Look;

const TAU: f32 = 6.283185307;
const NEUTRAL: vec3f = vec3f(0.82, 0.86, 0.92);
const SEGS: u32 = ${SEGMENTS}u;
const RINGS: u32 = ${RINGS}u;
const WSEGS: u32 = ${WALL_SEGMENTS}u;

struct V {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  // disc: distance from the centre (m), angle (rad); wall: height fraction, angle
  @location(1) polar: vec2f,
  @location(2) @interpolate(flat) zone: u32,
}

fn quadCorner(v: u32) -> vec2u {
  // Two triangles per cell: (0,0) (1,0) (0,1) / (0,1) (1,0) (1,1)
  let c = array<vec2u, 6>(vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u), vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u));
  return c[v % 6u];
}

fn ringFrac(i: u32) -> f32 {
  let u = f32(i) / f32(RINGS);
  // Denser toward the boundary, where the band is.
  return ${DISC_EDGE} * (1.0 - (1.0 - u) * (1.0 - u) * 0.55 - (1.0 - u) * 0.45);
}

@vertex fn vsDisc(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> V {
  let z = Z[ii];
  let cell = vi / 6u;
  let k = quadCorner(vi);
  let seg = cell % SEGS + k.x;
  let ring = cell / SEGS + k.y;
  let a = f32(seg) / f32(SEGS) * TAU;
  let rr = ringFrac(ring) * z.c.z;
  // North is -z; angles run clockwise seen from above (compass).
  let p = z.c.xy + vec2f(sin(a), -cos(a)) * rr;
  let d = seaDisplace(p);
  var w = vec3f(L.b.z + p.x + d.x, d.y, L.b.w + p.y + d.z);
  // Lift a little off the water, more far away where the ocean's coarse tiles stray from the true surface.
  w.y = w.y + 0.7 + distance(w, F.eye.xyz) * 0.0025;
  var o: V;
  o.pos = F.viewProj * vec4f(w, 1.0);
  o.world = w;
  o.polar = vec2f(rr, a);
  o.zone = ii;
  return o;
}

fn zoneColor(z: Zone) -> vec3f {
  return mix(z.col.rgb, vec3f(1.0, 0.97, 0.92), z.cap.w * 0.6);
}

fn glowScale() -> f32 {
  // A little softer at night, when the dark sea makes every light stand out.
  return 1.0 - 0.45 * F.extra.x;
}

fn fogged(c: vec3f, a: f32, w: vec3f) -> vec4f {
  let f = 1.0 - exp(-distance(w, F.eye.xyz) * F.horizon.w);
  let k = 1.0 - f * 0.55;
  return vec4f(c * k, a * k);
}

@fragment fn fsDisc(v: V) -> @location(0) vec4f {
  let z = Z[v.zone];
  let r = z.c.z;
  let next = z.c.w > 0.5;
  let d = v.polar.x;
  // Band at least ~2 px wide whatever the distance.
  let px = fwidth(d);
  let half = max(z.misc.y * 0.5, px * 1.2);
  let e = abs(d - r);
  let band = 1.0 - smoothstep(half * 0.6, half + px, e);
  let halo = exp(-max(d - r, 0.0) / (half * 3.0)) * step(r, d) * 0.35 + exp(-max(r - d, 0.0) / (half * 4.0)) * step(d, r) * 0.25;
  // Dashes: 48 around, turning slowly; the ghost ring is only dashes.
  let dash = fract(v.polar.y / TAU * 48.0 - z.misc.x / TAU * 48.0);
  let dashOn = select(0.55 + 0.45 * step(dash, 0.6), step(dash, 0.5), next);
  var col = zoneColor(z);
  // The capture arc: from north, clockwise, in its side's colour; the rest neutral until it is full.
  if (!next && z.col.w > 0.0) {
    col = select(NEUTRAL, z.cap.rgb, v.polar.y / TAU < z.col.w);
    col = mix(col, vec3f(1.0, 0.97, 0.92), z.cap.w * 0.6);
  }
  let glow = L.a.x * glowScale() * (1.0 + z.cap.w * 1.5);
  var ringA = band * dashOn;
  var fillA = select(L.a.y * (1.0 + z.cap.w), 0.0, next) * step(d, r);
  var haloA = halo * select(1.0, 0.0, next);
  if (next) {
    ringA = ringA * 0.8;
  }
  let a = clamp(ringA * 0.85 + fillA + haloA * 0.25, 0.0, 1.0);
  let c = col * (ringA * glow + haloA * glow * 0.35) + zoneColor(z) * fillA * 0.6;
  if (a < 0.002) {
    discard;
  }
  return fogged(c, a, v.world);
}

@vertex fn vsWall(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> V {
  let z = Z[ii];
  let cell = vi / 6u;
  let k = quadCorner(vi);
  let seg = cell + k.x;
  let a = f32(seg) / f32(WSEGS) * TAU;
  let h = f32(k.y);
  let p = z.c.xy + vec2f(sin(a), -cos(a)) * z.c.z;
  // From below the water (the waves cut its foot) up to the wall height; ghost spots have none.
  let top = select(L.a.z, 0.0, z.c.w > 0.5);
  let w = vec3f(L.b.z + p.x, mix(-8.0, top, h), L.b.w + p.y);
  var o: V;
  o.pos = F.viewProj * vec4f(w, 1.0);
  o.world = w;
  o.polar = vec2f(h, a);
  o.zone = ii;
  return o;
}

@fragment fn fsWall(v: V) -> @location(0) vec4f {
  let z = Z[v.zone];
  let h = v.polar.x;
  let n = vec3f(sin(v.polar.y), 0.0, -cos(v.polar.y));
  let view = normalize(v.world - F.eye.xyz);
  // Edge-on parts of the curtain read stronger, like a sheet of light.
  let edge = 1.0 - abs(dot(n, view));
  // Seen from above the whole sheet faces the camera and read as a second, raised ring: it fades out as the view
  // steepens, so from the air only the ring on the water shows. It also dies away well before its top edge.
  let level = 1.0 - smoothstep(0.25, 0.6, abs(view.y));
  let fade = pow(1.0 - h, 3.0) * level;
  let streak = 0.75 + 0.25 * sin(v.polar.y * 240.0 + F.eye.w * 0.6283 * 2.0 - h * 6.0);
  let k = L.a.w * glowScale() * (0.25 + edge * edge * 0.9) * fade * streak * (1.0 + z.cap.w * 1.2);
  var col = zoneColor(z);
  if (z.col.w > 0.0 && z.col.w < 1.0) {
    col = mix(col, z.cap.rgb, z.col.w);
  }
  return fogged(col * k, 0.0, v.world);
}
`

/**
 * The zones on the sea (shared/objective.ts), in the alpha slot: a glowing boundary band and a faint tint on the
 * displaced water (the band carries the capture arc and slowly turning dash marks) and a curtain of light standing on
 * the boundary. Upcoming spots are a dashed ghost ring. Nothing stands at the centre: from far away the radar and its
 * markers find the zones (src/flight/radar.ts, objectiveZones()).
 */
export class ZonePass implements ScenePass {
  private device: GPUDevice
  private disc: GPURenderPipeline
  private wall: GPURenderPipeline
  private group: GPUBindGroup
  private seaBuf: GPUBuffer
  private zoneBuf: GPUBuffer
  private lookBuf: GPUBuffer
  private seaU = new Float32Array(SEA_UNIFORM_FLOATS)
  private zoneU = new Float32Array(MAX_ZONES * ZONE_FLOATS)
  private lookU = new Float32Array(8)
  private n = 0
  private sea: Sea | null = null

  constructor(renderer: Renderer) {
    const ctx = renderer.context
    const d = (this.device = ctx.device)
    const module = renderer.module(WGSL, "zones")
    const layout = d.createBindGroupLayout({
      entries: [0, 1, 2].map((binding) => ({ binding, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" as const } })),
    })
    const pl = d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, layout] })
    const premul: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "zero", dstFactor: "one" } }
    const pipe = (vs: string, fs: string, label: string) =>
      d.createRenderPipeline({
        label,
        layout: pl,
        vertex: { module, entryPoint: vs },
        fragment: { module, entryPoint: fs, targets: [{ format: ctx.color, blend: premul }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: ctx.depth, depthWriteEnabled: false, depthCompare: "greater-equal" },
        multisample: { count: ctx.samples },
      })
    this.disc = pipe("vsDisc", "fsDisc", "zone-disc")
    this.wall = pipe("vsWall", "fsWall", "zone-wall")
    const usage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    this.seaBuf = d.createBuffer({ label: "zone-sea", size: SEA_UNIFORM_FLOATS * 4, usage })
    this.zoneBuf = d.createBuffer({ label: "zone-list", size: this.zoneU.byteLength, usage })
    this.lookBuf = d.createBuffer({ label: "zone-look", size: this.lookU.byteLength, usage })
    this.group = d.createBindGroup({ layout, entries: [this.seaBuf, this.zoneBuf, this.lookBuf].map((buffer, binding) => ({ binding, resource: { buffer } })) })
  }

  setSea(sea: Sea | null): void {
    this.sea = sea
  }

  /** This frame's zones (at most 4), at sea time t, seen from `eye`. */
  update(t: number, eye: ArrayLike<number>, zones: readonly ZoneDraw[]): void {
    const sea = this.sea
    this.n = sea ? Math.min(MAX_ZONES, zones.length) : 0
    if (!sea || !this.n) return
    const ox = snapSeaOrigin(eye[0]!)
    const oz = snapSeaOrigin(eye[2]!)
    packSea(sea, t, this.seaU, ox, oz)
    const u = this.zoneU
    u.fill(0)
    for (let i = 0; i < this.n; i++) {
      const z = zones[i]!
      const o = i * ZONE_FLOATS
      u.set([z.x - ox, z.z - oz, z.r, z.next ? 1 : 0, ...z.color, z.progress, ...z.capColor, z.contested ? 0.5 + 0.5 * Math.sin(t * Math.PI * 5) : 0, z.spin, ZONE_LOOK.band, 0, 0], o)
    }
    const L = ZONE_LOOK
    this.lookU.set([L.ring, L.fill, L.wallHeight, L.wall, 0, 0, ox, oz])
    const q = this.device.queue
    q.writeBuffer(this.seaBuf, 0, this.seaU)
    q.writeBuffer(this.zoneBuf, 0, u)
    q.writeBuffer(this.lookBuf, 0, this.lookU)
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.n) return
    pass.setBindGroup(1, this.group)
    pass.setPipeline(this.wall)
    pass.draw(WALL_SEGMENTS * 6, this.n)
    pass.setPipeline(this.disc)
    pass.draw(SEGMENTS * RINGS * 6, this.n)
  }
}
