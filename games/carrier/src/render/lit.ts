import { ATMOSPHERE_WGSL } from "./atmosphere"
import { FRAME_BINDING_WGSL } from "./frame"
import { MAT, VERT_BYTES } from "./mesh"
import type { PassContext } from "./renderer"

/** Vertex layout of packed `Mesh` data: position f32x3, normal snorm8x4, colour unorm8x4, material and aux f16x2. */
export const MESH_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: VERT_BYTES,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "snorm8x4" },
    { shaderLocation: 2, offset: 16, format: "unorm8x4" },
    { shaderLocation: 3, offset: 20, format: "float16x2" },
  ],
}

/**
 * Static world shader: flat sun diffuse (the meshes are faceted, so every face reads as one tone), a hemisphere sky
 * ambient, a little sun-side rim on silhouettes, and distance fog to the horizon haze. Foliage sways with aux as
 * its phase; its pipeline draws both faces and flips the normal on the back.
 */
export const LIT_WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
${ATMOSPHERE_WGSL}

const TAU: f32 = 6.2831853;
// Whole cycles per TIME_WRAP (3600 s), so the eye.w wrap never makes foliage jump: 720 and 1100 cycles.
const SWAY_A: f32 = 1.2566371;
const SWAY_B: f32 = 1.9198622;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec4f,
  @location(2) color: vec4f,
  @location(3) matAux: vec2f,
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) @interpolate(flat) mat: f32,
  @location(4) @interpolate(flat) aux: f32,
}

@vertex fn vs(v: VIn) -> VOut {
  var p = v.pos;
  if (v.matAux.x > ${MAT.foliage - 0.5}) {
    let ph = v.matAux.y * TAU;
    let t = F.eye.w;
    let s = sin(t * SWAY_A + ph) * 0.65 + sin(t * SWAY_B + ph * 1.7 + p.x * 0.031) * 0.35;
    p += vec3f(0.36, 0.0, 0.22) * s + vec3f(0.0, 0.06 * sin(t * SWAY_B + ph), 0.0);
  }
  var o: VOut;
  o.pos = F.viewProj * vec4f(p, 1.0);
  o.world = p;
  o.normal = v.normal.xyz;
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
  if (o.mat > ${MAT.glow - 0.5} && o.mat < ${MAT.glow + 0.5}) {
    c = o.color * (2.0 + o.aux * 4.0);
  } else {
    c = lightSurface(o.color, n, o.world);
  }
  return vec4f(applyFog(c, o.world), 1.0);
}
`

export type LitPipelines = { solid: GPURenderPipeline; foliage: GPURenderPipeline }

/** Solid geometry culls back faces; foliage (single-sided leaves) draws both. */
export function createLitPipelines(ctx: PassContext, module: GPUShaderModule): LitPipelines {
  const layout = ctx.device.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout] })
  const make = (cullMode: GPUCullMode, label: string) =>
    ctx.device.createRenderPipeline({
      label,
      layout,
      vertex: { module, entryPoint: "vs", buffers: [MESH_LAYOUT] },
      fragment: { module, entryPoint: "fs", targets: [{ format: ctx.color }] },
      primitive: { topology: "triangle-list", cullMode, frontFace: "ccw" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: true, depthCompare: "greater-equal" },
      multisample: { count: ctx.samples },
    })
  return { solid: make("back", "lit-solid"), foliage: make("none", "lit-foliage") }
}

const half = (h: number): number => {
  const exp = (h >> 10) & 0x1f
  const mant = h & 0x3ff
  const v = exp === 0 ? mant * 2 ** -24 : exp === 31 ? Infinity : (1 + mant / 1024) * 2 ** (exp - 15)
  return h & 0x8000 ? -v : v
}

/**
 * Splits packed triangles into solid and foliage streams by the material of each triangle's first vertex, so each
 * can use its own cull mode. Returns the byte length of each part written into `solid` and `foliage`.
 */
export function splitFoliage(data: ArrayBuffer, solid: Uint8Array, solidAt: number, foliage: Uint8Array, foliageAt: number): [number, number] {
  const src = new Uint8Array(data)
  const h = new Uint16Array(data, 0, data.byteLength >> 1)
  const tri = VERT_BYTES * 3
  let s = solidAt
  let f = foliageAt
  for (let o = 0; o + tri <= data.byteLength; o += tri) {
    const mat = Math.round(half(h[(o + 20) >> 1]!))
    const part = src.subarray(o, o + tri)
    if (mat === MAT.foliage) {
      foliage.set(part, f)
      f += tri
    } else {
      solid.set(part, s)
      s += tri
    }
  }
  return [s - solidAt, f - foliageAt]
}
