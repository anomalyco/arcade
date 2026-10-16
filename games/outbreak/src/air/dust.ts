import { foliageWindDeclarationsWgsl } from "@arcade/kit/gpu/foliage"
import type { PassContext, ScenePass } from "@arcade/kit/gpu/renderer"
import { common } from "@arcade/kit/gpu/shaders"
import type { QualityTier } from "@arcade/kit/quality"
import { beamShapeWgsl, lensVisibilityWgsl } from "../flashlight-beam"
import { outbreakLightingStructWgsl } from "../lighting"

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
 */
export const dustShader = /* wgsl */ `
${common}
${foliageWindDeclarationsWgsl}
${outbreakLightingStructWgsl}
@group(0) @binding(5) var floorSamp: sampler;
@group(0) @binding(14) var visField: texture_2d<f32>;
${beamShapeWgsl}
${lensVisibilityWgsl}

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

/** The cell's mote this frame (xyz) and its seed (w); w < 0 when the cell is empty at this amount. */
fn moteAt(cell: vec3f, c: f32) -> vec4f {
  let h = hash3(cell);
  let g = hash3(cell + vec3f(17.31, 5.17, 11.71));
  if (g.x > OL.dust.x) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let t = F.cam.w;
  let w = vec3f(0.11, 0.07, 0.09) + g * 0.16;
  let orbit = vec3f(sin(t * w.x + h.y * 6.283), sin(t * w.y + h.z * 6.283) * 0.6, cos(t * w.z + h.x * 6.283));
  return vec4f((cell + vec3f(0.5) + (h - vec3f(0.5)) * 0.55 + orbit * 0.2) * c, g.y);
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
  if (OL.dust.x <= 0.001 || OL.dust.y <= 0.001) { return o; }
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
    let c = 0.32;
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
    if (OL.dust.w < 0.5) { return o; }
    let j = ii - FLASH_MOTES;
    let li = j / LAMP_MOTES + 1u;
    if (li >= u32(F.screen.z)) { return o; }
    let L = lights[li];
    if (L.color.w <= 0.01 || L.cone.w > 1.5) { return o; }
    let r = L.pos.w;
    let hl = L.pos.y;
    let half = min(r * 0.42, 2.4);
    let lo = vec3f(L.pos.x - half, max(0.08, hl - 3.2), L.pos.z - half);
    let hi = vec3f(L.pos.x + half, min(hl + 0.25, select(2.72, 9.0, hl > 3.2)), L.pos.z + half);
    let size = max(hi - lo, vec3f(0.01));
    let fit = pow(size.x * size.y * size.z / f32(LAMP_MOTES), 1.0 / 3.0);
    let c = 0.3 * pow(1.25, ceil(max(0.0, log(fit / 0.3) / log(1.25))));
    let cell = cellOf(j % LAMP_MOTES, lo, hi, c);
    if (cell.w < 0.0) { return o; }
    let m = moteAt(cell.xyz + vec3f(0.0, 0.0, 311.0), c);
    if (m.w < 0.0) { return o; }
    p = m.xyz;
    seed = m.w;
    let dv = p.xz - L.pos.xz;
    let dPlan2 = dot(dv, dv);
    if (dPlan2 >= r * r) { return o; }
    // The same cuts the surfaces get: sconces stop at their wall, windows light outwards, lamps stay under the ceiling.
    if (L.cone.w > 1.125) {
      if (p.y > 2.75 || dot(dv, L.cone.xy) < -L.extra.x) { return o; }
    } else if (L.cone.w > 0.5) {
      if (dot(dv, L.cone.xy) <= 0.0) { return o; }
    } else if (hl < 3.2 && p.y > 2.75) {
      return o;
    }
    let dy = hl - p.y;
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
    o.lens = L.pos.xyz;
    o.slot = select(0u, li + 1u, L.extra.y > 0.5);
  }
  // A slow glint as each flake turns, and the size kept above a pixel (dimmer instead of smaller).
  let glint = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(F.cam.w * (0.7 + 2.1 * seed) + seed * 40.0), 3.0);
  let clip = F.viewProj * vec4f(p, 1.0);
  if (clip.w <= 0.0) { return o; }
  let clipX = F.viewProj * vec4f(p + vec3f(0.25, 0.0, 0.0), 1.0);
  let ppm = length((clipX.xy / clipX.w - clip.xy / clip.w) * F.screen.xy * 0.5) * 4.0;
  let worldR = (0.008 + 0.012 * fract(seed * 7.13)) * OL.dust.z;
  let rpx = max(worldR * ppm, 0.85);
  let shrink = worldR * ppm / rpx;
  o.col *= glint * OL.dust.y * shrink * shrink;
  let quad = rpx + 1.25;
  let corner = CORNERS[vi];
  o.pos = clip + vec4f(corner * quad * 2.0 / F.screen.xy * clip.w, 0.0, 0.0);
  o.q = corner * quad / rpx;
  o.world = p;
  return o;
}

@fragment fn fs(o: VO) -> @location(0) vec4f {
  let a = exp(-dot(o.q, o.q) * 1.6);
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
  private instances = 0

  constructor(ctx: PassContext) {
    const d = ctx.device
    const module = d.createShaderModule({ code: dustShader, label: "outbreak dust motes" })
    this.pipe = d.createRenderPipeline({
      label: "outbreak dust motes",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout] }),
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
    })
  }

  /** This frame's work: `lightCount` lights in the buffer (slot 0 is the eye), at `tier`, with dust `on`. */
  frame(lightCount: number, tier: QualityTier, on: boolean) {
    const lamps = Math.min(Math.max(0, lightCount - 1), DUST_LAMPS_BY_TIER[tier])
    this.instances = on ? FLASH_MOTES + lamps * LAMP_MOTES : 0
  }

  draw(pass: GPURenderPassEncoder) {
    if (!this.instances) return
    pass.setPipeline(this.pipe)
    pass.draw(6, this.instances)
  }
}
