import { makeSceneShader, type SceneHooks } from "./shaders"
import { compileShaderModuleWithLog, type PassContext, type ScenePass } from "./pass-graph"
import { packVerts } from "./mesh"
import type { SpotShadowCaster } from "./shadows/spot-shadows"

/** Append UVs without changing the established compact vertex ABI. */
export function packTexturedVerts(vertices: ArrayLike<number>, uv: ArrayLike<number>): ArrayBuffer {
  const count = vertices.length / 11
  if (!Number.isInteger(count) || uv.length !== count * 2) throw new Error("Texture UV count must match vertices")
  const compact = new Uint8Array(packVerts(vertices))
  const result = new ArrayBuffer(count * 32), bytes = new Uint8Array(result), floats = new Float32Array(result)
  for (let i = 0; i < count; i++) {
    bytes.set(compact.subarray(i * 24, i * 24 + 24), i * 32)
    floats[i * 8 + 6] = uv[i * 2]!
    floats[i * 8 + 7] = uv[i * 2 + 1]!
  }
  return result
}

/** Compact kit vertices with an optional full-precision UV pair appended. */
export const TEXTURED_VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 32,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "snorm8x4" },
    { shaderLocation: 2, offset: 16, format: "unorm8x4" },
    { shaderLocation: 3, offset: 20, format: "float16x2" },
    { shaderLocation: 4, offset: 24, format: "float32x2" },
  ],
}

export type TexturedPrimitive = {
  vertices: ArrayBuffer
  base: GPUTexture
  normal: GPUTexture
  orm: GPUTexture
  ao?: GPUTexture
  aoStrength?: number
  alphaCutoff?: number
  color: readonly number[]
  roughness: number
  metalness: number
  normalScale: number
  blend: boolean
}

export function texturedSceneShader(hooks: SceneHooks, masked = false): string {
  return makeSceneShader({ ...hooks, uv: true,
    declarations: `${hooks.declarations ?? ""}
      @group(1) @binding(0) var baseMap: texture_2d<f32>;
      @group(1) @binding(1) var normalMap: texture_2d<f32>;
      @group(1) @binding(2) var ormMap: texture_2d<f32>;
      @group(1) @binding(3) var texSampler: sampler;
       @group(1) @binding(5) var aoMap: texture_2d<f32>;
       struct Material { color: vec4f, surface: vec4f, flags: vec4f }
      @group(1) @binding(4) var<uniform> Mtl: Material;
       var<private> texBase: vec4f;
       var<private> texNormalVariance: f32;
       var<private> texOrm: vec3f;
       var<private> texAo: f32;
       var<private> texNormal: vec3f;`,
    fragmentStart: `
      texBase = textureSample(baseMap, texSampler, o.uv) * Mtl.color;
       texOrm = textureSample(ormMap, texSampler, o.uv).rgb;
       texAo = textureSample(aoMap, texSampler, o.uv).r;
       let tn = textureSample(normalMap, texSampler, o.uv).xyz * 2.0 - 1.0;
       let normalLength = clamp(length(tn), 0.001, 1.0);
       texNormalVariance = min((1.0 - normalLength) / normalLength, 1.0) * Mtl.surface.z * Mtl.surface.z;
      let dp1 = dpdx(o.world); let dp2 = dpdy(o.world);
      let du1 = dpdx(o.uv); let du2 = dpdy(o.uv);
      let texGeometricNormal = normalize(o.normal);
      let p1 = cross(dp2, texGeometricNormal); let p2 = cross(texGeometricNormal, dp1);
      let T = p1 * du1.x + p2 * du2.x;
      let B = p1 * du1.y + p2 * du2.y;
      let inv = inverseSqrt(max(max(dot(T,T), dot(B,B)), 1e-12));
       texNormal = normalize((T * tn.x + B * tn.y) * inv * Mtl.surface.z + texGeometricNormal * tn.z);
       ${masked ? "if (texBase.a < Mtl.surface.w) { discard; }" : ""}
      ${hooks.fragmentStart ?? ""}`,
    material: `
      albedo = texBase.rgb * o.color;
       alpha = select(1.0, texBase.a, Mtl.flags.y > 0.5);
      n = texNormal;
       let rough = pow(min(pow(max(0.08, texOrm.g * Mtl.surface.x), 4.0) + texNormalVariance, 1.0), 0.25);
      let metal = texOrm.b * Mtl.surface.y;
       gloss = vec2f(min(240.0, 2.0 / pow(rough, 4.0)), mix(0.08, 0.8, metal) * (1.0 - rough * 0.65));
       ${hooks.material ?? ""}`,
    ambient: `(${hooks.ambient ?? "ambientAt(n)"}) * mix(1.0, texAo, Mtl.flags.x)`,
  })
}

