import { mat4 } from "wgpu-matrix"
import { BOW_Z, CENTERLINE_X, DECK_X0, DECK_X1, DECK_Y, ISLAND, STERN_Z } from "../../shared/carrier-spec"
import { FRAME_BINDING_WGSL } from "./frame"
import type { Renderer, ScenePass } from "./renderer"
import { FLOATS_PER_VERT } from "./mesh"
import type { ShipDrawPose } from "./ship-pass"

type V3 = [number, number, number]

/** How a light behaves: steady, a double-flash strobe, a slow beacon, an engine glow (throttle/burner), or a flat pool. */
export const LIGHT_KIND = { steady: 0, strobe: 1, beacon: 2, burner: 3, pool: 4 } as const
export type LightKind = (typeof LIGHT_KIND)[keyof typeof LIGHT_KIND]

/**
 * A practical light in its owner's frame (ship space or jet model space): position, HDR colour, radius (m), the
 * smallest on-screen radius (px, so a far carrier still reads as a cluster of points), kind and blink phase (s). Pools
 * lie flat along the half-axes u and v.
 */
export type LightDef = { p: V3; color: V3; size: number; px: number; kind?: LightKind; phase?: number; u?: V3; v?: V3 }

const WHITE: V3 = [1.0, 0.9, 0.72]
const AMBER: V3 = [1.0, 0.52, 0.12]
const RED: V3 = [1.0, 0.07, 0.04]
const GREEN: V3 = [0.12, 1.0, 0.3]
const scale = (c: V3, k: number): V3 => [c[0] * k, c[1] * k, c[2] * k]

/**
 * The carrier at night (concept/time-chase-night.png): white lights along the deck edges, amber runway centreline, the
 * amber drop line down the stern, red (port) and green (starboard) sidelights by the bridge, a white masthead light and
 * a slow red beacon on the mast, warm bridge windows, and two soft floodlit pools on the deck. Ship space: +Z bow,
 * +X port, −X starboard (the island side).
 */
export function carrierLights(): LightDef[] {
  const L: LightDef[] = []
  const y = DECK_Y + 0.35
  const edge = scale(WHITE, 9)
  for (let z = STERN_Z + 3; z <= BOW_Z - 3; z += 10) {
    L.push({ p: [DECK_X1 - 0.35, y, z], color: edge, size: 0.45, px: 2 })
    if (z < ISLAND.z0 - 2 || z > ISLAND.z1 + 2) L.push({ p: [DECK_X0 + 0.35, y, z], color: edge, size: 0.45, px: 2 })
  }
  for (let x = DECK_X0 + 4; x <= DECK_X1 - 4; x += 8) {
    L.push({ p: [x, y, BOW_Z - 0.5], color: edge, size: 0.45, px: 2 })
    L.push({ p: [x, y, STERN_Z + 0.5], color: scale(AMBER, 5), size: 0.38, px: 1.3 })
  }
  for (let z = STERN_Z + 20; z <= BOW_Z - 36; z += 14) L.push({ p: [CENTERLINE_X, DECK_Y + 0.2, z], color: scale(AMBER, 4), size: 0.32, px: 1.1 })
  for (let k = 0; k < 6; k++) L.push({ p: [CENTERLINE_X, DECK_Y - 2 - k * 2.4, STERN_Z - 0.6], color: scale([1.0, 0.35, 0.08], 6), size: 0.4, px: 1.2 })
  // Sidelights by the bridge, the masthead light and the mast beacon (the mast stands 12 m aft of the island front).
  const fwd = ISLAND.z1 - 6
  L.push({ p: [DECK_X1 + 0.3, DECK_Y - 0.8, fwd], color: scale(RED, 30), size: 1.1, px: 3.2 })
  L.push({ p: [ISLAND.x0 - 2.6, DECK_Y + 13.4, fwd - 1], color: scale(GREEN, 30), size: 1.1, px: 3.2 })
  L.push({ p: [-31.4, DECK_Y + 44.5, fwd - 12], color: scale([1, 1, 1], 24), size: 1, px: 3 })
  L.push({ p: [-31.4, DECK_Y + 35.8, fwd - 12], color: scale(RED, 14), size: 0.7, px: 1.8, kind: LIGHT_KIND.beacon })
  // Bridge windows: warm, on the forward face and the inboard side (the mesh's glass glows faintly on its own).
  const win = scale([1.0, 0.72, 0.38], 3)
  for (let x = ISLAND.x0 + 1.6; x <= ISLAND.x1 - 1; x += 2.4) L.push({ p: [x, DECK_Y + 15.8, fwd + 0.75], color: win, size: 0.75, px: 1 })
  for (let z = fwd - 8; z <= fwd - 1; z += 2.4) L.push({ p: [ISLAND.x1 + 0.45, DECK_Y + 15.8, z], color: win, size: 0.75, px: 1 })
  // Floodlit deck: a pool on the apron beside the island and one over the bow catapults.
  const pool = scale([1.0, 0.72, 0.42], 0.07)
  L.push({ p: [-18, DECK_Y + 0.3, -26], color: pool, size: 0, px: 0, kind: LIGHT_KIND.pool, u: [22, 0, 0], v: [0, 0, 80] })
  L.push({ p: [CENTERLINE_X, DECK_Y + 0.3, 110], color: scale(pool, 0.7), size: 0, px: 0, kind: LIGHT_KIND.pool, u: [26, 0, 0], v: [0, 0, 60] })
  return L
}

