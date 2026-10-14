import { ATMOSPHERE_WGSL } from "./atmosphere"
import { FRAME, FRAME_BINDING_WGSL } from "./frame"
import type { Renderer, ScenePass } from "./renderer"
import { Particles } from "@arcade/kit/fx/particles"
import { ParticleRenderer } from "@arcade/kit/fx/particle-renderer"
import {
  EXPLOSION_PRESETS,
  explosionFlashLight,
  spawnExplosion,
  type ExplosionPresetId,
} from "@arcade/kit/fx/explosion"

// Weapon effects ("alpha" slot): tracers, muzzle flashes, impacts, missiles with their smoke trails, flares, faceted
// low-poly explosions with debris, damage smoke and fire. Two primitives:
// - Sprites: soft capsules between two points (a point when both ends meet), additive ("glow") or lit, premultiplied
//   ("smoke"). Built from the vertex index, one storage buffer per kind, no vertex buffer.
// - Rocks: instanced flat-shaded meshes (an icosahedron for fireballs, smoke balls, spray and debris; an AIM-9), lit
//   like the jets, opaque (debris, missiles) or translucent (smoke, fireballs).
// Particles live in fixed pools (structure of arrays, recycled oldest first); nothing is allocated per frame.

const SPRITE_FLOATS = 12
const ROCK_FLOATS = 24
const MAX_GLOW = 6144
const MAX_SMOKE = 6144
const MAX_ROCKS = 1024
const SPRITE_POOL = 6144
const ROCK_POOL = 1024
const VERT_FLOATS = 9

const SPRITE_WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
${ATMOSPHERE_WGSL}
struct Sprite { p0: vec4f, p1: vec4f, c: vec4f } // ends (xyz, radius), rgb + alpha
@group(1) @binding(0) var<storage, read> sprites: array<Sprite>;
@group(1) @binding(1) var<uniform> P: vec4f; // x: metres per pixel per metre of distance, y: largest radius (px)

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) uv: vec2f,
  @location(2) @interpolate(flat) c: vec4f,
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let s = sprites[ii];
  let q = vi / 6u;
  let corner = vi % 6u;
  var al = array<f32, 6>(0.0, 1.0, 1.0, 0.0, 1.0, 0.0);
  var sd = array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0);
  let a = al[corner];
  let side = sd[corner];
  let mid = (s.p0.xyz + s.p1.xyz) * 0.5;
  let toEye = normalize(F.eye.xyz - mid);
  var right = cross(F.forward.xyz, vec3f(0.0, 1.0, 0.0));
  if (dot(right, right) < 1e-6) { right = vec3f(1.0, 0.0, 0.0); }
  right = normalize(right);
  let axis = s.p1.xyz - s.p0.xyz;
  var sideDir = cross(axis, toEye);
  let sl = length(sideDir);
  var capDir: vec3f;
  if (sl < 1e-4 * max(length(axis), 1e-3) || length(axis) < 1e-4) {
    sideDir = right;
    capDir = normalize(cross(toEye, right));
  } else {
    sideDir = sideDir / sl;
    capDir = normalize(cross(toEye, sideDir));
    if (dot(capDir, axis) < 0.0) { capDir = -capDir; }
  }
  // q 0: start cap, 1: body, 2: end cap.
  var base: vec3f;
  var w: f32;
  var e: f32;
  if (q == 0u) {
    base = s.p0.xyz - capDir * s.p0.w * (1.0 - a);
    w = s.p0.w;
    e = a - 1.0;
  } else if (q == 1u) {
    base = mix(s.p0.xyz, s.p1.xyz, a);
    w = mix(s.p0.w, s.p1.w, a);
    e = 0.0;
  } else {
    base = s.p1.xyz + capDir * s.p1.w * a;
    w = s.p1.w;
    e = a;
  }
  // Never thinner than ~1.3 px: widen far sprites and fade them by as much, so tracers stay lines, not shimmer.
  let dist = length(F.eye.xyz - base);
  let wmin = P.x * dist * 1.3;
  // Never wider than P.y px either: a flash or a puff right by the camera doesn't fill the screen.
  let we = max(min(w, P.x * dist * P.y), wmin);
  let fade = min(1.0, w / max(we, 1e-6));
  var grow = 1.0;
  if (q == 0u) { grow = we / max(w, 1e-6); }
  if (q == 2u) { grow = we / max(w, 1e-6); }
  // Caps scale with the widened radius too.
  var pos = base + sideDir * side * we;
  if (q == 0u) { pos = s.p0.xyz - capDir * we * (1.0 - a) + sideDir * side * we; }
  if (q == 2u) { pos = s.p1.xyz + capDir * we * a + sideDir * side * we; }
  var o: VOut;
  o.pos = F.viewProj * vec4f(pos, 1.0);
  o.world = pos;
  o.uv = vec2f(side, e);
  o.c = vec4f(s.c.rgb, s.c.a * fade);
  return o;
}

fn fogKeep(p: vec3f) -> f32 {
  return exp(-length(p - F.eye.xyz) * F.horizon.w);
}

@fragment fn fsGlow(o: VOut) -> @location(0) vec4f {
  let r2 = dot(o.uv, o.uv);
  if (r2 >= 1.0) { discard; }
  let k = (1.0 - r2);
  // Glare fades out right at the lens (flares and sparks drift back into the chase camera).
  let near = smoothstep(3.0, 30.0, length(o.world - F.eye.xyz));
  return vec4f(o.c.rgb * o.c.a * k * k * near * fogKeep(o.world) * (1.0 + 0.6 * F.extra.x), 0.0);
}

