import { reactivePipelineDescriptor } from "../gpu/reactive"
import { Splatter, SPLATTER_DECALS, SPLATTER_PARTICLES, SPLATTER_RECEIVERS, PARTICLE_STRIDE, DECAL_STRIDE } from "./splatter"

export type SplatterLightingInput = {
  ambient?: readonly [number, number, number]
  noirMode?: boolean
  legacy?: boolean
  flashlight?: {
    x: number
    y: number
    z: number
    range: number
    dirX: number
    dirZ: number
    cosHalf: number
    power: number
    color: readonly [number, number, number]
  } | null
  pointLight?: {
    x: number
    y: number
    z: number
    radius: number
    color: readonly [number, number, number]
    power: number
  } | null
}

const shader = /* wgsl */ `
struct Frame {
  vp: mat4x4f,
  eye: vec4f,
  ambient: vec4f,
  flashPos: vec4f,
  flashCone: vec4f,
  flashCol: vec4f,
  light0Pos: vec4f,
  light0Col: vec4f,
}
struct Splat {
  position: vec4f,
  tangent: vec4f,
  normal: vec4f,
  color: vec4f,
  clipA: vec4f,
  clipB: vec4f,
}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> instances: array<Splat>;

struct Out {
  @builtin(position) p: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) color: vec4f,
  @location(2) @interpolate(flat) a: vec4f,
  @location(3) @interpolate(flat) b: vec4f,
  @location(4) @interpolate(flat) info: vec4f,
  @location(5) world: vec3f,
  @location(6) @interpolate(flat) normal: vec3f,
  @location(7) @interpolate(flat) tangent: vec3f,
}

@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  let s = instances[i];
  let corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));
  let q = corners[v];
  var right = s.tangent.xyz;
  var up = cross(s.normal.xyz, right);
  if (s.normal.w == 0.0) {
    let view = normalize(F.eye.xyz - s.position.xyz);
    up = normalize(right + vec3f(0.00001, 0.00001, 0.0));
    right = normalize(cross(up, view));
  }
  let lift = select(0.0025, 0.011, s.normal.y > 0.8);
  let world = s.position.xyz + right * q.x * s.position.w + up * q.y * s.tangent.w + s.normal.xyz * lift;
  var o: Out;
  o.p = F.vp * vec4f(world, 1.0);
  o.uv = q;
  o.color = s.color;
  o.a = s.clipA;
  o.b = s.clipB;
  let stretch = clamp(s.position.w / max(s.tangent.w, 0.001), 1.0, 4.2);
  o.info = vec4f(s.normal.w, stretch, s.position.w, s.tangent.w);
  o.world = world;
  o.normal = select(vec3f(0.0, 1.0, 0.0), s.normal.xyz, s.normal.w > 0.5);
  o.tangent = right;
  return o;
}

fn cross2(a: vec2f, b: vec2f) -> f32 { return a.x * b.y - a.y * b.x; }
fn hash1(n: f32) -> f32 { return fract(sin(n * 12.9898 + 78.233) * 43758.5453); }

@fragment fn fs(o: Out) -> @location(0) vec4f {
  let uv = o.uv;
  let aa = max(length(fwidth(uv)) * 0.65, 0.006);
  let kind = o.info.x;
  let stretch = o.info.y;
  let seed = o.b.z;
  let age = max(0.0, o.b.w);
  var coverage = 0.0;
  var density = 0.0;

  if (kind == 1.0) {
    let a = o.a.xy;
    let b = o.a.zw;
    let c = o.b.xy;
    let sign = select(-1.0, 1.0, cross2(b - a, c - a) > 0.0);
    if (cross2(b - a, uv - a) * sign < -0.00001 || cross2(c - b, uv - b) * sign < -0.00001 || cross2(a - c, uv - c) * sign < -0.00001) {
      discard;
    }

    if (F.ambient.w < -0.5) {
      let angle = atan2(uv.y, uv.x);
      let edge = 0.075 * sin(angle * 5.0 + seed) + 0.035 * sin(angle * 11.0 - seed * 2.0);
      let coreL = 0.59 - length(uv * vec2f(1.04, 1.18)) + edge;
      let lobe1 = 0.31 - length((uv - vec2f(0.39, 0.14)) * vec2f(1.2, 1.0));
      let lobe2 = 0.27 - length((uv + vec2f(0.3, 0.32)) * vec2f(0.85, 1.3));
      let lobe3 = 0.19 - length((uv - vec2f(-0.34, 0.4)) * vec2f(1.1, 0.9));
      let densL = max(max(coreL, lobe1), max(lobe2, lobe3));
      let covL = smoothstep(-aa, aa, densL);
      if (covL < 0.01) { discard; }
      let grainL = 0.88 + 0.12 * sin(uv.x * 17.0 + seed) * sin(uv.y * 13.0 - seed);
      return vec4f(o.color.rgb * grainL, o.color.a * covL);
    }

    // Asymmetric ballistic profile: impact head shifted back along -uv.x, radiating directional fingers along +uv.x
    let headShift = 0.16 * clamp(stretch - 1.0, 0.0, 2.2);
    let uvHead = vec2f(uv.x + headShift, uv.y);
    let angle = atan2(uvHead.y, uvHead.x);
    let r = length(uvHead * vec2f(0.96, 1.18));
    let forwardBias = pow(max(0.0, cos(angle) * 0.65 + 0.35), 1.5) * clamp(stretch * 0.62, 0.45, 1.75);
    let lowWarp = 0.08 * sin(angle * 3.0 + seed * 1.3) + 0.05 * cos(angle * 5.0 - seed * 2.1);
    let rays = (0.125 * sin(angle * 9.0 + seed * 3.7) + 0.075 * sin(angle * 17.0 - seed * 5.3) + 0.042 * cos(angle * 27.0 + seed * 7.9)) * (0.45 + 1.05 * forwardBias);
    let core = (0.44 + 0.09 * forwardBias) - r + lowWarp + rays;

    // Seed-varied directional satellite lobes & forward spatter streaks
    var sat = -1.0;
    for (var k = 0; k < 6; k++) {
      let fk = f32(k);
      let h0 = hash1(seed + fk * 13.7);
      let h1 = hash1(seed * 1.7 + fk * 29.3);
      let sAng = (fk - 2.5) * 0.48 + (h0 - 0.5) * 0.44;
      let dir = vec2f(cos(sAng), sin(sAng));
      let perpDir = vec2f(-dir.y, dir.x);
      let sDist = 0.38 + 0.40 * h1;
      let center = dir * sDist - vec2f(headShift * 0.5, 0.0);
      let rel = uv - center;
      let along = dot(rel, dir);
      let perp = dot(rel, perpDir);
      let rad = 0.072 + 0.068 * hash1(seed * 2.3 + fk * 41.1);
      let streak = rad - length(vec2f(along * 0.48, perp * 1.75));
      sat = max(sat, streak);
    }

    // Fine outer micro-spatter droplets in the forward spray fan
    let cell = floor((uv + vec2f(1.2, 1.2)) * 7.5);
    let cellCenter = (cell + 0.5) / 7.5 - vec2f(1.2, 1.2);
    let cellH = hash1(dot(cell, vec2f(17.3, 43.7)) + seed * 3.1);
    let microDist = length(uv - (cellCenter + (vec2f(cellH, fract(cellH * 9.7)) - 0.5) * 0.06));
    let inFan = step(0.42, r) * step(r, 0.96) * step(0.68, cellH + 0.16 * forwardBias);
    let micro = select(-1.0, 0.036 - microDist, inFan > 0.5);

    density = max(core, max(sat, micro));

    // Gravity wall drips on vertical surfaces (abs(normal.y) < 0.5)
    if (abs(o.normal.y) < 0.5) {
      let dripGrow = clamp(1.0 - exp(-age * 1.45), 0.0, 1.0);
      let d1x = uv.x - (hash1(seed + 4.1) - 0.5) * 0.38;
      let d2x = uv.x - (hash1(seed + 9.3) - 0.5) * 0.44;
      let downCoord = -uv.y;
      let drip1 = select(-1.0, 0.048 - abs(d1x) * (1.0 + downCoord * 0.45), downCoord > 0.0 && downCoord < 0.88 * dripGrow);
      let drip2 = select(-1.0, 0.036 - abs(d2x) * (1.0 + downCoord * 0.55), downCoord > 0.05 && downCoord < 0.72 * dripGrow);
      density = max(density, max(drip1, drip2));
    }

    coverage = smoothstep(-aa, aa * 1.25, density);
  } else {
    // Airborne velocity-stretched ballistic droplet & aerosol trail
    let streak = 1.0 - smoothstep(0.45 - aa, 0.98, length(uv * vec2f(1.15, 0.72)));
    density = streak * 0.45;
    coverage = streak;
  }

  if (coverage < 0.01) { discard; }

  // Optical depth (Beer-Lambert): thick venous core vs saturated arterial rim, darkening with coagulation age
  let thickness = clamp(smoothstep(0.0, 0.36, density), 0.0, 1.0);
  let freshness = clamp(exp(-age * 0.14), 0.25, 1.0);
  let grain = 0.90 + 0.10 * sin(uv.x * 19.0 + seed) * cos(uv.y * 15.0 - seed);

  let baseRgb = o.color.rgb * grain;
  let rimCol = baseRgb * (1.12 * freshness + 0.48 * (1.0 - freshness));
  let midCol = baseRgb * (0.52 * freshness + 0.24 * (1.0 - freshness));
  let coreCol = baseRgb * vec3f(0.12, 0.025, 0.032) * (0.48 + 0.52 * freshness);
  var bloodAlbedo = mix(rimCol, midCol, smoothstep(0.04, 0.46, thickness));
  bloodAlbedo = mix(bloodAlbedo, coreCol, smoothstep(0.42, 0.88, thickness));

  // Raised liquid meniscus bevel normal at decal perimeter for wet specular glints
  let rimMeniscus = smoothstep(0.02, 0.14, thickness) * (1.0 - smoothstep(0.14, 0.36, thickness));
  let radDir = normalize(uv + vec2f(0.0001, 0.0001));
  let bitangent = cross(o.normal, o.tangent);
  let nBevel = normalize(o.normal + (o.tangent * radDir.x + bitangent * radDir.y) * (rimMeniscus * 0.38 * freshness));
  let V = normalize(F.eye.xyz - o.world);

  // Evaluate flashlight cone irradiance & wet specular highlight (extend effective reach to match visual beam cone)
  var flashIrr = 0.0;
  var specAccum = vec3f(0.0);
  if (F.flashCone.w > 0.001 && F.flashPos.w > 0.1) {
    let toFrag = o.world - F.flashPos.xyz;
    let dPlan = length(toFrag.xz);
    let maxBeamR = clamp(F.flashPos.w * 0.65, 9.2, 12.0);
    if (dPlan < maxBeamR) {
      let dir2 = toFrag.xz / max(dPlan, 0.001);
      let cosA = dot(dir2, F.flashCone.xy);
      let coneW = smoothstep(F.flashCone.z - 0.06, min(0.995, F.flashCone.z + 0.16), cosA);
      let distW = pow(max(0.0, 1.0 - dPlan / maxBeamR), 1.15) / (1.0 + dPlan * dPlan * 0.045);
      flashIrr = clamp(coneW * distW * F.flashCone.w * 1.45, 0.0, 1.25);
      if (flashIrr > 0.005) {
        let L = normalize(-toFrag);
        let H = normalize(L + V);
        let ndh = max(dot(nBevel, H), 0.0);
        let spec = pow(ndh, 44.0) * freshness * (0.06 + 0.16 * rimMeniscus) * flashIrr;
        specAccum += F.flashCol.rgb * spec;
      }
    }
  }

  // Evaluate nearest room/muzzle/street point light
  var pointIrr = vec3f(0.0);
  if (F.light0Col.w > 0.001 && F.light0Pos.w > 0.1) {
    let toL = F.light0Pos.xyz - o.world;
    let d = length(toL);
    if (d < F.light0Pos.w) {
      let att = pow(1.0 - d / F.light0Pos.w, 1.6) * F.light0Col.w / (1.0 + d * d * 0.22);
      let L = toL / max(d, 0.001);
      let ndl = max(0.25, dot(o.normal, L));
      pointIrr = F.light0Col.rgb * (att * ndl);
      let H = normalize(L + V);
      let spec = pow(max(dot(nBevel, H), 0.0), 38.0) * freshness * (0.05 + 0.12 * rimMeniscus) * min(1.2, att);
      specAccum += F.light0Col.rgb * spec;
    }
  }

  let isNoir = F.ambient.w > 0.5;
  var outRgb: vec3f;
  if (isNoir) {
    // Noir selective-colour look: deep wet crimson inside the flashlight beam (or room light), near-black clot outside
    let beamMask = clamp(flashIrr * 1.15 + length(pointIrr) * 0.35, 0.0, 1.0);
    let totalIrr = clamp(flashIrr * 0.65 + length(pointIrr) * 0.28, 0.0, 0.88);
    let litCrimson = bloodAlbedo * (0.11 + 0.54 * totalIrr) + specAccum * 0.26;
    let darkClot = vec3f(0.004, 0.004, 0.005) * (1.0 - 0.65 * thickness);
    outRgb = mix(darkClot, litCrimson, smoothstep(0.02, 0.32, beamMask));
  } else {
    let amb = max(F.ambient.rgb, vec3f(0.16, 0.16, 0.18));
    let totalLight = amb + F.flashCol.rgb * (flashIrr * 0.65) + pointIrr * 0.75;
    outRgb = bloodAlbedo * totalLight + specAccum * 0.26;
  }

  let effAlpha = o.color.a * coverage * (0.68 + 0.32 * smoothstep(0.0, 0.55, thickness));
  return vec4f(outRgb, effAlpha);
}
`