// Material/geometry buffers belong to each pass; identical shaders and fixed render state belong to the renderer.
export type TexturedPipelines = { layout: GPUBindGroupLayout; pipeline: (blend: boolean, masked?: boolean) => GPURenderPipeline }
const pipelineCache = new WeakMap<PassContext, Map<string, TexturedPipelines>>()
/** Cached textured scene pipelines (opaque, blended, alpha-tested) and their material bind group layout, per renderer and hooks. */
export function texturedPipelines(ctx: PassContext, hooks: SceneHooks): TexturedPipelines {
  let cache = pipelineCache.get(ctx)
  if (!cache) { cache = new Map(); pipelineCache.set(ctx, cache) }
  const code = texturedSceneShader(hooks), cached = cache.get(code)
  if (cached) return cached
  const d = ctx.device
  const layout = d.createBindGroupLayout({ entries: [
    ...[0, 1, 2, 5].map(binding => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: {} })),
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
  ] })
  const module = compileShaderModuleWithLog(d, code, "textured scene")
  const pipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, layout] })
  const variants = new Map<string, GPURenderPipeline>()
  const pipeline = (blend: boolean, masked = false) => {
    const key = `${blend}:${masked}`, cached = variants.get(key)
    if (cached) return cached
    const result = d.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: "vsStatic", buffers: [TEXTURED_VERTEX_LAYOUT] },
      fragment: { module: masked ? compileShaderModuleWithLog(d, texturedSceneShader(hooks, true), "masked textured scene") : module, entryPoint: "fsSolid", targets: [{ format: ctx.color, ...(blend ? { blend: {
        color: { srcFactor: "one" as const, dstFactor: "one-minus-src-alpha" as const },
        alpha: { srcFactor: "one" as const, dstFactor: "one-minus-src-alpha" as const },
      } } : {}) }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: !blend, depthCompare: ctx.depthCompare ?? "less-equal" },
      multisample: { count: ctx.samples },
    })
    variants.set(key, result)
    return result
  }
  const result = { layout, pipeline }
  cache.set(code, result)
  return result
}

/** Imported meshes share the kit's lights, polar shadows, scene hooks, HDR target and temporal resolve. */
export class TexturedMeshPass implements ScenePass {
  private draws: { buffer: GPUBuffer; uniform: GPUBuffer; group: GPUBindGroup; count: number; blend: boolean; masked: boolean }[] = []
  private opaque: GPURenderPipeline | null
  private alpha: GPURenderPipeline | null
  private mask: GPURenderPipeline | null
  constructor(ctx: PassContext, primitives: TexturedPrimitive[], hooks: SceneHooks) {
    const d = ctx.device, { layout, pipeline } = texturedPipelines(ctx, hooks)
    // Each imported pass has a fixed draw list. Avoid compiling unused variants (especially costly on SwiftShader).
    this.opaque = primitives.some(p => !p.blend && (p.alphaCutoff ?? 0) <= 0) ? pipeline(false) : null
    this.alpha = primitives.some(p => p.blend && (p.alphaCutoff ?? 0) <= 0) ? pipeline(true) : null
    this.mask = primitives.some(p => (p.alphaCutoff ?? 0) > 0) ? pipeline(false, true) : null
    const sampler = d.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat", maxAnisotropy: 8 })
    for (const p of primitives) {
      const buffer = d.createBuffer({ size: p.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(buffer, 0, p.vertices)
      const uniform = d.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(uniform, 0, new Float32Array([...p.color, p.roughness, p.metalness, p.normalScale, p.alphaCutoff ?? 0, p.aoStrength ?? 0, Number(p.blend), 0, 0]))
      const group = d.createBindGroup({ layout, entries: [
        { binding: 0, resource: p.base.createView() }, { binding: 1, resource: p.normal.createView() },
        { binding: 2, resource: p.orm.createView() }, { binding: 3, resource: sampler }, { binding: 4, resource: { buffer: uniform } },
        { binding: 5, resource: (p.ao ?? p.orm).createView() },
      ] })
      this.draws.push({ buffer, uniform, group, count: p.vertices.byteLength / 32, blend: p.blend, masked: (p.alphaCutoff ?? 0) > 0 })
    }
  }
  draw(pass: GPURenderPassEncoder) {
    for (const blend of [false, true]) {
      for (const draw of this.draws) if (draw.blend === blend) {
        pass.setPipeline(draw.masked ? this.mask! : blend ? this.alpha! : this.opaque!)
        pass.setBindGroup(1, draw.group); pass.setVertexBuffer(0, draw.buffer)
        pass.draw(draw.count)
      }
    }
  }
  /** Opaque imported casters only; cutout foliage needs a matching alpha-aware depth shader. */
  shadowCasters(): SpotShadowCaster[] {
    return this.draws.filter(d=>!d.blend && !d.masked).map(d=>({buffer:d.buffer,count:d.count,stride:32}))
  }
  dispose() { for (const draw of this.draws) { draw.buffer.destroy(); draw.uniform.destroy() }; this.draws = [] }
}