/**
 * Jet model geometry the lights hang on (PlaneModel's fields; model space, +Z nose, +X the pilot's left). `fins` (the
 * tail fin tips) are found in `body` when not given, so any jet model gets its strobes on its own fins.
 */
export type JetFrame = {
  tips: readonly (readonly number[])[]
  nozzles: readonly (readonly number[])[]
  nozzleRadius: number
  body?: ArrayLike<number>
  fins?: readonly (readonly number[])[]
  /** The belly beacon (plane-glb.ts `PlaneModel.beacon`, clear of a weapons bay). */
  beacon?: readonly number[]
}

/** The highest vertex on each side (|x| > 0.4 m) of the rear half of a packed Mesh vertex list: the fin tips. */
export function finTips(body: ArrayLike<number>): V3[] {
  const best: (V3 | null)[] = [null, null]
  for (let i = 0; i + 2 < body.length; i += FLOATS_PER_VERT) {
    const x = body[i]!
    const y = body[i + 1]!
    const z = body[i + 2]!
    if (z > 0 || Math.abs(x) < 0.4) continue
    const k = x > 0 ? 0 : 1
    if (!best[k] || y > best[k]![1]) best[k] = [x, y, z]
  }
  return best.filter((b): b is V3 => !!b)
}

/**
 * A jet's lights: red on the left wingtip and green on the right, white double-flash strobes on both fin tips, a red
 * belly beacon, and an engine glow at each nozzle that follows the throttle and burner (brighter at night).
 */
export function jetLights(f: JetFrame): LightDef[] {
  const tip = (i: number): V3 => [f.tips[i]![0]!, f.tips[i]![1]!, f.tips[i]![2]!]
  const left = f.tips[0]![0]! > 0 ? 0 : 1
  const fins = (f.fins ?? (f.body ? finTips(f.body) : [])).map((p): V3 => [p[0]!, p[1]! + 0.1, p[2]!])
  const L: LightDef[] = [
    { p: tip(left), color: scale(RED, 12), size: 0.28, px: 1.7 },
    { p: tip(1 - left), color: scale(GREEN, 12), size: 0.28, px: 1.7 },
    { p: f.beacon ? [f.beacon[0]!, f.beacon[1]!, f.beacon[2]!] : [0, 0.15, -1.2], color: scale(RED, 10), size: 0.3, px: 1.4, kind: LIGHT_KIND.beacon, phase: 0.4 },
  ]
  fins.forEach((p, i) => L.push({ p, color: scale([1, 1, 1], 40), size: 0.42, px: 2.4, kind: LIGHT_KIND.strobe, phase: i * 0.04 }))
  for (const n of f.nozzles) L.push({ p: [n[0]!, n[1]!, n[2]! - 0.6], color: [3, 1.15, 0.35], size: f.nozzleRadius * 1.8, px: 0, kind: LIGHT_KIND.burner })
  return L
}

