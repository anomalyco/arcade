import { ATMOSPHERE_WGSL } from "./atmosphere"
import { FRAME_BINDING_WGSL } from "./frame"
import { HASH_WGSL } from "./ocean-hash"
import type { RelView } from "./ocean-view"
import type { Renderer, ScenePass } from "./renderer"

/** Blobs per cloud. */
const BLOBS = 14
const CELL = 4800
/** Clouds are placed in world cells out to this radius around the camera. */
const RADIUS = 38_000
const MAX_CLOUDS = 320
/** Clear zone below a high camera, so steep views of the sea are never blocked. */
const NEAR_CLEAR = 2600
const DRIFT = 5
const BASE = 2000
const BASE_SPREAD = 700
const COVER = 0.68
/** Storm deck: base height (m) and its spread, size gain and the share of the deck a cell's own hash may delay. */
const DECK_BASE = 1150
const DECK_SPREAD = 250
const DECK_SIZE = 1.0

/**
 * The weather's hold on the clouds (src/render/weather-system.ts writes it): `cover` 0..1 grows the field into a low,
 * dark, faceted overcast deck (0 = the sunny cumulus exactly), `dark` darkens it, `flash` 0..1 is a lightning flash
 * lighting the clouds near the strike from inside (`bearing` clockwise from north and `dist` metres from the camera).
 */
export type CloudStorm = { cover: number; dark: number; flash: number; bearing: number; dist: number }

/**
 * Cloud placement, shared by the CPU cloud list and the ocean's cloud shadows (WGSL mirror below): cell (i, j) of
 * the undrifted frame holds a cloud when h(i, j, seed) <= COVER.
 */
function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c, 0x27d4eb2f)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}
const cloudSize = (i: number, j: number, seed: number) => 700 + 1500 * hash(i, j, seed + 3) ** 1.6
const cloudSeed = (i: number, j: number, seed: number) => Math.floor(hash(i, j, seed + 5) * 65535) + 1

/**
 * WGSL: soft shadow of the cloud field at a world plan point. Needs HASH_WGSL's rand3 and a uniform providing
 * u = (sea origin - drift) and the seed: `cloudShadow(u + p, seed)` where p is relative to the origin. Footprints are
 * ellipses fitted to the blob clusters, so shadows land under the clouds without per-pixel cloud lists.
 */
export const CLOUD_SHADOW_WGSL = /* wgsl */ `
fn cloudHash(a: i32, b: i32, c: u32) -> f32 {
  var h = ((bitcast<u32>(a) ^ 0x9e3779b9u) * 0x85ebca6bu) ^ ((bitcast<u32>(b) + 0x632be5abu) * 0xc2b2ae35u) ^ (c * 0x27d4eb2fu);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  return f32(h ^ (h >> 15u)) * (1.0 / 4294967296.0);
}

const CLOUD_CELL: f32 = ${CELL}.0;

fn cloudShadow(u: vec2f, seed: u32, sunDir: vec3f) -> f32 {
  var shade = 0.0;
  // March to the cloud base along the sun direction.
  let along = sunDir.xz / max(sunDir.y, 0.15);
  let c = vec2i(floor((u + along * ${BASE + BASE_SPREAD / 2}.0) / CLOUD_CELL));
  for (var j = -1; j <= 1; j = j + 1) {
    for (var i = -1; i <= 1; i = i + 1) {
      let ci = c + vec2i(i, j);
      if (cloudHash(ci.x, ci.y, seed) > ${COVER}) { continue; }
      let size = 700.0 + 1500.0 * pow(cloudHash(ci.x, ci.y, seed + 3u), 1.6);
      let base = ${BASE}.0 + ${BASE_SPREAD}.0 * cloudHash(ci.x, ci.y, seed + 4u);
      let centre = (vec2f(ci) + 0.15 + 0.7 * vec2f(cloudHash(ci.x, ci.y, seed + 1u), cloudHash(ci.x, ci.y, seed + 2u))) * CLOUD_CELL;
      let id = u32(floor(cloudHash(ci.x, ci.y, seed + 5u) * 65535.0)) + 1u;
      let rot = rand3(vec3u(id, 0u, 99u)).x * 6.2831853;
      let d = u + along * (base + size * 0.3) - centre;
      let r = vec2f(d.x * cos(rot) + d.y * sin(rot), d.y * cos(rot) - d.x * sin(rot)) / (size * vec2f(1.15, 0.75));
      shade = max(shade, 1.0 - smoothstep(0.55, 1.0, length(r)));
    }
  }
  return shade;
}
`