@fragment fn fsSmoke(o: VOut) -> @location(0) vec4f {
  let r2 = dot(o.uv, o.uv);
  if (r2 >= 1.0) { discard; }
  // Thin out smoke the chase camera flies through.
  let a = o.c.a * smoothstep(1.0, 0.25, r2) * smoothstep(6.0, 34.0, length(o.world - F.eye.xyz));
  // Lit from the sun's side a little, mostly sky light, then fogged like everything else.
  // At night (Frame extra.x) the moon is faint: the trails also take the sky's light, so they stay pale against it.
  let light = F.sunColor.rgb * (F.sunDir.w * 0.55 + F.sunColor.w * 0.8) + ambientSky(vec3f(0.0, 1.0, 0.0)) * F.sunColor.w * 1.2 * F.extra.x;
  let col = applyFog(o.c.rgb * light, o.world);
  return vec4f(col * a, a);
}
`

const ROCK_WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
${ATMOSPHERE_WGSL}
struct Rock { m: mat4x4f, c: vec4f, a: vec4f } // model, tint rgb + emission, alpha
@group(1) @binding(0) var<storage, read> rocks: array<Rock>;

struct VIn { @location(0) pos: vec3f, @location(1) n: vec3f, @location(2) col: vec3f }
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) n: vec3f,
  @location(2) col: vec3f,
  @location(3) @interpolate(flat) c: vec4f,
  @location(4) @interpolate(flat) a: f32,
}

@vertex fn vs(v: VIn, @builtin(instance_index) ii: u32) -> VOut {
  let r = rocks[ii];
  let w = r.m * vec4f(v.pos, 1.0);
  var o: VOut;
  o.pos = F.viewProj * w;
  o.world = w.xyz;
  o.n = (r.m * vec4f(v.n, 0.0)).xyz;
  o.col = v.col * r.c.rgb;
  o.c = r.c;
  o.a = r.a.x;
  return o;
}

fn shade(o: VOut, front: bool) -> vec3f {
  var n = normalize(o.n);
  n = select(-n, n, front);
  let sun = F.sunDir.xyz;
  let ndl = max(dot(n, sun), 0.0);
  let direct = F.sunColor.rgb * F.sunDir.w * ndl;
  let sky = ambientSky(n);
  let bounce = ambientBounce();
  let ambient = mix(bounce, sky, n.y * 0.5 + 0.5) * F.sunColor.w;
  let lit = applyFog(o.col * (direct + ambient), o.world);
  // Emission (fireballs) glows through the fog's transmittance, HDR so the bloom picks it up.
  let d = length(o.world - F.eye.xyz);
  // ...but damped close to the camera, so a burst at arm's length doesn't white out the frame.
  let keep = exp(-d * F.horizon.w) * mix(0.25, 1.0, smoothstep(12.0, 70.0, d));
  // Fireballs burn brighter against the night (Frame extra.x), so an explosion lights up the dark.
  return lit + o.col * o.c.w * keep * (1.0 + 1.5 * F.extra.x);
}

@fragment fn fsOpaque(o: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  return vec4f(shade(o, front), 1.0);
}

@fragment fn fsTrans(o: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  // Smoke balls and fireballs fade where the camera passes through them.
  let a = o.a * smoothstep(8.0, 40.0, length(o.world - F.eye.xyz));
  return vec4f(shade(o, front) * a, a);
}
`

type V3 = [number, number, number]

/** Flat-shaded mesh data: position, normal, colour per vertex. */
function pushTri(out: number[], a: V3, b: V3, c: V3, col: V3): void {
  const ux = b[0] - a[0]
  const uy = b[1] - a[1]
  const uz = b[2] - a[2]
  const vx = c[0] - a[0]
  const vy = c[1] - a[1]
  const vz = c[2] - a[2]
  let nx = uy * vz - uz * vy
  let ny = uz * vx - ux * vz
  let nz = ux * vy - uy * vx
  const l = Math.hypot(nx, ny, nz) || 1
  nx /= l
  ny /= l
  nz /= l
  for (const p of [a, b, c]) out.push(p[0], p[1], p[2], nx, ny, nz, col[0], col[1], col[2])
}

/** Unit icosahedron (radius 1), one subdivision-free low-poly ball. */
function icosahedron(): number[] {
  const t = (1 + Math.sqrt(5)) / 2
  const v: V3[] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map((p) => {
    const l = Math.hypot(p[0]!, p[1]!, p[2]!)
    return [p[0]! / l, p[1]! / l, p[2]! / l] as V3
  })
  const f = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ]
  const out: number[] = []
  for (const [a, b, c] of f) pushTri(out, v[a!]!, v[b!]!, v[c!]!, [1, 1, 1])
  return out
}

/** An AIM-9: body along +Z (nose at +Z), 3 m long, canards forward, fins aft, a dark seeker dome. Model scale x1.4. */
function sidewinder(): number[] {
  const out: number[] = []
  const r = 0.09
  const n = 6
  const z0 = -1.5
  const z1 = 1.25
  const tip = 1.55
  const body: V3 = [0.86, 0.87, 0.88]
  const dome: V3 = [0.25, 0.27, 0.3]
  const band: V3 = [0.55, 0.5, 0.3]
  const ring = (i: number, z: number, rr = r): V3 => [Math.cos((i / n) * Math.PI * 2) * rr, Math.sin((i / n) * Math.PI * 2) * rr, z]
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    pushTri(out, ring(i, z0), ring(j, z0), ring(j, z1), body)
    pushTri(out, ring(i, z0), ring(j, z1), ring(i, z1), body)
    pushTri(out, ring(i, z1), ring(j, z1), [0, 0, tip], dome)
    pushTri(out, ring(j, z0), ring(i, z0), [0, 0, z0], band)
  }
  // Fins: four thin triangles aft and four small canards forward (both faces).
  const fin = (z: number, len: number, span: number, a: number) => {
    const c = Math.cos(a)
    const s = Math.sin(a)
    const p: V3 = [c * r, s * r, z]
    const q: V3 = [c * r, s * r, z + len]
    const o: V3 = [c * (r + span), s * (r + span), z + len * 0.25]
    pushTri(out, p, q, o, body)
    pushTri(out, q, p, o, body)
  }
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2
    fin(z0, 0.5, 0.26, a)
    fin(0.85, 0.28, 0.14, a)
  }
  return out
}

/** A fixed pool of particles in typed arrays, recycled oldest first. */
class SpritePool {
  readonly x0 = new Float32Array(SPRITE_POOL)
  readonly y0 = new Float32Array(SPRITE_POOL)
  readonly z0 = new Float32Array(SPRITE_POOL)
  readonly x1 = new Float32Array(SPRITE_POOL)
  readonly y1 = new Float32Array(SPRITE_POOL)
  readonly z1 = new Float32Array(SPRITE_POOL)
  readonly vx = new Float32Array(SPRITE_POOL)
  readonly vy = new Float32Array(SPRITE_POOL)
  readonly vz = new Float32Array(SPRITE_POOL)
  readonly age = new Float32Array(SPRITE_POOL).fill(1e9)
  readonly life = new Float32Array(SPRITE_POOL).fill(1)
  readonly s0 = new Float32Array(SPRITE_POOL)
  readonly s1 = new Float32Array(SPRITE_POOL)
  readonly r = new Float32Array(SPRITE_POOL)
  readonly g = new Float32Array(SPRITE_POOL)
  readonly b = new Float32Array(SPRITE_POOL)
  readonly a = new Float32Array(SPRITE_POOL)
  readonly drag = new Float32Array(SPRITE_POOL)
  readonly rise = new Float32Array(SPRITE_POOL)
  /** 0 glow (additive), 1 smoke (lit). */
  readonly mode = new Uint8Array(SPRITE_POOL)
  next = 0
}

