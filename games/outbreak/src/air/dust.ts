import { foliageWindDeclarationsWgsl } from "@arcade/kit/gpu/foliage"
import { reactivePipelineDescriptor } from "@arcade/kit/gpu/reactive"
import type { PassContext, ScenePass } from "@arcade/kit/gpu/renderer"
import { common } from "@arcade/kit/gpu/shaders"
import type { QualityTier } from "@arcade/kit/quality"
import { beamShapeWgsl, lensVisibilityWgsl } from "../flashlight-beam"
import { outbreakLightingStructWgsl } from "../lighting"
import type { OutbreakAirSettings } from "./settings"

/** Mote cells the flashlight beam may cover (0.32 m cells over the beam's bounding box). */
export const FLASH_MOTES = 18432
/** Mote cells per lamp (cells grow with the lamp's reach so its box fits). */
export const LAMP_MOTES = 768
/** How many lamps get motes, by quality tier; the flashlight's always do. */
export const DUST_LAMPS_BY_TIER: Readonly<Record<QualityTier, number>> = { high: 12, balanced: 6, low: 0 }

/**
 * Dust motes drifting in the light. Air is a world-anchored lattice of cells, each holding at most one mote that
 * drifts on a slow orbit inside its cell, so motes stay put while a beam sweeps across them and parallax comes from
 * their real heights. Every light draws only the cells in its own volume: the flashlight's cone (instances
 * `0..FLASH_MOTES`) and a box under each lamp (`LAMP_MOTES` each, lights 1..). The vertex stage keeps a mote only
 * where its light reaches it, with that light's falloff and cone or wall cut; the fragment stage shadows it through
 * the light's polar row (so motes never glint behind a wall or under a table) and hides it outside the survivor's
 * sight. Additive into the HDR target, depth-tested against the scene, destination alpha (the colour mask) kept.
 *
 * Three styles (Lab › Beam dust): Today's fine motes that glint as they turn (amount, size and brightness from Look ›
 * Air); AR-68's soft motes, larger soft discs drawn at least `beamDustMinPx` wide; and backlit motes (Kit: "only in
 * light and more minimal and beautiful… really subtle and nice"): few, tiny soft round points of gently varied size,
 * drifting lazily on a slow curl-noise air current, lit only by the light at their position (brightest in the beam's
 * core, nothing outside any light) with a little forward scatter, softer and dimmer as they rise toward the camera, and
 * turning slowly so each catches the light now and then (no per-frame flicker, at least ~1.5 px wide, so TAA keeps
 * them steady). Backlit motes show in the flashlight's cone and under the nearest lamps and fires the CPU picks
 * (`BD.lights`), capsule fire lights included. Styles 1 and 2 read `BD` (group 1).
 */