/** One depth-tested HDR draw. Preserves destination HDR alpha so Noir flashlight selective-colour masks remain intact. */
export class SplatterRenderer {
  private readonly data = new Float32Array((SPLATTER_DECALS * SPLATTER_RECEIVERS + SPLATTER_PARTICLES) * 24)
  private readonly frame = new Float32Array(48)
  private readonly uniform: GPUBuffer
  private readonly storage: GPUBuffer
  private readonly group: GPUBindGroup
  private readonly pipeline: GPURenderPipeline
  private legacyPipeline?: GPURenderPipeline
  private motionPipeline?: GPURenderPipeline
  private readonly descriptor: GPURenderPipelineDescriptor
  private useLegacyPipe = false
  private reactivePipe?: GPURenderPipeline
  count = 0
  /** Instances before the flying drops (the decals, which only grow in place). */
  private decalCount = 0

  constructor(private readonly device: GPUDevice) {
    this.uniform = device.createBuffer({ size: this.frame.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.storage = device.createBuffer({ size: this.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    })
    this.group = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: { buffer: this.storage } },
      ],
    })
    const module = device.createShaderModule({ code: shader, label: "Wet ballistic surface splatter" })
    this.descriptor = {
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [
          {
            format: "rgba16float",
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
              // Preserve destination HDR alpha (1.0 - lookFlashIrradiance) so Look/Noir post shaders keep beam colour
              alpha: { srcFactor: "zero", dstFactor: "one" },
            },
          },
        ],
      },
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less-equal" },
      multisample: { count: 4 },
    }
    this.pipeline = device.createRenderPipeline(this.descriptor)
  }

  prepare(
    s: Splatter,
    vp: ArrayLike<number>,
    eye: ArrayLike<number>,
    motion = false,
    lighting?: SplatterLightingInput,
  ) {
    if (motion && !this.motionPipeline) {
      this.motionPipeline = this.device.createRenderPipeline({
        ...this.descriptor,
        fragment: {
          ...this.descriptor.fragment!,
          targets: [...this.descriptor.fragment!.targets, { format: "rgba16float", writeMask: 0 }],
        },
      })
    }
    this.useLegacyPipe = Boolean(lighting?.legacy)
    if (this.useLegacyPipe && !this.legacyPipeline) {
      this.legacyPipeline = this.device.createRenderPipeline({
        ...this.descriptor,
        fragment: {
          ...this.descriptor.fragment!,
          targets: [
            {
              format: "rgba16float",
              blend: {
                color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              },
            },
          ],
        },
      })
    }
    this.count = 0
    for (let i = 0; i < 16; i++) this.frame[i] = vp[i]!
    for (let i = 0; i < 3; i++) this.frame[16 + i] = eye[i]!
    this.frame[19] = s.time

    const amb = lighting?.ambient ?? [0.42, 0.42, 0.46]
    this.frame[20] = amb[0]
    this.frame[21] = amb[1]
    this.frame[22] = amb[2]
    this.frame[23] = lighting?.legacy ? -1 : lighting?.noirMode ? 1 : 0

    const fl = lighting?.flashlight
    if (fl && fl.power > 0.001) {
      this.frame.set([fl.x, fl.y, fl.z, fl.range], 24)
      this.frame.set([fl.dirX, fl.dirZ, fl.cosHalf, fl.power], 28)
      this.frame.set([fl.color[0], fl.color[1], fl.color[2], 1], 32)
    } else {
      this.frame.fill(0, 24, 36)
    }

    const pt =
      lighting?.pointLight !== undefined
        ? lighting.pointLight
        : { x: 12, y: 4.2, z: 10, radius: 18, color: [1.0, 0.92, 0.82] as const, power: 1.35 }
    if (pt && pt.power > 0.001) {
      this.frame.set([pt.x, pt.y, pt.z, pt.radius], 36)
      this.frame.set([pt.color[0], pt.color[1], pt.color[2], pt.power], 40)
    } else {
      this.frame.fill(0, 36, 44)
    }

    const d = s.decals
    const p = this.data
    const tri = s.surfaces.triangles
    const maxInstances = SPLATTER_DECALS * SPLATTER_RECEIVERS
    for (let i = 0; i < SPLATTER_DECALS; i++) {
      const k = i * DECAL_STRIDE
      if (d[k + 7]! <= 0) continue
      const age = d[k + 15]!
      const grow = 1 + d[k + 19]! * (1 - Math.exp(-age * 1.8))
      const rx = d[k + 3]! * grow
      const ry = d[k + 11]! * grow
      const tx = d[k + 4]!
      const ty = d[k + 5]!
      const tz = d[k + 6]!
      const nx = d[k + 8]!
      const ny = d[k + 9]!
      const nz = d[k + 10]!
      const ux = ny * tz - nz * ty
      const uy = nz * tx - nx * tz
      const uz = nx * ty - ny * tx
      const recCount = s.receiverCounts[i]!
      for (let j = 0; j < recCount; j++) {
        if (this.count >= maxInstances) break
        const o = this.count++ * 24
        const t = s.receivers[i * SPLATTER_RECEIVERS + j]! * 16
        // For slightly sloped terrain neighbor triangles, project center onto the receiver triangle plane
        const planeOff =
          j > 0 && ny > 0.85
            ? (tri[t]! - d[k]!) * tri[t + 12]! + (tri[t + 1]! - d[k + 1]!) * tri[t + 13]! + (tri[t + 2]! - d[k + 2]!) * tri[t + 14]!
            : 0
        const cx = d[k]! + nx * planeOff
        const cy = d[k + 1]! + ny * planeOff
        const cz = d[k + 2]! + nz * planeOff
        p[o] = cx
        p[o + 1] = cy
        p[o + 2] = cz
        p[o + 3] = rx
        p[o + 4] = tx
        p[o + 5] = ty
        p[o + 6] = tz
        p[o + 7] = ry
        p[o + 8] = nx
        p[o + 9] = ny
        p[o + 10] = nz
        p[o + 11] = 1
        p[o + 12] = d[k + 12]!
        p[o + 13] = d[k + 13]!
        p[o + 14] = d[k + 14]!
        p[o + 15] = d[k + 16]! * Math.min(1, d[k + 7]! / Math.min(3, d[k + 18]! * 0.25))
        for (let v = 0; v < 3; v++) {
          const e = v === 0 ? 0 : v === 1 ? 4 : 8
          const x = tri[t]! + (v ? tri[t + e]! : 0) - cx
          const y = tri[t + 1]! + (v ? tri[t + e + 1]! : 0) - cy
          const z = tri[t + 2]! + (v ? tri[t + e + 2]! : 0) - cz
          p[o + 16 + v * 2] = (x * tx + y * ty + z * tz) / rx
          p[o + 17 + v * 2] = (x * ux + y * uy + z * uz) / ry
        }
        p[o + 22] = d[k + 17]!
        p[o + 23] = age
      }
    }
    this.decalCount = this.count
    const drops = s.particles
    for (let i = 0; i < SPLATTER_PARTICLES; i++) {
      const k = i * PARTICLE_STRIDE
      if (drops[k + 7]! <= 0) continue
      const o = this.count++ * 24
      const speed = Math.hypot(drops[k + 4]!, drops[k + 5]!, drops[k + 6]!) || 1
      p[o] = drops[k]!
      p[o + 1] = drops[k + 1]!
      p[o + 2] = drops[k + 2]!
      p[o + 3] = drops[k + 3]! * 1.25
      p[o + 4] = drops[k + 4]! / speed
      p[o + 5] = drops[k + 5]! / speed
      p[o + 6] = drops[k + 6]! / speed
      p[o + 7] = drops[k + 3]! * (1.4 + Math.min(2.6, speed * 0.16))
      p[o + 8] = p[o + 9] = p[o + 10] = p[o + 11] = 0
      p[o + 12] = drops[k + 8]!
      p[o + 13] = drops[k + 9]!
      p[o + 14] = drops[k + 10]!
      p[o + 15] = drops[k + 11]!
      p[o + 22] = drops[k + 12]!
      p[o + 23] = 0
    }
    this.device.queue.writeBuffer(this.uniform, 0, this.frame)
    if (this.count) this.device.queue.writeBuffer(this.storage, 0, this.data.buffer, 0, this.count * 96)
  }

  draw(pass: GPURenderPassEncoder, motion = false) {
    if (!this.count) return
    pass.setPipeline(motion ? this.motionPipeline! : this.useLegacyPipe ? this.legacyPipeline! : this.pipeline)
    pass.setBindGroup(0, this.group)
    pass.draw(6, this.count)
  }

  /** Redraws the drops in flight into the temporal reactive mask (`@arcade/kit/gpu/reactive`); decals stay out. */
  drawReactive(pass: GPURenderPassEncoder) {
    const drops = this.count - this.decalCount
    if (drops <= 0) return
    this.reactivePipe ??= this.device.createRenderPipeline(reactivePipelineDescriptor(this.descriptor))
    pass.setPipeline(this.reactivePipe)
    pass.setBindGroup(0, this.group)
    pass.draw(6, drops, 0, this.decalCount)
  }
}