class RockPool {
  readonly x = new Float32Array(ROCK_POOL)
  readonly y = new Float32Array(ROCK_POOL)
  readonly z = new Float32Array(ROCK_POOL)
  readonly vx = new Float32Array(ROCK_POOL)
  readonly vy = new Float32Array(ROCK_POOL)
  readonly vz = new Float32Array(ROCK_POOL)
  readonly age = new Float32Array(ROCK_POOL).fill(1e9)
  readonly life = new Float32Array(ROCK_POOL).fill(1)
  readonly s0 = new Float32Array(ROCK_POOL)
  readonly s1 = new Float32Array(ROCK_POOL)
  /** Non-uniform shape (shards, spray columns). */
  readonly sx = new Float32Array(ROCK_POOL)
  readonly sy = new Float32Array(ROCK_POOL)
  readonly sz = new Float32Array(ROCK_POOL)
  /** Spin axis (unit) and rate, angle so far. */
  readonly ax = new Float32Array(ROCK_POOL)
  readonly ay = new Float32Array(ROCK_POOL)
  readonly az = new Float32Array(ROCK_POOL)
  readonly spin = new Float32Array(ROCK_POOL)
  readonly ang = new Float32Array(ROCK_POOL)
  readonly r = new Float32Array(ROCK_POOL)
  readonly g = new Float32Array(ROCK_POOL)
  readonly b = new Float32Array(ROCK_POOL)
  /** Emission at birth (fades out over `hot` seconds), alpha at birth. */
  readonly emit = new Float32Array(ROCK_POOL)
  readonly hot = new Float32Array(ROCK_POOL)
  readonly a = new Float32Array(ROCK_POOL)
  readonly grav = new Float32Array(ROCK_POOL)
  readonly drag = new Float32Array(ROCK_POOL)
  /** 0 translucent ball, 1 opaque debris (burning debris trails fire), 2 opaque burning debris. */
  readonly kind = new Uint8Array(ROCK_POOL)
  next = 0
}

const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo)

/** Trail emitters by key: last emission point and when it was last fed (to drop stale ones). */
type Trail = { x: number; y: number; z: number; t: number; seen: number }

/**
 * The weapon effects pass. Per frame: `begin(eye, time, dt, fov, viewportHeight)` (advances the particles), any
 * emitters, then `upload()`. Emitters that describe something present this frame (tracers, missiles, flares, muzzle
 * flashes) are immediate; bursts (impacts, explosions) spawn particles that live on.
 */
export class WeaponFx implements ScenePass {
  private glowPipe: GPURenderPipeline
  private smokePipe: GPURenderPipeline
  private rockOpaque: GPURenderPipeline
  private rockTrans: GPURenderPipeline
  private glowBuf: GPUBuffer
  private smokeBuf: GPUBuffer
  private paramBuf: GPUBuffer
  private glowGroup: GPUBindGroup
  private smokeGroup: GPUBindGroup
  private glow = new Float32Array(MAX_GLOW * SPRITE_FLOATS)
  private smoke = new Float32Array(MAX_SMOKE * SPRITE_FLOATS)
  private glows = 0
  private smokes = 0
  private meshBuf: GPUBuffer
  private icoVerts: number
  private aimVerts: number
  private rockBuf: GPUBuffer
  private rockGroup: GPUBindGroup
  /** Rock instances: [opaque balls | opaque missiles | translucent balls], each list from its own base. */
  private rockData = new Float32Array(MAX_ROCKS * 3 * ROCK_FLOATS)
  private counts = [0, 0, 0]
  private params = new Float32Array(4)
  private sp = new SpritePool()
  private rk = new RockPool()
  readonly fxParticles = new Particles()
  private readonly fxRenderer: ParticleRenderer
  private readonly activeFlashes: { x: number; y: number; z: number; age: number; preset: ExplosionPresetId }[] = []
  private trails = new Map<number, Trail>()
  private eye: V3 = [0, 0, 0]
  private time = 0
  private dt = 0
  /** Overall brightness of the additive effects (live-tunable). */
  glowGain = 1
  /** Tracers passing closer than this to the eye are not drawn (m; live-tunable, 0 draws them all), and within
   *  `tracerTaper` m they shorten, so one streaking past the lens never spans the screen. */
  tracerClear = 25
  tracerTaper = 150