/** Chunky, flat-bottomed low-poly cumulus. Deterministic from the seed, drifting downwind with sea time. */
const CLOUD_WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
${ATMOSPHERE_WGSL}
${HASH_WGSL}
struct Cloud { pos: vec4f, info: vec4f } // eye-relative base centre, size | seed, fade, storm deck 0..1, lightning glow
struct CloudU { viewProjRel: mat4x4f }
@group(1) @binding(0) var<uniform> U: CloudU;
@group(1) @binding(1) var<storage, read> clouds: array<Cloud>;

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) rel: vec3f,
  @location(1) @interpolate(flat) fade: f32,
  @location(2) local: f32,
  @location(3) @interpolate(flat) storm: f32,
  @location(4) @interpolate(flat) glow: f32,
}

@vertex fn vs(@location(0) unit: vec3f, @builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let c = clouds[ii / ${BLOBS}u];
  let b = ii % ${BLOBS}u;
  let seed = u32(c.info.x);
  let S = c.pos.w;
  let h = rand3(vec3u(seed, b, 17u));
  let h2 = rand3(vec3u(seed, b, 29u));
  // Blob layout: a long cluster, tallest in the middle.
  let a = h.x * 6.2831853;
  let r = select(sqrt(h.y) * 0.85, 0.0, b == 0u);
  let along = vec2f(cos(a) * 1.25, sin(a) * 0.55) * r;
  let rot = rand3(vec3u(seed, 0u, 99u)).x * 6.2831853;
  let cs = vec2f(cos(rot), sin(rot));
  let deck = c.info.z;
  // The storm deck spreads the blobs out and flattens them into a low ceiling.
  let radius = S * (0.5 - 0.26 * r) * (0.75 + 0.35 * h.z) * (1.0 + 0.35 * deck);
  let centre = vec3f(along.x * cs.x - along.y * cs.y, 0.0, along.x * cs.y + along.y * cs.x) * S;
  let lift = radius * (0.15 + 0.45 * (1.0 - r)) + S * 0.08 * h2.x;
  // Chunky facets: every unique vertex of the icosphere is pushed in or out a little.
  let jv = rand3(vec3u(vi, seed, b));
  let u = unit * (0.82 + 0.3 * jv.x);
  var p = centre + vec3f(u.x * radius * (1.0 + 0.25 * h2.y), (u.y * radius * 0.78 + lift) * mix(1.0, 0.5, deck), u.z * radius);
  p.y = max(p.y, 0.0);
  var o: VO;
  o.rel = c.pos.xyz + p;
  o.pos = U.viewProjRel * vec4f(o.rel, 1.0);
  o.fade = c.info.y;
  o.local = p.y / max(S * mix(0.9, 0.45, deck), 1.0);
  o.storm = deck;
  o.glow = c.info.w;
  return o;
}

struct FO { @location(0) color: vec4f }