/** Floats per light (4 vec4) and per instance (mat4 + vec4). */
const LIGHT_FLOATS = 16
const INST_FLOATS = 20
const MAX_SHIPS = 33
const MAX_JETS = 33
/** Instance slots across every light set (the carrier's, up to four jet models and the boats). */
const MAX_INSTANCES = MAX_SHIPS + 4 * MAX_JETS + 24

const LIGHTS_WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
struct Light { pos: vec4f, color: vec4f, u: vec4f, v: vec4f } // pos xyz + radius, rgb + min px, u + kind, v + phase
struct Inst { model: mat4x4f, p: vec4f }                       // p: throttle, burner, phase offset, 0
struct SetU { a: vec4f, b: vec4f }                              // a: light base, count, instance base, 0 | b: level, focal px, night, burner night gain
@group(1) @binding(0) var<uniform> S: SetU;
@group(1) @binding(1) var<storage, read> lights: array<Light>;
@group(1) @binding(2) var<storage, read> insts: array<Inst>;

const CORNERS = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) corner: vec2f,
  @location(1) @interpolate(flat) color: vec3f,
  @location(2) @interpolate(flat) pool: f32,
}

/** Double flash every 1.2 s (whole cycles per 3600 s TIME_WRAP), a 1.6 s beacon pulse. */
fn blink(kind: f32, t: f32) -> f32 {
  if (kind > 0.5 && kind < 1.5) {
    let x = fract(t / 1.2) * 1.2;
    return max(1.0 - smoothstep(0.0, 0.05, abs(x - 0.03)), 1.0 - smoothstep(0.0, 0.05, abs(x - 0.2)));
  }
  if (kind > 1.5 && kind < 2.5) {
    let x = fract(t / 1.6);
    return 0.08 + 0.92 * pow(max(sin(x * 6.2831853), 0.0), 6.0);
  }
  return 1.0;
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let count = u32(S.a.y);
  let L = lights[u32(S.a.x) + ii % count];
  let I = insts[u32(S.a.z) + ii / count];
  let kind = L.u.w;
  var k = S.b.x * blink(kind, F.eye.w + L.v.w + I.p.z);
  if (kind > 2.5 && kind < 3.5) {
    // Engine glow: idle embers to a full afterburner, only against the dark (daylight keeps the flames alone).
    k = (0.12 * I.p.x + 1.1 * I.p.y) * S.b.w * S.b.z;
  }
  let c = CORNERS[vi];
  let world = (I.model * vec4f(L.pos.xyz, 1.0)).xyz;
  var o: VO;
  o.corner = c;
  o.pool = select(0.0, 1.0, kind > 3.5);
  var p: vec3f;
  if (kind > 3.5) {
    p = world + (I.model * vec4f(L.u.xyz * c.x + L.v.xyz * c.y, 0.0)).xyz;
  } else {
    let toEye = F.eye.xyz - world;
    let dist = length(toEye);
    let fwd = F.forward.xyz;
    var right = cross(fwd, vec3f(0.0, 1.0, 0.0));
    right = select(vec3f(1.0, 0.0, 0.0), normalize(right), dot(right, right) > 1e-6);
    let up = cross(right, fwd);
    let clipW = max(dot(-toEye, fwd), 0.1);
    let rpx = L.pos.w * S.b.y / clipW;
    let r = max(L.pos.w, L.color.w * clipW / S.b.y);
    // Far away the sprite is held at its minimum size; dim it a little so a distant ship reads as fine points.
    k *= mix(0.5, 1.0, saturate(rpx / max(L.color.w, 1e-3)));
    // Pulled toward the eye so it never sinks into the deck or fuselage it sits on.
    p = world + toEye / max(dist, 1e-3) * min(r * 1.5, dist * 0.5) + (right * c.x + up * c.y) * r;
  }
  o.color = L.color.rgb * k * exp(-length(F.eye.xyz - world) * F.horizon.w * 0.6);
  o.pos = F.viewProj * vec4f(p, 1.0);
  if (k < 1e-3) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); }
  return o;
}