  constructor(private renderer: Renderer) {
    const ctx = renderer.context
    const d = ctx.device
    const storage = (label: string, size: number) => d.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.glowBuf = storage("weapon-glow", this.glow.byteLength)
    this.smokeBuf = storage("weapon-smoke", this.smoke.byteLength)
    this.paramBuf = d.createBuffer({ label: "weapon-params", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const spriteLayout = d.createBindGroupLayout({
      label: "weapon-sprites",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      ],
    })
    this.glowGroup = d.createBindGroup({ layout: spriteLayout, entries: [{ binding: 0, resource: { buffer: this.glowBuf } }, { binding: 1, resource: { buffer: this.paramBuf } }] })
    this.smokeGroup = d.createBindGroup({ layout: spriteLayout, entries: [{ binding: 0, resource: { buffer: this.smokeBuf } }, { binding: 1, resource: { buffer: this.paramBuf } }] })
    const sm = renderer.module(SPRITE_WGSL, "weapon-sprite")
    const add: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" } }
    const premul: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" } }
    const spriteLayoutP = d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, spriteLayout] })
    const sprite = (entry: string, blend: GPUBlendState, label: string) =>
      d.createRenderPipeline({
        label,
        layout: spriteLayoutP,
        vertex: { module: sm, entryPoint: "vs" },
        fragment: { module: sm, entryPoint: entry, targets: [{ format: ctx.color, blend }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: ctx.depth, depthWriteEnabled: false, depthCompare: "greater-equal" },
        multisample: { count: ctx.samples },
      })
    this.glowPipe = sprite("fsGlow", add, "weapon-glow")
    this.smokePipe = sprite("fsSmoke", premul, "weapon-smoke")

    const ico = icosahedron()
    const aim = sidewinder()
    this.icoVerts = ico.length / VERT_FLOATS
    this.aimVerts = aim.length / VERT_FLOATS
    const mesh = new Float32Array([...ico, ...aim])
    this.meshBuf = d.createBuffer({ label: "weapon-meshes", size: mesh.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(this.meshBuf, 0, mesh)
    this.rockBuf = storage("weapon-rocks", this.rockData.byteLength)
    const rockLayout = d.createBindGroupLayout({ label: "weapon-rocks", entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }] })
    this.rockGroup = d.createBindGroup({ layout: rockLayout, entries: [{ binding: 0, resource: { buffer: this.rockBuf } }] })
    const rm = renderer.module(ROCK_WGSL, "weapon-rock")
    const rockLayoutP = d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, rockLayout] })
    const vertex: GPUVertexState = {
      module: rm,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: VERT_FLOATS * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x3" },
          ],
        },
      ],
    }
    this.rockOpaque = d.createRenderPipeline({
      label: "weapon-rock-opaque",
      layout: rockLayoutP,
      vertex,
      fragment: { module: rm, entryPoint: "fsOpaque", targets: [{ format: ctx.color }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: true, depthCompare: "greater-equal" },
      multisample: { count: ctx.samples },
    })
    this.rockTrans = d.createRenderPipeline({
      label: "weapon-rock-trans",
      layout: rockLayoutP,
      vertex,
      fragment: { module: rm, entryPoint: "fsTrans", targets: [{ format: ctx.color, blend: premul }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: false, depthCompare: "greater-equal" },
      multisample: { count: ctx.samples },
    })
    this.fxRenderer = new ParticleRenderer(d, {
      depthFormat: ctx.depth,
      samples: ctx.samples,
      depthCompare: "greater-equal",
      bindGroupIndex: 1,
      extraBindGroupLayouts: [ctx.frameLayout],
    })
  }

  /** Start of a frame: advances every particle by dt and lays the survivors into this frame's instance lists. */
  begin(eye: ArrayLike<number>, time: number, dt: number, fov: number, viewportH: number): void {
    this.eye[0] = eye[0]!
    this.eye[1] = eye[1]!
    this.eye[2] = eye[2]!
    this.time = time
    this.dt = dt
    this.params[0] = (2 * Math.tan(fov / 2)) / Math.max(1, viewportH)
    this.params[1] = Math.max(40, viewportH * 0.12)
    this.glows = 0
    this.smokes = 0
    this.counts[0] = this.counts[1] = this.counts[2] = 0
    this.stepSprites(dt)
    this.stepRocks(dt)
    this.fxParticles.update(dt, [], () => -1e9)
    for (let i = this.activeFlashes.length - 1; i >= 0; i--) {
      const fl = this.activeFlashes[i]!
      fl.age += dt
      if (fl.age >= 1.5) this.activeFlashes.splice(i, 1)
    }
    for (const [k, tr] of this.trails) if (time - tr.seen > 1 || tr.seen > time + 1) this.trails.delete(k)
  }

  // ---- immediate primitives ------------------------------------------------------------------------------------------

  /** An additive capsule from (x0..) to (x1..), radii w0/w1, colour (linear HDR) times alpha. */
  beam(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, w0: number, w1: number, r: number, g: number, b: number, a: number): void {
    if (this.glows >= MAX_GLOW) return
    const o = this.glows++ * SPRITE_FLOATS
    const d = this.glow
    d[o] = x0
    d[o + 1] = y0
    d[o + 2] = z0
    d[o + 3] = w0
    d[o + 4] = x1
    d[o + 5] = y1
    d[o + 6] = z1
    d[o + 7] = w1
    d[o + 8] = r
    d[o + 9] = g
    d[o + 10] = b
    d[o + 11] = a * this.glowGain
  }

  /** An additive round glow. */
  glowAt(x: number, y: number, z: number, radius: number, r: number, g: number, b: number, a: number): void {
    this.beam(x, y, z, x, y, z, radius, radius, r, g, b, a)
  }

  private smokeSprite(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, w0: number, w1: number, r: number, g: number, b: number, a: number): void {
    if (this.smokes >= MAX_SMOKE) return
    const o = this.smokes++ * SPRITE_FLOATS
    const d = this.smoke
    d[o] = x0
    d[o + 1] = y0
    d[o + 2] = z0
    d[o + 3] = w0
    d[o + 4] = x1
    d[o + 5] = y1
    d[o + 6] = z1
    d[o + 7] = w1
    d[o + 8] = r
    d[o + 9] = g
    d[o + 10] = b
    d[o + 11] = a
  }

  /**
   * A rock instance: list 0 opaque ball, 1 opaque missile, 2 translucent ball. Placed at (x, y, z), its local +Z along
   * the unit direction (dx, dy, dz) (any up), scaled (sx, sy, sz), rolled `roll` about its axis.
   */
  rock(list: 0 | 1 | 2, x: number, y: number, z: number, dx: number, dy: number, dz: number, sx: number, sy: number, sz: number, roll: number, r: number, g: number, b: number, emit: number, alpha: number): void {
    const n = this.counts[list]!
    if (n >= MAX_ROCKS) return
    this.counts[list] = n + 1
    const o = (list * MAX_ROCKS + n) * ROCK_FLOATS
    const m = this.rockData
    // Basis: Z = forward, X = up × Z (or a fallback), Y = Z × X, then rolled.
    let xx = dz
    let xy = 0
    let xz = -dx
    let xl = Math.hypot(xx, xz)
    if (xl < 1e-5) {
      xx = 1
      xz = 0
      xl = 1
    }
    xx /= xl
    xz /= xl
    let yx = dy * xz - dz * xy
    let yy = dz * xx - dx * xz
    let yz = dx * xy - dy * xx
    if (roll) {
      const c = Math.cos(roll)
      const s = Math.sin(roll)
      const ax = xx * c + yx * s
      const ay = xy * c + yy * s
      const az = xz * c + yz * s
      yx = yx * c - xx * s
      yy = yy * c - xy * s
      yz = yz * c - xz * s
      xx = ax
      xy = ay
      xz = az
    }
    m[o] = xx * sx
    m[o + 1] = xy * sx
    m[o + 2] = xz * sx
    m[o + 3] = 0
    m[o + 4] = yx * sy
    m[o + 5] = yy * sy
    m[o + 6] = yz * sy
    m[o + 7] = 0
    m[o + 8] = dx * sz
    m[o + 9] = dy * sz
    m[o + 10] = dz * sz
    m[o + 11] = 0
    m[o + 12] = x
    m[o + 13] = y
    m[o + 14] = z
    m[o + 15] = 1
    m[o + 16] = r
    m[o + 17] = g
    m[o + 18] = b
    m[o + 19] = emit
    m[o + 20] = alpha
    m[o + 21] = m[o + 22] = m[o + 23] = 0
  }

  /** A missile mesh from a model matrix (column-major, model → world) and a model-space position (a rail). */
  railMissile(mm: Float32Array, px: number, py: number, pz: number): void {
    const n = this.counts[1]!
    if (n >= MAX_ROCKS) return
    this.counts[1] = n + 1
    const o = (MAX_ROCKS + n) * ROCK_FLOATS
    const m = this.rockData
    for (let i = 0; i < 12; i++) m[o + i] = mm[i]!
    m[o + 12] = mm[0]! * px + mm[4]! * py + mm[8]! * pz + mm[12]!
    m[o + 13] = mm[1]! * px + mm[5]! * py + mm[9]! * pz + mm[13]!
    m[o + 14] = mm[2]! * px + mm[6]! * py + mm[10]! * pz + mm[14]!
    m[o + 15] = 1
    m[o + 16] = m[o + 17] = m[o + 18] = 1
    m[o + 19] = 0
    m[o + 20] = 1
  }

  // ---- particles -----------------------------------------------------------------------------------------------------

  /**
   * Spawns a sprite particle: a point (or a segment from the tail x0.. to the head x1.., for trails) drifting at v,
   * slowed by `drag` (1/s), rising at `rise` (m/s², negative falls), growing from s0 to s1 over `life` while its alpha
   * falls from `a` to 0. mode 0 glows (additive), 1 is smoke.
   */
  spawn(mode: 0 | 1, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, r: number, g: number, b: number, a: number, drag = 0, rise = 0): void {
    const p = this.sp
    const i = p.next
    p.next = (i + 1) % SPRITE_POOL
    p.x0[i] = x0
    p.y0[i] = y0
    p.z0[i] = z0
    p.x1[i] = x1
    p.y1[i] = y1
    p.z1[i] = z1
    p.vx[i] = vx
    p.vy[i] = vy
    p.vz[i] = vz
    p.age[i] = 0
    p.life[i] = life
    p.s0[i] = s0
    p.s1[i] = s1
    p.r[i] = r
    p.g[i] = g
    p.b[i] = b
    p.a[i] = a
    p.drag[i] = drag
    p.rise[i] = rise
    p.mode[i] = mode
  }

  private puff(mode: 0 | 1, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, r: number, g: number, b: number, a: number, drag = 0, rise = 0): void {
    this.spawn(mode, x, y, z, x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, drag, rise)
  }

  /**
   * A faceted white spray chunk (the translucent ball the round strikes on the sea use) thrown from (x, y, z) at v,
   * falling at 1 g with a little drag, growing from s0 to s1 over `life` s, `stretch` taller than wide (boat spray).
   */
  spray(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, stretch = 1.3, alpha = 0.85): void {
    this.spawnRock(0, x, y, z, vx, vy, vz, life, s0, s1, 0.93, 0.96, 0.99, 0, 0, alpha, 9.81, 0.6, [1, stretch, 1])
  }

  /** Spawns a faceted particle (see RockPool). */
  private spawnRock(kind: 0 | 1 | 2, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, r: number, g: number, b: number, emit: number, hot: number, a: number, grav: number, drag: number, shape: V3 = [1, 1, 1], spin = rnd(-2, 2)): void {
    const p = this.rk
    const i = p.next
    p.next = (i + 1) % ROCK_POOL
    p.x[i] = x
    p.y[i] = y
    p.z[i] = z
    p.vx[i] = vx
    p.vy[i] = vy
    p.vz[i] = vz
    p.age[i] = 0
    p.life[i] = life
    p.s0[i] = s0
    p.s1[i] = s1
    p.sx[i] = shape[0]
    p.sy[i] = shape[1]
    p.sz[i] = shape[2]
    let ax = rnd(-1, 1)
    let ay = rnd(-1, 1)
    let az = rnd(-1, 1)
    const l = Math.hypot(ax, ay, az) || 1
    ax /= l
    ay /= l
    az /= l
    p.ax[i] = ax
    p.ay[i] = ay
    p.az[i] = az
    p.spin[i] = spin
    p.ang[i] = rnd(0, 6.28)
    p.r[i] = r
    p.g[i] = g
    p.b[i] = b
    p.emit[i] = emit
    p.hot[i] = hot
    p.a[i] = a
    p.grav[i] = grav
    p.drag[i] = drag
    p.kind[i] = kind
  }

  private stepSprites(dt: number): void {
    const p = this.sp
    for (let i = 0; i < SPRITE_POOL; i++) {
      const age = p.age[i]!
      if (age >= p.life[i]!) continue
      const na = age + dt
      p.age[i] = na
      if (na >= p.life[i]!) continue
      const k = Math.exp(-p.drag[i]! * dt)
      p.vx[i] = p.vx[i]! * k
      p.vy[i] = p.vy[i]! * k + p.rise[i]! * dt
      p.vz[i] = p.vz[i]! * k
      const mx = p.vx[i]! * dt
      const my = p.vy[i]! * dt
      const mz = p.vz[i]! * dt
      p.x0[i] = p.x0[i]! + mx
      p.y0[i] = p.y0[i]! + my
      p.z0[i] = p.z0[i]! + mz
      p.x1[i] = p.x1[i]! + mx
      p.y1[i] = p.y1[i]! + my
      p.z1[i] = p.z1[i]! + mz
      const u = na / p.life[i]!
      const s = p.s0[i]! + (p.s1[i]! - p.s0[i]!) * Math.sqrt(u)
      const fade = (1 - u) * (1 - u)
      if (p.mode[i] === 0) this.beam(p.x0[i]!, p.y0[i]!, p.z0[i]!, p.x1[i]!, p.y1[i]!, p.z1[i]!, s, s, p.r[i]!, p.g[i]!, p.b[i]!, p.a[i]! * fade / this.glowGain)
      else this.smokeSprite(p.x0[i]!, p.y0[i]!, p.z0[i]!, p.x1[i]!, p.y1[i]!, p.z1[i]!, s, s, p.r[i]!, p.g[i]!, p.b[i]!, p.a[i]! * (1 - u) * Math.min(1, na * 12))
    }
  }

  private stepRocks(dt: number): void {
    const p = this.rk
    for (let i = 0; i < ROCK_POOL; i++) {
      const age = p.age[i]!
      if (age >= p.life[i]!) continue
      const na = age + dt
      p.age[i] = na
      if (na >= p.life[i]!) continue
      const k = Math.exp(-p.drag[i]! * dt)
      p.vx[i] = p.vx[i]! * k
      p.vy[i] = p.vy[i]! * k - p.grav[i]! * dt
      p.vz[i] = p.vz[i]! * k
      p.x[i] = p.x[i]! + p.vx[i]! * dt
      p.y[i] = p.y[i]! + p.vy[i]! * dt
      p.z[i] = p.z[i]! + p.vz[i]! * dt
      p.ang[i] = p.ang[i]! + p.spin[i]! * dt
      const u = na / p.life[i]!
      const s = p.s0[i]! + (p.s1[i]! - p.s0[i]!) * (1 - (1 - u) * (1 - u))
      const heat = p.hot[i]! > 0 ? Math.max(0, 1 - na / p.hot[i]!) : 0
      const emit = p.emit[i]! * heat * heat
      const kind = p.kind[i]!
      // Hot balls cool from white-yellow to orange to a smoky dark; their albedo goes from the tint to soot.
      const soot = kind === 0 && p.emit[i]! > 0 ? 1 - heat : 0
      const r = p.r[i]! * (1 - soot) + 0.09 * soot
      const g = p.g[i]! * (1 - soot) + 0.085 * soot
      const b = p.b[i]! * (1 - soot) + 0.08 * soot
      // Spin: rotate the axis frame about the spin axis by `ang` (a cheap tumble: forward dir = rotated axis).
      const c = Math.cos(p.ang[i]!)
      const sn = Math.sin(p.ang[i]!)
      const dx = p.ax[i]! * c + p.ay[i]! * sn
      const dy = p.ay[i]! * c - p.ax[i]! * sn
      const dz = p.az[i]!
      const dl = Math.hypot(dx, dy, dz) || 1
      if (kind === 0) {
        const a = p.a[i]! * (u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3)
        this.rock(2, p.x[i]!, p.y[i]!, p.z[i]!, dx / dl, dy / dl, dz / dl, s * p.sx[i]!, s * p.sy[i]!, s * p.sz[i]!, p.ang[i]!, r, g, b, emit, a)
      } else {
        const sc = u < 0.85 ? s : s * (1 - (u - 0.85) / 0.15)
        this.rock(0, p.x[i]!, p.y[i]!, p.z[i]!, dx / dl, dy / dl, dz / dl, sc * p.sx[i]!, sc * p.sy[i]!, sc * p.sz[i]!, p.ang[i]!, r, g, b, emit, 1)
        // Burning debris trails fire and smoke.
        if (kind === 2 && u < 0.8) {
          const x = p.x[i]!
          const y = p.y[i]!
          const z = p.z[i]!
          this.glowAt(x, y, z, 1.6 * (1 - u), 4, 1.6, 0.4, 1)
          if (Math.random() < dt * 30) this.puff(1, x, y, z, p.vx[i]! * 0.2, 2, p.vz[i]! * 0.2, rnd(1.5, 2.5), 1, rnd(4, 6), 0.12, 0.11, 0.1, 0.55, 0.6, 1.5)
        }
      }
    }
  }

  // ---- effects -------------------------------------------------------------------------------------------------------

  /** Muzzle flash at the gun port, firing along f (unit): a hot star and a short forward flame, flickering. */
  muzzle(x: number, y: number, z: number, fx: number, fy: number, fz: number): void {
    const k = 0.6 + 0.4 * Math.random()
    this.glowAt(x, y, z, 1.1 * k, 9, 6, 2.5, 1)
    this.beam(x, y, z, x + fx * 3.2 * k, y + fy * 3.2 * k, z + fz * 3.2 * k, 0.45, 0.12, 8, 4.5, 1.6, 1)
    if (Math.random() < 0.25) this.puff(1, x, y, z, fx * 30, fy * 30, fz * 30, 0.5, 0.4, 2.2, 0.55, 0.55, 0.55, 0.25, 4)
  }

  /** A tracer streak: the round's head at (x, y, z), flying at v; its tail trails `len` seconds behind. */
  tracer(x: number, y: number, z: number, vx: number, vy: number, vz: number, len = 0.032): void {
    // A tracer streaking past the lens (rounds fired at the camera's own jet, or past the crash camera) would draw as
    // a long screen-crossing bar: skip it right by the eye, and shorten it as it nears.
    if (this.tracerClear > 0) {
      const near = this.nearEye(x - vx * len, y - vy * len, z - vz * len, x, y, z)
      if (near < this.tracerClear) return
      len *= Math.min(1, near / this.tracerTaper)
    }
    this.beam(x - vx * len, y - vy * len, z - vz * len, x, y, z, 0.1, 0.32, 9, 4.2, 1.2, 1)
  }

  /** Closest distance from the eye to the segment a → b. */
  private nearEye(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    const [ex, ey, ez] = this.eye
    const dx = bx - ax
    const dy = by - ay
    const dz = bz - az
    const dd = dx * dx + dy * dy + dz * dz
    let k = dd > 1e-9 ? ((ex - ax) * dx + (ey - ay) * dy + (ez - az) * dz) / dd : 0
    k = k < 0 ? 0 : k > 1 ? 1 : k
    return Math.hypot(ax + dx * k - ex, ay + dy * k - ey, az + dz * k - ez)
  }

  /** Metres covered by one pixel at (x, y, z): caps how big small bright things get near the camera. */
  private pixel(x: number, y: number, z: number): number {
    return Math.hypot(x - this.eye[0], y - this.eye[1], z - this.eye[2]) * this.params[0]!
  }

  /** Where a round struck: a white spout on the sea, dust on land, sparks off a carrier or a jet. */
  impact(kind: "sea" | "land" | "ship" | "jet", x: number, y: number, z: number): void {
    if (kind === "sea") {
      const n = 3
      for (let i = 0; i < n; i++) this.spawnRock(0, x + rnd(-0.6, 0.6), y, z + rnd(-0.6, 0.6), rnd(-2, 2), rnd(9, 16), rnd(-2, 2), rnd(0.9, 1.3), rnd(0.5, 0.8), rnd(1.1, 1.7), 0.92, 0.95, 0.97, 0, 0, 0.85, 9.81, 0.4, [1, rnd(1.6, 2.4), 1])
      this.puff(1, x, y + 0.5, z, 0, 2, 0, 1.2, 1, 4, 0.9, 0.93, 0.95, 0.4, 0.8)
      return
    }
    if (kind === "land") {
      for (let i = 0; i < 2; i++) this.puff(1, x, y + 0.5, z, rnd(-3, 3), rnd(2, 5), rnd(-3, 3), rnd(1, 1.8), 0.8, rnd(3, 5), 0.42, 0.36, 0.28, 0.6, 1.5, 0.3)
    } else if (kind === "jet") {
      this.puff(1, x, y, z, 0, 0, 0, 0.8, 0.6, 2.4, 0.15, 0.14, 0.13, 0.55, 0.5)
    }
    this.glowAt(x, y, z, kind === "jet" ? 1.8 : 1.1, 10, 7, 3, 1)
    this.puff(0, x, y, z, 0, 0, 0, 0.09, 1.2, 2.6, 8, 5, 2, 1)
    for (let i = 0; i < (kind === "jet" ? 6 : 4); i++) {
      const vx = rnd(-30, 30)
      const vy = rnd(-10, 35)
      const vz = rnd(-30, 30)
      this.spawn(0, x, y, z, x + vx * 0.02, y + vy * 0.02, z + vz * 0.02, vx, vy, vz, rnd(0.25, 0.5), 0.09, 0.05, 9, 5, 1.8, 1, 1.5, -9.81)
    }
  }

  /**
   * A missile in flight (key = a unique id): the AIM-9 along its velocity, the motor's glare while it burns, and a
   * white smoke trail laid as connected segments.
   */
  missile(key: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, burning: boolean): void {
    const s = Math.hypot(vx, vy, vz) || 1
    const dx = vx / s
    const dy = vy / s
    const dz = vz / s
    this.rock(1, x, y, z, dx, dy, dz, 1.4, 1.4, 1.4, 0, 1, 1, 1, 0, 1)
    const tx = x - dx * 2.3
    const ty = y - dy * 2.3
    const tz = z - dz * 2.3
    if (burning) {
      const f = 0.75 + 0.25 * Math.random()
      this.glowAt(tx, ty, tz, 1.8 * f, 12, 8, 4, 1)
      this.beam(tx, ty, tz, tx - dx * 5 * f, ty - dy * 5 * f, tz - dz * 5 * f, 0.5, 0.15, 10, 5, 1.5, 1)
    }
    this.trail(key, tx, ty, tz, burning ? 7 : 22, burning ? 0.95 : 0.55, burning ? 0.92 : 0.6, burning ? 0.62 : 0.3, burning ? 4.2 : 2.5, 1.1, burning ? 7 : 4)
  }

  /** A flare (key = unique id) burning at (x, y, z), `age` seconds old: a white-magnesium star and a smoke trail. */
  flare(key: number, x: number, y: number, z: number, age: number, life: number): void {
    const u = age / life
    const f = (0.75 + 0.25 * Math.random()) * (u < 0.85 ? 1 : 1 - (u - 0.85) / 0.15)
    // A small, intense point: a hot white-yellow core and a tight halo, both capped in pixels so a flare drifting back
    // past the chase camera stays a spark, and their small area keeps the bloom in check.
    const px = this.pixel(x, y, z)
    this.glowAt(x, y, z, Math.min(0.45, px * 4) * f, 16, 13, 8, 1)
    this.glowAt(x, y, z, Math.min(1.6, px * 11) * f, 1.4, 0.9, 0.4, 0.35)
    // A thin smoke trail that widens as the flare arcs down and spreads.
    this.trail(key, x, y, z, 2, 0.9, 0.88, 0.22, 2.2, 0.14, 1.1)
  }

  /**
   * Lays a smoke trail for emitter `key` through (x, y, z): a segment from the last emission point whenever the
   * emitter has moved `step` metres. Colour grey level `c`, alpha `a`, lifetime `life` s, from width w0 to w1.
   */
  trail(key: number, x: number, y: number, z: number, step: number, c: number, cb: number, a: number, life: number, w0: number, w1: number): void {
    let tr = this.trails.get(key)
    if (!tr) {
      tr = { x, y, z, t: this.time, seen: this.time }
      this.trails.set(key, tr)
      return
    }
    tr.seen = this.time
    const d = Math.hypot(x - tr.x, y - tr.y, z - tr.z)
    if (d > 600) {
      tr.x = x
      tr.y = y
      tr.z = z
      return
    }
    if (d < step) return
    this.spawn(1, tr.x, tr.y, tr.z, x, y, z, rnd(-0.6, 0.6), rnd(0.2, 1.2), rnd(-0.6, 0.6), life * rnd(0.85, 1.15), w0, w1, c, c, cb, a, 0.3, 0.2)
    tr.x = x
    tr.y = y
    tr.z = z
  }

  /** A damaged jet (key = its id) at (x, y, z) moving at v: grey smoke when `state` is 1, fire and black smoke at 2. */
  damage(key: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, state: number): void {
    if (state <= 0) return
    if (state >= 2) {
      const f = 0.7 + 0.3 * Math.random()
      this.glowAt(x, y, z, 2.6 * f, 7, 2.6, 0.6, 1)
      if (Math.random() < this.dt * 40) this.puff(0, x, y, z, vx * 0.6, vy * 0.6, vz * 0.6, 0.35, 2.2, 1.2, 6, 2.2, 0.5, 0.9, 3)
    }
    const dark = state >= 2 ? 0.08 : 0.42
    this.trail(key + 0x100000, x, y, z, 5, dark, dark, state >= 2 ? 0.75 : 0.5, state >= 2 ? 4 : 3, 1.2, state >= 2 ? 7 : 5)
  }

  /**
   * A fire burning on a ship at (x, y, z) moving with it at (vx, vz): flickering flames `flame` m tall (0: none) and a
   * column of smoke rising and drifting downwind, black at `dark` 1, grey at 0, `smoke` puffs per second.
   */
  fire(x: number, y: number, z: number, vx: number, vz: number, flame: number, smoke: number, dark = 1): void {
    if (flame > 0) {
      const f = 0.7 + 0.3 * Math.random()
      this.glowAt(x, y + flame * 0.35, z, flame * 0.55 * f, 6, 2.4, 0.5, 0.9)
      this.glowAt(x, y + flame * 0.15, z, flame * 0.3 * f, 9, 5, 1.6, 1)
      if (Math.random() < this.dt * 14) this.puff(0, x + rnd(-1, 1) * flame * 0.3, y, z + rnd(-1, 1) * flame * 0.3, vx, rnd(4, 8), vz, rnd(0.4, 0.8), flame * 0.35, flame * 0.12, 6, 2.2, 0.5, 0.9, 1, 2)
    }
    if (Math.random() < this.dt * smoke) {
      const g = 0.06 + 0.34 * (1 - dark)
      this.puff(1, x + rnd(-2, 2), y + flame * 0.6, z + rnd(-2, 2), vx * 0.9 + rnd(-1, 1), rnd(7, 11), vz * 0.9 + rnd(-1, 1), rnd(7, 10), 3 + flame * 0.3, rnd(18, 28), g, g, g * 0.95, 0.7, 0.12, 0.6)
    }
  }

  /**
   * An explosion at (x, y, z) carried along at v: unified blackbody fireball billows that crust into dark soot,
   * shockwave ring, ballistic sparks and 3D lit shrapnel; over water a white spray column too.
   * `size` 1 = a missile hitting a jet (a jet's own end or ship strike uses a larger scale).
   */
  explosion(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    size = 1,
    water = false,
    preset?: ExplosionPresetId,
  ): void {
    const s = size
    const distToEye = Math.hypot(x - this.eye[0], y - this.eye[1], z - this.eye[2])
    const near = Math.min(1, Math.max(0, (distToEye - 15) / 90))
    const hot = 0.3 + 0.7 * near
    const chosen: ExplosionPresetId =
      preset ?? (water ? "barrel" : s >= 1.2 && y < 45 ? "ship" : s <= 0.6 ? "pop" : "missile")
    const baseSettings = EXPLOSION_PRESETS[chosen].settings
    const settings = { ...baseSettings, fireballTemp: baseSettings.fireballTemp * (chosen === "ship" ? 0.72 : 0.88) }
    const airburst = !water && (chosen === "missile" || y > 32)
    const worldScale = s * (chosen === "ship" ? 2.8 : 4.2)
    spawnExplosion(this.fxParticles, null, x, y, z, settings, Math.random, worldScale, 1, {
      vx: vx * 0.45,
      vy: vy * 0.45,
      vz: vz * 0.45,
      airburst,
      distanceToEye: distToEye,
      referenceDist: 160,
    })
    if (this.activeFlashes.length >= 8) this.activeFlashes.shift()
    this.activeFlashes.push({ x, y, z, age: 0, preset: chosen })
    for (let i = 0; i < 6; i++) {
      const ox = rnd(-1, 1) * 4.5 * s
      const oy = rnd(-0.4, 1) * 4.5 * s
      const oz = rnd(-1, 1) * 4.5 * s
      this.puff(
        1,
        x + ox,
        y + oy,
        z + oz,
        vx * 0.2 + ox * 0.8,
        vy * 0.2 + oy * 0.8 + 2.2,
        vz * 0.2 + oz * 0.8,
        rnd(3.5, 5.5),
        rnd(3.2, 5.2) * s,
        rnd(11, 16) * s,
        0.16,
        0.15,
        0.145,
        0.65,
        0.85,
        0.8,
      )
    }
    if (water) this.splash(x, y, z, 1.4 * s)
  }

  /** A big white column of spray (a missile or a jet into the sea). */
  splash(x: number, y: number, z: number, size = 1): void {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2
      const r = rnd(1, 4) * size
      this.spawnRock(0, x + Math.cos(a) * r, y, z + Math.sin(a) * r, Math.cos(a) * rnd(2, 6), rnd(18, 34) * size, Math.sin(a) * rnd(2, 6), rnd(2.2, 3.2), rnd(2, 3) * size, rnd(3, 4.5) * size, 0.93, 0.96, 0.98, 0, 0, 0.9, 9.81, 0.5, [1, rnd(1.5, 2.6), 1])
    }
    this.puff(1, x, y + 3, z, 0, 3, 0, 4, 6 * size, 20 * size, 0.92, 0.95, 0.97, 0.45, 0.5)
  }

  /**
   * A bomb bursting on the surface. On the sea: a short orange flash, a tall white spout (a column 50-70 m high that
   * falls back), a crown of spray thrown outward, a base surge of mist rolling out over the water and a hanging cloud.
   * On land or a deck: unified `ship` explosion preset, a brown dust column and a ground-hugging ring.
   */
  bombBlast(x: number, y: number, z: number, water: boolean): void {
    const near = Math.min(1, Math.max(0, (Math.hypot(x - this.eye[0], y - this.eye[1], z - this.eye[2]) - 15) / 90))
    const hot = 0.3 + 0.7 * near
    if (water) {
      this.puff(0, x, y + 2, z, 0, 0, 0, 0.2, 8, 20, 5 * hot, 3 * hot, 1.4 * hot, 1, 2)
      // The spout: a fast, narrow jet over a slower, fatter stem.
      for (let i = 0; i < 18; i++) {
        const a = rnd(0, Math.PI * 2)
        const r = rnd(0, 4)
        this.spawnRock(0, x + Math.cos(a) * r, y, z + Math.sin(a) * r, Math.cos(a) * rnd(1, 4), rnd(45, 70), Math.sin(a) * rnd(1, 4), rnd(3.2, 4.4), rnd(2.5, 4), rnd(5, 8), 0.95, 0.97, 0.99, 0, 0, 0.95, 9.81, 0.32, [1, rnd(2.2, 3.6), 1])
      }
      for (let i = 0; i < 12; i++) {
        const a = rnd(0, Math.PI * 2)
        const r = rnd(1, 6)
        this.spawnRock(0, x + Math.cos(a) * r, y, z + Math.sin(a) * r, Math.cos(a) * rnd(2, 6), rnd(18, 34), Math.sin(a) * rnd(2, 6), rnd(2.8, 3.8), rnd(4, 6), rnd(7, 10), 0.93, 0.96, 0.98, 0, 0, 0.95, 9.81, 0.4, [1, rnd(1.6, 2.4), 1])
      }
      // The crown, thrown outward and falling back in a ring.
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2 + rnd(-0.15, 0.15)
        const r = rnd(5, 9)
        this.spawnRock(0, x + Math.cos(a) * r, y, z + Math.sin(a) * r, Math.cos(a) * rnd(14, 24), rnd(16, 28), Math.sin(a) * rnd(14, 24), rnd(2.4, 3.4), rnd(1.6, 2.6), rnd(3.5, 5), 0.92, 0.95, 0.98, 0, 0, 0.9, 9.81, 0.45, [1, rnd(1.4, 2.2), 1])
      }
      // A low ring of mist rolling out over the water, and a thin hanging cloud.
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2
        this.puff(1, x + Math.cos(a) * 8, y + 1.5, z + Math.sin(a) * 8, Math.cos(a) * rnd(14, 20), 0.6, Math.sin(a) * rnd(14, 20), rnd(4, 6), 4, 14, 0.93, 0.96, 0.98, 0.42, 0.6, 0.2)
      }
      this.puff(1, x, y + 30, z, 0, 3, 0, 7, 12, 36, 0.94, 0.96, 0.98, 0.22, 0.4)
      return
    }
    this.explosion(x, y + 2, z, 0, 0, 0, 1.6, false, "ship")
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      this.puff(1, x + Math.cos(a) * 5, y + 1.5, z + Math.sin(a) * 5, Math.cos(a) * rnd(12, 18), 0.4, Math.sin(a) * rnd(12, 18), rnd(4, 6), 6, 22, 0.42, 0.36, 0.28, 0.55, 0.8, 0.2)
    }
  }

  /** A flare burst's pop at release. */
  flarePop(x: number, y: number, z: number): void {
    const r = Math.min(1, this.pixel(x, y, z) * 10)
    this.puff(0, x, y, z, 0, 0, 0, 0.12, r, r * 2, 6, 5, 3, 1)
  }

  upload(): void {
    const q = this.renderer.context.device.queue
    q.writeBuffer(this.paramBuf, 0, this.params)
    if (this.glows) q.writeBuffer(this.glowBuf, 0, this.glow, 0, this.glows * SPRITE_FLOATS)
    if (this.smokes) q.writeBuffer(this.smokeBuf, 0, this.smoke, 0, this.smokes * SPRITE_FLOATS)
    for (let l = 0; l < 3; l++) if (this.counts[l]) q.writeBuffer(this.rockBuf, l * MAX_ROCKS * ROCK_FLOATS * 4, this.rockData, l * MAX_ROCKS * ROCK_FLOATS, this.counts[l]! * ROCK_FLOATS)
    if (this.fxParticles.count > 0) {
      const f = this.renderer.currentFrame
      const u = this.fxRenderer.uniforms
      u.set(f.subarray(0, 16), 0)
      u[16] = this.eye[0]
      u[17] = this.eye[1]
      u[18] = this.eye[2]
      u[19] = 0
      const sunW = f[FRAME.sunDir + 3]!
      const ambW = f[FRAME.sunColor + 3]!
      const scale = Math.max(0.28, sunW * 0.48 + ambW * 0.72)
      u[20] = f[FRAME.sunColor]! * scale
      u[21] = f[FRAME.sunColor + 1]! * scale
      u[22] = f[FRAME.sunColor + 2]! * scale
      u.fill(0, 24)
      let pLights = 0
      for (const fl of this.activeFlashes) {
        if (pLights >= 8) break
        const light = explosionFlashLight(fl.x, fl.y, fl.z, fl.age, EXPLOSION_PRESETS[fl.preset].settings)
        if (!light) continue
        const o = 24 + pLights++ * 8
        u[o] = light.x
        u[o + 1] = light.y
        u[o + 2] = light.z
        u[o + 3] = light.radius * 5
        u[o + 4] = light.r
        u[o + 5] = light.g
        u[o + 6] = light.b
        u[o + 7] = light.power * 0.45
      }
      u[23] = pLights
      this.fxRenderer.upload(this.fxParticles)
    }
  }

  draw(pass: GPURenderPassEncoder): void {
    const [opaque, missiles, trans] = this.counts as [number, number, number]
    if (opaque || missiles || trans) {
      pass.setVertexBuffer(0, this.meshBuf)
      pass.setBindGroup(1, this.rockGroup)
      if (opaque || missiles) pass.setPipeline(this.rockOpaque)
      if (opaque) pass.draw(this.icoVerts, opaque, 0, 0)
      if (missiles) pass.draw(this.aimVerts, missiles, this.icoVerts, MAX_ROCKS)
      if (trans) {
        pass.setPipeline(this.rockTrans)
        pass.draw(this.icoVerts, trans, 0, MAX_ROCKS * 2)
      }
    }
    if (this.smokes) {
      pass.setPipeline(this.smokePipe)
      pass.setBindGroup(1, this.smokeGroup)
      pass.draw(18, this.smokes)
    }
    if (this.glows) {
      pass.setPipeline(this.glowPipe)
      pass.setBindGroup(1, this.glowGroup)
      pass.draw(18, this.glows)
    }
    if (this.fxParticles.count > 0) {
      this.fxRenderer.draw(pass)
    }
  }
}