export const dustShader = /* wgsl */ `
${common}
${foliageWindDeclarationsWgsl}
${outbreakLightingStructWgsl}
@group(0) @binding(5) var floorSamp: sampler;
@group(0) @binding(14) var visField: texture_2d<f32>;
${beamShapeWgsl}
${lensVisibilityWgsl}

/**
 * Beam dust style. a: style (0 Today, 1 soft, 2 backlit), amount, radius (soft cm, backlit mm), brightness; b: drift,
 * depth fade, lamps, smallest px; c (backlit): twinkle, size variation, lamp count, unused; lights (backlit): the light
 * slots of the lamps and fires that get motes.
 */
struct BeamDust { a: vec4f, b: vec4f, c: vec4f, lights: array<vec4f, 3> }
@group(1) @binding(0) var<uniform> BD: BeamDust;
fn softDust() -> bool { return BD.a.x > 0.5 && BD.a.x < 1.5; }
fn backlit() -> bool { return BD.a.x > 1.5; }
fn styled() -> bool { return BD.a.x > 0.5; }
fn dustAmount() -> f32 { return select(OL.dust.x, BD.a.y, styled()); }
fn dustBright() -> f32 { return select(OL.dust.y, BD.a.w, styled()); }
fn dustLamps() -> f32 { return select(OL.dust.w, BD.b.z, styled()); }

const FLASH_MOTES: u32 = ${FLASH_MOTES}u;
const LAMP_MOTES: u32 = ${LAMP_MOTES}u;

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) q: vec2f,
  @location(1) world: vec3f,
  @location(2) col: vec3f,
  @location(3) lens: vec3f,
  @location(4) @interpolate(flat) slot: u32,
}

fn hash3(c: vec3f) -> vec3f {
  var p = fract(c * vec3f(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

/** Cell \`k\` of the lattice (cell size \`c\`) covering [lo, hi]; w < 0 when k is past the box. */
fn cellOf(k: u32, lo: vec3f, hi: vec3f, c: f32) -> vec4f {
  let g0 = floor(lo / c);
  let n = vec3u(max(vec3f(0.0), ceil(hi / c) - g0));
  if (k >= n.x * n.y * n.z) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  return vec4f(g0 + vec3f(f32(k % n.x), f32((k / n.x) % n.y), f32(k / (n.x * n.y))), 1.0);
}

/**
 * A slow, divergence-free air current at \`p\`: the curl of a smooth trigonometric potential that itself drifts, so
 * neighbouring motes swirl together the way dust rides real air.
 */
fn curlDrift(p: vec3f, t: f32) -> vec3f {
  let q = p * 0.55;
  // A = (sin(1.3 q.y + .21t) + sin(.8 q.z - .17t), sin(.9 q.z + .19t) + sin(1.2 q.x + .23t), sin(1.1 q.x - .15t) + sin(.7 q.y + .2t)).
  let dAx_dy = 1.3 * cos(q.y * 1.3 + t * 0.21);
  let dAx_dz = 0.8 * cos(q.z * 0.8 - t * 0.17);
  let dAy_dz = 0.9 * cos(q.z * 0.9 + t * 0.19);
  let dAy_dx = 1.2 * cos(q.x * 1.2 + t * 0.23);
  let dAz_dx = 1.1 * cos(q.x * 1.1 - t * 0.15);
  let dAz_dy = 0.7 * cos(q.y * 0.7 + t * 0.2);
  return vec3f(dAz_dy - dAy_dz, dAx_dz - dAz_dx, dAy_dx - dAx_dy);
}

/** The cell's mote this frame (xyz) and its seed (w); w < 0 when the cell is empty at this amount. */
fn moteAt(cell: vec3f, c: f32) -> vec4f {
  let h = hash3(cell);
  let g = hash3(cell + vec3f(17.31, 5.17, 11.71));
  if (g.x > dustAmount()) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  if (backlit()) {
    // Lazy drift: carried on the curl current about its home, with a slow sway of its own; it stays near its cell, so
    // nothing pops as the light sweeps.
    let t = F.cam.w * BD.b.x;
    let home = (cell + vec3f(0.5) + (h - vec3f(0.5)) * 0.6) * c;
    let sway = vec3f(sin(t * (0.21 + 0.1 * g.z) + h.y * 6.283), sin(t * (0.13 + 0.08 * g.y) + h.z * 6.283) * 0.5, cos(t * (0.17 + 0.1 * g.x) + h.x * 6.283));
    return vec4f(home + (curlDrift(home, t * 0.35) * 0.16 + sway * 0.12) * c * 1.6, g.y);
  }
  let t = F.cam.w * select(1.0, BD.b.x, softDust());
  let w = vec3f(0.11, 0.07, 0.09) + g * 0.16;
  let orbit = vec3f(sin(t * w.x + h.y * 6.283), sin(t * w.y + h.z * 6.283) * 0.6, cos(t * w.z + h.x * 6.283));
  return vec4f((cell + vec3f(0.5) + (h - vec3f(0.5)) * 0.55 + orbit * select(0.2, 0.32, softDust())) * c, g.y);
}

const CORNERS = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
  o.q = vec2f(0.0);
  o.world = vec3f(0.0);
  o.col = vec3f(0.0);
  o.lens = vec3f(0.0);
  o.slot = 0u;
  if (dustAmount() <= 0.001 || dustBright() <= 0.001) { return o; }
  var p: vec3f;
  var seed: f32;
  if (ii < FLASH_MOTES) {
    if (OL.u4.w < 0.5 || OL.u4.z <= 0.001) { return o; }
    let lens = vec3f(OL.u3.x, OL.u11.x, OL.u3.y);
    let axis = vec3f(OL.u3.z * OL.u13.y, OL.u13.x, OL.u3.w * OL.u13.y);
    let reach = min(min(OL.u4.y, OL.u19.w), 13.0);
    let rad = reach * min(OL.u4.x * 1.2, 1.2);
    let e = rad * sqrt(max(vec3f(0.0), vec3f(1.0) - axis * axis));
    let tip = lens + axis * reach;
    var lo = min(lens, tip - e);
    var hi = max(lens, tip + e);
    lo.y = max(lo.y, OL.u19.z + 0.03);
    hi.y = min(hi.y, lens.y + 0.4);
    // Backlit motes sit in a coarser lattice: fewer, and the same cells still fill the whole beam.
    let c = select(0.32, 0.42, backlit());
    let cell = cellOf(ii, lo, hi, c);
    if (cell.w < 0.0) { return o; }
    let m = moteAt(cell.xyz, c);
    if (m.w < 0.0) { return o; }
    p = m.xyz;
    seed = m.w;
    let lv = p - lens;
    let d2 = dot(lv, lv);
    let d = sqrt(max(d2, 1e-6));
    let w = profile(dot(lv, axis) / d) * falloff(d2) * smoothstep(0.25, 0.8, d);
    if (w < 0.004) { return o; }
    o.col = OL.u5.rgb * (w * OL.u4.z * 3.0);
    o.lens = lens;
    o.slot = u32(round(OL.u4.w)) + 1u;
  } else {
    if (dustLamps() < 0.5) { return o; }
    let j = ii - FLASH_MOTES;
    var li = j / LAMP_MOTES + 1u;
    if (backlit()) {
      // The lamps and fires the CPU picked, nearest first.
      let n = j / LAMP_MOTES;
      if (f32(n) >= BD.c.z) { return o; }
      li = u32(round(BD.lights[n / 4u][n % 4u]));
    }
    if (li >= u32(F.screen.z)) { return o; }
    let L = lights[li];
    if (L.color.w <= 0.01 || L.cone.w > 1.5) { return o; }
    var r = L.pos.w;
    var lc = L.pos.xyz;
    // A capsule (a burning figure or tree, a jet of flame): its box spans the segment, lit from the nearest point.
    let capsule = L.cone.w < -1.5 && L.cone.w > -2.0;
    let seg = select(vec3f(0.0), L.cone.xyz, capsule);
    if (capsule) { r = max(r - length(seg.xz), 0.05); }
    let hl = L.pos.y;
    let half = vec2f(min(r * 0.42, 2.4)) + abs(seg.xz);
    let lo = vec3f(L.pos.x - half.x, max(0.08, hl - abs(seg.y) - 3.2), L.pos.z - half.y);
    let hi = vec3f(L.pos.x + half.x, min(hl + abs(seg.y) + 0.25, select(2.72, 9.0, hl > 3.2 || capsule)), L.pos.z + half.y);
    let size = max(hi - lo, vec3f(0.01));
    let fit = pow(size.x * size.y * size.z / f32(LAMP_MOTES), 1.0 / 3.0);
    let c = 0.3 * pow(1.25, ceil(max(0.0, log(fit / 0.3) / log(1.25))));
    let cell = cellOf(j % LAMP_MOTES, lo, hi, c);
    if (cell.w < 0.0) { return o; }
    let m = moteAt(cell.xyz + vec3f(0.0, 0.0, 311.0), c);
    if (m.w < 0.0) { return o; }
    p = m.xyz;
    seed = m.w;
    if (capsule) {
      let a = L.pos.xyz - seg;
      lc = a + 2.0 * seg * clamp(dot(p - a, seg) / max(2.0 * dot(seg, seg), 1e-6), 0.0, 1.0);
    }
    let dv = p.xz - lc.xz;
    let dPlan2 = dot(dv, dv);
    if (dPlan2 >= r * r) { return o; }
    // The same cuts the surfaces get: sconces stop at their wall, windows light outwards, lamps stay under the ceiling.
    if (L.cone.w < -2.5) {
      if (p.y > 2.75 || p.x < L.cone.x || p.x > L.cone.z || p.z < L.cone.y || p.z > L.extra.x) { return o; }
    } else if (L.cone.w > 1.125) {
      if (p.y > 2.75 || dot(dv, L.cone.xy) < -L.extra.x) { return o; }
    } else if (L.cone.w > 0.5) {
      if (dot(dv, L.cone.xy) <= 0.0) { return o; }
    } else if (hl < 3.2 && p.y > 2.75) {
      return o;
    }
    let dy = lc.y - p.y;
    let dn = max(sqrt(dPlan2 + dy * dy), 0.45);
    var win = 1.0 - dPlan2 / (r * r);
    win *= win;
    var att = L.color.w * win * (0.02 + 1.6 / (1.0 + dn * dn * 0.62 * max(0.5, OL.u0.w)));
    if (L.cone.w > 0.5 && L.cone.w < 1.125 && dPlan2 > 1e-6) {
      let t = clamp((dot(dv * inverseSqrt(dPlan2), L.cone.xy) - L.cone.z) / 0.25, 0.0, 1.0);
      att *= t * t * (3.0 - 2.0 * t);
    }
    if (att < 0.004) { return o; }
    o.col = L.color.rgb * (att * 1.6);
    o.lens = lc;
    o.slot = select(0u, li + 1u, L.extra.y > 0.5);
  }
  // A slow glint as each flake turns, and the size kept above a pixel (dimmer instead of smaller).
  var glint = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(F.cam.w * (0.7 + 2.1 * seed) + seed * 40.0), 3.0);
  let clip = F.viewProj * vec4f(p, 1.0);
  if (clip.w <= 0.0) { return o; }
  let clipX = F.viewProj * vec4f(p + vec3f(0.25, 0.0, 0.0), 1.0);
  let ppm = length((clipX.xy / clipX.w - clip.xy / clip.w) * F.screen.xy * 0.5) * 4.0;
  var worldR = (0.008 + 0.012 * fract(seed * 7.13)) * OL.dust.z;
  var minPx = 0.85;
  var energy = 2.0;
  if (softDust()) {
    // Steady (a slow ±12% breath, no blink), a little defocused as it rises toward the camera, and faded where it would
    // read as a hard dot: right at the lens, in the floor, or high up near the lens's height.
    glint = 0.88 + 0.12 * sin(F.cam.w * (0.2 + 0.3 * seed) + seed * 40.0);
    let fade = clamp(BD.b.y, 0.0, 1.0);
    let rise = clamp((p.y - 0.9) / 1.4, 0.0, 1.0);
    worldR = BD.a.z * 0.01 * (0.65 + 0.7 * fract(seed * 7.13)) * (1.0 + 0.9 * fade * rise);
    minPx = max(1.0, BD.b.w);
    energy = 1.2;
    let nearLens = smoothstep(0.35, 1.5, length(p - o.lens));
    let lowFade = smoothstep(0.08, 0.55, p.y - OL.u19.z);
    o.col *= mix(1.0, nearLens * lowFade * (1.0 - 0.45 * rise), fade);
  }
  if (backlit()) {
    // A slow turn: most of the time a faint point, and every few seconds a mote turns its face to the light (seconds,
    // not frames, so TAA keeps it). Size varies gently per mote; nearer the camera it softens and dims.
    let tw = clamp(BD.c.x, 0.0, 1.0);
    let turn = pow(0.5 + 0.5 * sin(F.cam.w * (0.35 + 0.55 * fract(seed * 3.7)) + seed * 40.0), 3.0);
    glint = mix(1.0, 0.45 + 1.1 * turn, tw);
    let fade = clamp(BD.b.y, 0.0, 1.0);
    let rise = clamp((p.y - 0.9) / 1.4, 0.0, 1.0);
    let v = fract(seed * 7.13);
    worldR = BD.a.z * 0.001 * max(0.25, 1.0 + BD.c.y * (v * v * 1.6 - 0.45)) * (1.0 + 1.4 * fade * rise);
    minPx = max(1.0, BD.b.w);
    energy = 0.8;
    // Forward scatter: a mote between the eye and its light glows a little more (backlit dust in a sunbeam).
    let cosT = dot(normalize(F.cam.xyz - p), normalize(p - o.lens + vec3f(0.0, 1e-4, 0.0)));
    let hg = 0.7975 / pow(1.2025 - 0.9 * cosT, 1.5) / 0.605;
    let nearLens = smoothstep(0.35, 1.5, length(p - o.lens));
    let lowFade = smoothstep(0.08, 0.55, p.y - OL.u19.z);
    o.col *= (0.55 + 0.45 * hg) * nearLens * lowFade * (1.0 - 0.5 * fade * rise);
  }
  let rpx = max(worldR * ppm, minPx);
  let shrink = worldR * ppm / rpx;
  o.col *= glint * dustBright() * pow(shrink, energy);
  let quad = rpx + 1.25;
  let corner = CORNERS[vi];
  o.pos = clip + vec4f(corner * quad * 2.0 / F.screen.xy * clip.w, 0.0, 0.0);
  o.q = corner * quad / rpx;
  o.world = p;
  return o;
}

@fragment fn fs(o: VO) -> @location(0) vec4f {
  // Today: a gaussian dot. Soft: a soft-edged disc with a gentle core, like an out-of-focus mote.
  let qr = length(o.q);
  var a = select(exp(-dot(o.q, o.q) * 1.6), (1.0 - smoothstep(0.45, 1.12, qr)) * (0.7 + 0.3 * exp(-qr * qr * 2.0)), softDust());
  // Backlit: a soft round point, a gaussian with a faint wider skirt and no edge.
  if (backlit()) { a = exp(-qr * qr * 2.4) * 0.85 + exp(-qr * qr * 0.9) * 0.15; }
  if (a < 0.004) { return vec4f(0.0); }
  var vis = 1.0;
  if (o.slot > 0u) { vis = lensVis((o.slot - 1u) * RAYS, o.world - o.lens, o.lens.y); }
  let uv = (o.world.xz - OL.win.xy) * F.map.xy;
  let inWin = select(1.0, 0.0, OL.win.z > 0.5 && (any(uv < vec2f(0.003)) || any(uv > vec2f(0.997))));
  let seen = textureSampleLevel(visField, floorSamp, uv, 0.0).r * inWin;
  return vec4f(o.col * (a * vis * seen), 0.0);
}
`