@fragment fn fs(o: VO) -> FO {
  var n = normalize(cross(dpdx(o.rel), dpdy(o.rel)));
  let V = normalize(-o.rel);
  n = select(-n, n, dot(n, V) >= 0.0);
  let L = F.sunDir.xyz;
  let sun = F.sunColor.rgb * F.sunDir.w;
  let ndl = dot(n, L);
  let wrap = saturate(ndl * 0.6 + 0.4);
  let top = saturate(n.y * 0.5 + 0.5);
  // Opaque, bright: lit facets near white, shaded facets a light lavender-grey, the flat base a touch darker.
  let shadow = cloudAmbient(mix(vec3f(0.55, 0.64, 0.9), vec3f(0.85, 0.93, 1.15), top), top);
  let base = smoothstep(0.0, 0.3, o.local);
  var c = shadow * (0.8 + 0.2 * base) + sun * vec3f(1.0, 0.98, 0.95) * wrap * wrap * (0.5 + 0.5 * base) * 0.75;
  // Sun-side rim where the cloud silhouettes against the bright sky near the sun.
  c += sun * pow(1.0 - max(dot(n, V), 0.0), 3.0) * pow(max(dot(-V, L), 0.0), 4.0) * 0.6 * sunVeil();
  // Storm deck: slate grey from the overcast light (the horizon colour, already darkened by the weather), dark
  // undersides, tops a little lighter, every facet its own shade; lightning lights it from inside, bottoms first.
  if (o.storm > 0.0) {
    let facetL = 0.82 + 0.3 * saturate(n.y * 0.5 + 0.5) + 0.12 * dot(n, normalize(vec3f(0.3, 0.6, 0.2)));
    let under = 1.0 - smoothstep(0.0, 0.55, o.local) * saturate(n.y + 0.6);
    var sc = F.horizon.rgb * mix(1.0, 0.4, under) * facetL;
    sc += vec3f(0.8, 0.86, 1.1) * o.glow * (0.5 + 0.9 * under);
    c = mix(c, sc, o.storm);
  }
  let dist = length(o.rel);
  let fog = 1.0 - exp(-dist * F.horizon.w * 0.45);
  c = mix(c, hazeColor(o.rel / dist), fog);
  var out: FO;
  out.color = vec4f(c, o.fade);
  return out;
}
`

/** Icosahedron: 12 vertices, 20 big faces. Indexed, so per-vertex jitter keeps it watertight. */
function icosphere(): { pos: Float32Array<ArrayBuffer>; idx: Uint16Array<ArrayBuffer> } {
  const t = (1 + Math.sqrt(5)) / 2
  const v: number[][] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
  const f: number[][] = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]
  const pos = new Float32Array(v.length * 3)
  v.forEach((p, i) => {
    const l = Math.hypot(p[0]!, p[1]!, p[2]!)
    pos.set([p[0]! / l, p[1]! / l, p[2]! / l], i * 3)
  })
  return { pos, idx: new Uint16Array(f.flat()) }
}

export class Clouds implements ScenePass {
  count = 0
  private device: GPUDevice
  private pipe: GPURenderPipeline
  private ubuf: GPUBuffer
  private sbuf: GPUBuffer
  private vbuf: GPUBuffer
  private ibuf: GPUBuffer
  private indexCount: number
  private group: GPUBindGroup
  private data = new Float32Array(MAX_CLOUDS * 8)
  private seed = 0
  /** Set by the weather each frame (shared object); all zero is the sunny sky. */
  storm: CloudStorm = { cover: 0, dark: 0, flash: 0, bearing: 0, dist: 0 }
  private wind: [number, number] = [1, 0]
  private ready = false

  constructor(r: Renderer) {
    const ctx = r.context
    const d = (this.device = ctx.device)
    const module = r.module(CLOUD_WGSL, "clouds")
    const layout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    })
    this.pipe = d.createRenderPipeline({
      label: "clouds",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, layout] }),
      vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
      fragment: { module, entryPoint: "fs", targets: [{ format: ctx.color }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: true, depthCompare: "greater-equal" },
      multisample: { count: ctx.samples, alphaToCoverageEnabled: true },
    })
    const ico = icosphere()
    this.indexCount = ico.idx.length
    this.vbuf = d.createBuffer({ size: ico.pos.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(this.vbuf, 0, ico.pos)
    this.ibuf = d.createBuffer({ size: Math.ceil(ico.idx.byteLength / 4) * 4, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(this.ibuf, 0, ico.idx.buffer, 0, Math.ceil(ico.idx.byteLength / 4) * 4)
    this.ubuf = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.sbuf = d.createBuffer({ size: this.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.group = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.ubuf } }, { binding: 1, resource: { buffer: this.sbuf } }] })
  }

  /** Undrifted-frame offset of the world at sea time t: world point minus this is the cell frame. */
  drift(t: number, out: Float64Array): void {
    out[0] = this.wind[0] * DRIFT * t
    out[1] = this.wind[1] * DRIFT * t
  }

  setWorld(seed: number, wind: readonly [number, number]): void {
    this.seed = seed >>> 0
    this.wind = [wind[0], wind[1]]
    this.ready = true
  }

  update(t: number, view: RelView): void {
    if (!this.ready) return
    this.device.queue.writeBuffer(this.ubuf, 0, view.viewProjRel)
    const ex = view.eye[0]!
    const ey = view.eye[1]!
    const ez = view.eye[2]!
    const dx = this.wind[0] * DRIFT * t
    const dz = this.wind[1] * DRIFT * t
    // Cells live in the undrifted frame; every cloud keeps its identity as it drifts.
    const ux = ex - dx
    const uz = ez - dz
    const n = Math.ceil(RADIUS / CELL)
    const ci = Math.floor(ux / CELL)
    const cj = Math.floor(uz / CELL)
    const m = view.viewProjRel64
    const out = this.data
    // Storm: more cells fill in (each fades in as the cover passes its hash), clouds grow, drop to a low deck.
    const deck = Math.max(0, Math.min(1, this.storm.cover))
    const cover = COVER + (1 - COVER) * deck
    const sx = Math.sin(this.storm.bearing) * this.storm.dist
    const sz = -Math.cos(this.storm.bearing) * this.storm.dist
    let count = 0
    for (let j = cj - n; j <= cj + n && count < MAX_CLOUDS; j++) {
      for (let i = ci - n; i <= ci + n && count < MAX_CLOUDS; i++) {
        const hc = hash(i, j, this.seed)
        if (hc > cover) continue
        const appear = hc <= COVER ? 1 : Math.min(1, (cover - hc) / 0.05)
        const size = cloudSize(i, j, this.seed) * (1 + DECK_SIZE * deck)
        const x = (i + 0.15 + 0.7 * hash(i, j, this.seed + 1)) * CELL + dx - ex
        const z = (j + 0.15 + 0.7 * hash(i, j, this.seed + 2)) * CELL + dz - ez
        const h4 = hash(i, j, this.seed + 4)
        const y = BASE + BASE_SPREAD * h4 + (DECK_BASE + DECK_SPREAD * h4 - BASE - BASE_SPREAD * h4) * deck - ey
        const dist = Math.hypot(x, z)
        if (dist > RADIUS) continue
        // Fade out at the edge of the field, and near and below a high camera.
        const far = Math.min(1, (RADIUS - dist) / (RADIUS * 0.12))
        const above = Math.max(0, Math.min(1, (y + 200) / 600))
        const near = Math.min(1, Math.max(above, (dist - NEAR_CLEAR) / 1500))
        const fade = Math.min(far, near) * appear
        if (fade <= 0.02) continue
        // Bounding sphere against the frustum (clip w and x, y bounds).
        const cy = y + size * 0.4
        const r = size * 1.6
        if (!sphereVisible(m, x, cy, z, r)) continue
        const o = count * 8
        out[o] = x
        out[o + 1] = y
        out[o + 2] = z
        out[o + 3] = size
        out[o + 4] = cloudSeed(i, j, this.seed)
        out[o + 5] = fade
        out[o + 6] = deck
        // Lightning lights the clouds near the strike from inside (and the whole deck a little).
        const sd = Math.hypot(x - sx, z - sz) / 3500
        out[o + 7] = this.storm.flash * (0.25 + 1.6 * Math.exp(-sd * sd))
        count++
      }
    }
    this.count = count
    if (count) this.device.queue.writeBuffer(this.sbuf, 0, out.buffer, 0, count * 32)
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.count) return
    pass.setPipeline(this.pipe)
    pass.setBindGroup(1, this.group)
    pass.setVertexBuffer(0, this.vbuf)
    pass.setIndexBuffer(this.ibuf, "uint16")
    pass.drawIndexed(this.indexCount, this.count * BLOBS)
  }
}

function sphereVisible(m: Float64Array, x: number, y: number, z: number, r: number): boolean {
  for (let k = 0; k < 4; k++) {
    const rr = k >> 1
    const sg = k & 1 ? -1 : 1
    const a = m[3]! + sg * m[rr]!
    const b = m[7]! + sg * m[4 + rr]!
    const c = m[11]! + sg * m[8 + rr]!
    const d = m[15]! + sg * m[12 + rr]!
    if ((a * x + b * y + c * z + d) / Math.hypot(a, b, c) < -r) return false
  }
  return true
}