@fragment fn fs(o: VO) -> @location(0) vec4f {
  let d2 = dot(o.corner, o.corner);
  if (o.pool > 0.5) {
    let f = saturate(1.0 - d2);
    return vec4f(o.color * f * f, 0.0);
  }
  let core = exp(-d2 * 14.0) + 0.22 * exp(-d2 * 3.5);
  return vec4f(o.color * core * (1.0 - smoothstep(0.75, 1.0, d2)), 0.0);
}
`

const registry = new WeakMap<Renderer, Lights>()
/** The renderer's Lights, if the game made one (ShipPass and PlaneFx hang their lights on it when they are created). */
export const lightsFor = (r: Renderer): Lights | null => registry.get(r) ?? null

/** Live-tunable: overall brightness, and how much brighter engines burn at night. */
export const LIGHTS_LOOK = { level: 1, burnerNight: 1.6 }

type LightSet = { base: number; count: number; inst: number; max: number; n: number; uniform: GPUBuffer; group: GPUBindGroup }

/**
 * Practical lights ("alpha" slot): additive point sprites (with a minimum pixel size) and flat pools, hung on every
 * carrier and jet drawn this frame. Light sets: the carrier's, plus one per jet model (`addJet`, so each model carries
 * its own wingtip, fin and nozzle positions). Per frame: `ship(pose)` per carrier between `beginShips()` and the next,
 * `jet(set, model, throttle, burner, id)` per jet between `beginJets()` and the next (ShipPass and PlaneFx do this when
 * given the Lights: create it before them, see `lightsFor`), then `upload(level, night, fov, height)` once.
 */
export class Lights implements ScenePass {
  look = { ...LIGHTS_LOOK }
  private device: GPUDevice
  private pipe: GPURenderPipeline
  private layout: GPUBindGroupLayout
  private defs: LightDef[] = []
  private lightBuf: GPUBuffer | null = null
  private instBuf: GPUBuffer
  private sets: LightSet[] = []
  private inst = new Float32Array(MAX_INSTANCES * INST_FLOATS)
  private set = new Float32Array(8)
  private m = mat4.create()
  private on = false

  constructor(r: Renderer) {
    const ctx = r.context
    const d = (this.device = ctx.device)
    const module = r.module(LIGHTS_WGSL, "lights")
    this.layout = d.createBindGroupLayout({
      label: "lights",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    })
    this.pipe = d.createRenderPipeline({
      label: "lights",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, this.layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: ctx.color, blend: { color: { srcFactor: "one", dstFactor: "one" }, alpha: { srcFactor: "zero", dstFactor: "one" } } }] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: false, depthCompare: "greater-equal" },
      multisample: { count: ctx.samples },
    })
    this.instBuf = d.createBuffer({ label: "light-insts", size: this.inst.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.addSet(carrierLights(), MAX_SHIPS)
    registry.set(r, this)
  }

  /** Registers a jet model's lights; returns its set for `jet`. */
  addJet(frame: JetFrame): number {
    return this.addSet(jetLights(frame), MAX_JETS)
  }

  /**
   * Registers any other vehicle's lights (model space, e.g. the boat's sidelights and masthead, render/boat-pass.ts)
   * for up to `max` instances; returns its set. Feed it with `jet(set, model, 0, 0, id)` after `beginSet(set)` each frame.
   */
  addLights(defs: LightDef[], max: number): number {
    return this.addSet(defs, max)
  }

  /** Clears one light set's instances for this frame (the jets' sets are cleared together by `beginJets`). */
  beginSet(set: number): void {
    const s = this.sets[set]
    if (s && set > 0) s.n = 0
  }

  private addSet(defs: LightDef[], max: number): number {
    const d = this.device
    const used = this.sets.reduce((a, s) => a + s.max, 0)
    if (used + max > MAX_INSTANCES) throw new Error("lights: too many light sets")
    const base = this.defs.length
    this.defs.push(...defs)
    const data = new Float32Array(Math.max(1, this.defs.length) * LIGHT_FLOATS)
    this.defs.forEach((l, i) => data.set([...l.p, l.size, ...l.color, l.px, ...(l.u ?? [0, 0, 0]), l.kind ?? 0, ...(l.v ?? [0, 0, 0]), l.phase ?? 0], i * LIGHT_FLOATS))
    this.lightBuf?.destroy()
    this.lightBuf = d.createBuffer({ label: "lights", size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(this.lightBuf, 0, data)
    const uniform = d.createBuffer({ label: "light-set", size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.sets.push({ base, count: defs.length, inst: used, max, n: 0, uniform, group: null as unknown as GPUBindGroup })
    // The light buffer was replaced: every set's group points at the new one.
    for (const s of this.sets) s.group = this.groupFor(s.uniform)
    return this.sets.length - 1
  }

  private groupFor(uniform: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: this.lightBuf! } },
        { binding: 2, resource: { buffer: this.instBuf } },
      ],
    })
  }

  beginShips(): void {
    this.sets[0]!.n = 0
  }

  beginJets(): void {
    for (let i = 1; i < this.sets.length; i++) this.sets[i]!.n = 0
  }

  /** A carrier, posed exactly as ShipPass.add places it. */
  ship(p: ShipDrawPose): void {
    const s = this.sets[0]!
    if (s.n >= s.max) return
    const m = this.m
    mat4.translation([p.x, p.heave, p.z], m)
    mat4.rotateY(m, Math.PI - p.heading, m)
    mat4.rotateX(m, -p.pitch, m)
    mat4.rotateZ(m, p.roll, m)
    const o = (s.inst + s.n++) * INST_FLOATS
    this.inst.set(m, o)
    this.inst[o + 16] = 0
    this.inst[o + 17] = 0
    this.inst[o + 18] = 0
  }

  /** A jet of light set `set` (addJet): its model matrix, throttle and burner 0..1, and an id that staggers its strobes. */
  jet(set: number, model: ArrayLike<number>, throttle: number, burner: number, id: number): void {
    const s = this.sets[set]
    if (!s || set === 0 || s.n >= s.max) return
    const o = (s.inst + s.n++) * INST_FLOATS
    this.inst.set(model as Float32Array, o)
    this.inst[o + 16] = throttle
    this.inst[o + 17] = burner
    this.inst[o + 18] = (((id * 0.618034) % 1) + 1) % 1
  }

  /** Writes this frame's instances. `level` 0..1 switches the lights on, `night` 0..1 lights the engine glow. */
  upload(level: number, night: number, fov: number, height: number): void {
    const d = this.device
    const focal = height / (2 * Math.tan(fov / 2))
    this.on = false
    // Off in daylight: the sunny look is untouched.
    if (level <= 0.002 && night <= 0.002) return
    for (const s of this.sets) {
      if (!s.n) continue
      this.on = true
      d.queue.writeBuffer(this.instBuf, s.inst * INST_FLOATS * 4, this.inst, s.inst * INST_FLOATS, s.n * INST_FLOATS)
      this.set.set([s.base, s.count, s.inst, 0, level * this.look.level, focal, night, this.look.burnerNight])
      d.queue.writeBuffer(s.uniform, 0, this.set)
    }
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.on) return
    pass.setPipeline(this.pipe)
    for (const s of this.sets) {
      if (!s.n || !s.count) continue
      pass.setBindGroup(1, s.group)
      pass.draw(6, s.count * s.n)
    }
  }
}