/**
 * The dust pass, drawn after the scene's alpha geometry. `frame()` sets this frame's lamp count and tier; the draw is
 * one instanced call of `FLASH_MOTES + lamps × LAMP_MOTES` quads, most of which the vertex stage drops.
 */
export class DustPass implements ScenePass {
  private readonly pipe: GPURenderPipeline
  private readonly descriptor: GPURenderPipelineDescriptor
  private reactivePipe?: GPURenderPipeline
  private readonly device: GPUDevice
  private readonly styleBuf: GPUBuffer
  private readonly styleGroup: GPUBindGroup
  private readonly style = new Float32Array(24)
  private readonly pick: { i: number; d2: number }[] = []
  private instances = 0

  constructor(ctx: PassContext) {
    const d = ctx.device
    this.device = d
    this.styleBuf = d.createBuffer({ label: "outbreak beam dust", size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const styleLayout = d.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
    })
    this.styleGroup = d.createBindGroup({ layout: styleLayout, entries: [{ binding: 0, resource: { buffer: this.styleBuf } }] })
    const module = d.createShaderModule({ code: dustShader, label: "outbreak dust motes" })
    this.descriptor = {
      label: "outbreak dust motes",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, styleLayout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [{
          format: ctx.color,
          blend: {
            color: { srcFactor: "one", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: false, depthCompare: ctx.depthCompare ?? "less-equal" },
      multisample: { count: ctx.samples },
    }
    this.pipe = d.createRenderPipeline(this.descriptor)
  }

  /**
   * This frame's work: `lightCount` lights in the buffer (slot 0 is the eye), at `tier`, with Today's dust `on`; the
   * Beam dust settings (`air`) switch to soft or backlit motes and decide on their own amount. Backlit motes go under
   * the lamps and fires nearest `(px, pz)` in `lights` (12-float or wider slots, `stride` floats each).
   */
  frame(lightCount: number, tier: QualityTier, on: boolean, air?: OutbreakAirSettings, lights?: Float32Array, stride = 16, px = 0, pz = 0) {
    const style = air ? Math.round(air.beamDustStyle) : 0
    const soft = style === 1
    const lit = style === 2
    let lamps = Math.min(Math.max(0, lightCount - 1), DUST_LAMPS_BY_TIER[tier])
    const u = this.style
    u.fill(0)
    u[0] = style
    if (soft) {
      u[1] = air!.beamDustAmount
      u[2] = air!.beamDustSize
      u[3] = air!.beamDustBrightness
      u[4] = air!.beamDustDrift
      u[5] = air!.beamDustDepthFade
      u[6] = air!.beamDustLamps
      u[7] = air!.beamDustMinPx
    } else if (lit) {
      u[1] = air!.beamMoteDensity
      u[2] = air!.beamMoteSize
      u[3] = air!.beamMoteBrightness
      u[4] = air!.beamMoteDrift
      u[5] = air!.beamMoteDepth
      u[6] = air!.beamMoteLamps
      u[7] = air!.beamMoteMinPx
      u[8] = air!.beamMoteTwinkle
      u[9] = air!.beamMoteSizeVar
      // The nearest lit lamps and fires (no flashlight, no dark slots), up to the tier's budget.
      const pick = this.pick
      pick.length = 0
      if (lights && air!.beamMoteLamps >= 0.5) {
        for (let i = 1; i < lightCount; i++) {
          const k = i * stride
          if (lights[k + 7]! <= 0.01 || lights[k + 11]! > 1.5) continue
          const d2 = (lights[k]! - px) ** 2 + (lights[k + 2]! - pz) ** 2
          if (d2 < 22 * 22) pick.push({ i, d2 })
        }
        pick.sort((a, b) => a.d2 - b.d2)
      }
      lamps = Math.min(pick.length, DUST_LAMPS_BY_TIER[tier], 12)
      u[10] = lamps
      for (let n = 0; n < lamps; n++) u[12 + n] = pick[n]!.i
    }
    const active = soft ? air!.beamDustAmount > 0 && air!.beamDustBrightness > 0 : lit ? air!.beamMoteDensity > 0 && air!.beamMoteBrightness > 0 : on
    this.instances = active ? FLASH_MOTES + lamps * LAMP_MOTES : 0
    if (this.instances) this.device.queue.writeBuffer(this.styleBuf, 0, u)
  }

  draw(pass: GPURenderPassEncoder) {
    if (!this.instances) return
    pass.setPipeline(this.pipe)
    pass.setBindGroup(1, this.styleGroup)
    pass.draw(6, this.instances)
  }

  /** The motes drift and glint on their own: under TAA they go into the reactive mask too. */
  drawReactive(pass: GPURenderPassEncoder) {
    if (!this.instances) return
    this.reactivePipe ??= this.device.createRenderPipeline(reactivePipelineDescriptor(this.descriptor))
    pass.setPipeline(this.reactivePipe)
    pass.setBindGroup(1, this.styleGroup)
    pass.draw(6, this.instances)
  }
}
