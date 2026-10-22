/**
 * GPU skinning for people: one compute dispatch per visible person writes its skinned triangles, in world space,
 * straight into the kit's textured vertex layout, and the stock textured scene pipeline draws them. So people get the
 * game's own lights, beams, fog, shadows and temporal resolve with no second lighting path. They are `MAT.actor`, so
 * they also get the cool fill and rim every game gives its blocky actors to read in the dark. A `ScenePass` for the
 * renderer's opaque slot.
 */
import { imageTexture } from "../gpu/gltf"
import type { PassContext, ScenePass } from "../gpu/pass-graph"
import type { SceneHooks } from "../gpu/shaders"
import type { SpotShadowCaster } from "../gpu/shadows/spot-shadows"
import { texturedPipelines } from "../gpu/textured-mesh"
import { MAT } from "../gpu/mesh"
import type { PersonAsset, PersonLod } from "./asset"

const SKIN_WGSL = /* wgsl */ `
struct Src { p: vec3f, j: u32, n: vec3f, kind: f32, w: vec4f, uv: vec2f, pad: vec2f }
struct Params { count: u32, mat: f32, pad0: f32, pad1: f32 }
@group(0) @binding(0) var<storage, read> src: array<Src>;
@group(0) @binding(1) var<storage, read> idx: array<u32>;
@group(0) @binding(2) var<storage, read> joints: array<mat4x4f>;
@group(0) @binding(3) var<storage, read_write> outv: array<u32>;
@group(0) @binding(4) var<uniform> prm: Params;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= prm.count) { return; }
  let s = src[idx[i]];
  let m = joints[s.j & 255u] * s.w.x + joints[(s.j >> 8u) & 255u] * s.w.y + joints[(s.j >> 16u) & 255u] * s.w.z + joints[s.j >> 24u] * s.w.w;
  let p = (m * vec4f(s.p, 1.0)).xyz;
  let rn = (m * vec4f(s.n, 0.0)).xyz;
  let n = select(vec3f(0.0, 1.0, 0.0), normalize(rn), dot(rn, rn) > 1e-12);
  let o = i * 8u;
  outv[o] = bitcast<u32>(p.x); outv[o + 1u] = bitcast<u32>(p.y); outv[o + 2u] = bitcast<u32>(p.z);
  outv[o + 3u] = pack4x8snorm(vec4f(n, 0.0));
  outv[o + 4u] = 0xffffffffu;
  outv[o + 5u] = pack2x16float(vec2f(prm.mat, s.kind));
  outv[o + 6u] = bitcast<u32>(s.uv.x); outv[o + 7u] = bitcast<u32>(s.uv.y);
}`

type GpuLod = { lod: PersonLod; source: GPUBuffer; indices: GPUBuffer }
type GpuMaterial = { base: GPUTexture; normal: GPUTexture; hasNormal: boolean }

/** A person's uploaded geometry and textures; spawn any number of instances from it. */
export type PersonModel = { asset: PersonAsset; lods: GpuLod[]; materials: GpuMaterial[]; dispose(): void }

type InstanceLod = { out: GPUBuffer; compute: GPUBindGroup; params: GPUBuffer; groups: GPUBindGroup[]; uniforms: GPUBuffer[] }

export class PersonInstance {
  /** 16 floats per joint: skinning matrices (world · inverse bind), from `skinMatrices`. */
  readonly matrices: Float32Array<ArrayBuffer>
  lod = 0
  visible = true
  readonly joints: GPUBuffer
  readonly lods: (InstanceLod | null)[]
  private tints = new Map<string, readonly number[]>()
  dirty = true
  constructor(readonly model: PersonModel, device: GPUDevice) {
    const n = model.asset.skeleton.names.length
    this.matrices = new Float32Array(n * 16)
    for (let i = 0; i < n; i++) this.matrices[i * 16] = this.matrices[i * 16 + 5] = this.matrices[i * 16 + 10] = this.matrices[i * 16 + 15] = 1
    this.joints = device.createBuffer({ size: n * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.lods = model.lods.map(() => null)
  }
  /** Tints an outfit piece (`jacket`, `trousers`, `beanie`, `hair`, ...) with a linear albedo; `null` restores the default. */
  tint(piece: string, albedo: readonly [number, number, number] | null): void {
    if (albedo) this.tints.set(piece, albedo)
    else this.tints.delete(piece)
    this.dirty = true
  }
  materialColor(i: number): number[] {
    const m = this.model.asset.materials[i]!
    const t = this.tints.get(m.piece)
    return t ? [...t.map((c) => Math.min(4, c / m.mean)), 1] : [...m.color]
  }
}

export class PeoplePass implements ScenePass {
  private readonly device: GPUDevice
  private readonly pipes: ReturnType<typeof texturedPipelines>
  private readonly computePipeline: GPUComputePipeline
  private readonly sampler: GPUSampler
  private readonly white: GPUTexture
  private readonly flat: GPUTexture
  private instances: PersonInstance[] = []

  constructor(ctx: PassContext, hooks: SceneHooks) {
    const d = (this.device = ctx.device)
    this.pipes = texturedPipelines(ctx, hooks)
    this.computePipeline = d.createComputePipeline({ layout: "auto", compute: { module: d.createShaderModule({ code: SKIN_WGSL, label: "people skinning" }), entryPoint: "main" } })
    this.sampler = d.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat", maxAnisotropy: 8 })
    const solid = (rgba: number[], format: GPUTextureFormat) => {
      const t = d.createTexture({ size: [1, 1], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
      d.queue.writeTexture({ texture: t }, new Uint8Array(rgba), {}, [1, 1])
      return t
    }
    this.white = solid([255, 255, 255, 255], "rgba8unorm")
    this.flat = solid([128, 128, 255, 255], "rgba8unorm")
  }

  /** Uploads a person's geometry and textures. */
  async upload(asset: PersonAsset): Promise<PersonModel> {
    const d = this.device
    const textures: GPUTexture[] = []
    const cache = new Map<unknown, Promise<GPUTexture>>()
    const tex = (t: PersonAsset["materials"][number]["base"], srgb: boolean, normal: boolean) => {
      if (!t) return Promise.resolve(normal ? this.flat : this.white)
      let loaded = cache.get(t)
      if (!loaded) {
        loaded = imageTexture(d, t.getImage()!, srgb, t.getMimeType(), undefined, normal).then((g) => { textures.push(g); return g })
        cache.set(t, loaded)
      }
      return loaded
    }
    const materials = await Promise.all(asset.materials.map(async (m) => ({ base: await tex(m.base, true, false), normal: await tex(m.normal, false, true), hasNormal: !!m.normal })))
    const lods = asset.lods.map((lod) => {
      const source = d.createBuffer({ size: lod.source.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(source, 0, lod.source)
      const indices = d.createBuffer({ size: lod.indices.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(indices, 0, lod.indices)
      return { lod, source, indices }
    })
    return { asset, lods, materials, dispose: () => { textures.forEach((t) => t.destroy()); lods.forEach((l) => { l.source.destroy(); l.indices.destroy() }) } }
  }

  spawn(model: PersonModel): PersonInstance {
    const inst = new PersonInstance(model, this.device)
    this.instances.push(inst)
    return inst
  }

  remove(inst: PersonInstance): void {
    const i = this.instances.indexOf(inst)
    if (i < 0) return
    this.instances.splice(i, 1)
    inst.joints.destroy()
    for (const l of inst.lods) if (l) { l.out.destroy(); l.params.destroy(); l.uniforms.forEach((u) => u.destroy()) }
  }

  private lodFor(inst: PersonInstance): InstanceLod {
    const li = Math.min(inst.lod, inst.model.lods.length - 1)
    let l = inst.lods[li]
    if (l) return l
    const d = this.device, g = inst.model.lods[li]!
    const out = d.createBuffer({ size: g.lod.indices.length * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX })
    const params = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const p = new ArrayBuffer(16)
    new Uint32Array(p)[0] = g.lod.indices.length
    new Float32Array(p)[1] = MAT.actor
    d.queue.writeBuffer(params, 0, p)
    const compute = d.createBindGroup({ layout: this.computePipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: g.source } }, { binding: 1, resource: { buffer: g.indices } },
      { binding: 2, resource: { buffer: inst.joints } }, { binding: 3, resource: { buffer: out } }, { binding: 4, resource: { buffer: params } },
    ] })
    const uniforms: GPUBuffer[] = [], groups: GPUBindGroup[] = []
    for (const r of g.lod.ranges) {
      const m = inst.model.materials[r.material]!
      const u = d.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      uniforms.push(u)
      groups.push(d.createBindGroup({ layout: this.pipes.layout, entries: [
        { binding: 0, resource: m.base.createView() }, { binding: 1, resource: m.normal.createView() },
        { binding: 2, resource: this.white.createView() }, { binding: 3, resource: this.sampler }, { binding: 4, resource: { buffer: u } },
        { binding: 5, resource: this.white.createView() },
      ] }))
    }
    l = { out, compute, params, groups, uniforms }
    inst.lods[li] = l
    inst.dirty = true
    return l
  }

  private writeMaterials(inst: PersonInstance): void {
    for (const [li, l] of inst.lods.entries()) {
      if (!l) continue
      inst.model.lods[li]!.lod.ranges.forEach((r, k) => {
        const m = inst.model.asset.materials[r.material]!
        const hasNormal = inst.model.materials[r.material]!.hasNormal
        this.device.queue.writeBuffer(l.uniforms[k]!, 0, new Float32Array([...inst.materialColor(r.material), m.roughness, 0, hasNormal ? 1 : 0, m.alphaCutoff, 0, 0, 0, 0]))
      })
    }
    inst.dirty = false
  }

  prepare(enc: GPUCommandEncoder): void {
    const live = this.instances.filter((i) => i.visible)
    if (!live.length) return
    for (const inst of live) {
      this.lodFor(inst)
      if (inst.dirty) this.writeMaterials(inst)
      this.device.queue.writeBuffer(inst.joints, 0, inst.matrices)
    }
    const pass = enc.beginComputePass({ label: "people skinning" })
    pass.setPipeline(this.computePipeline)
    for (const inst of live) {
      const l = this.lodFor(inst), n = inst.model.lods[Math.min(inst.lod, inst.model.lods.length - 1)]!.lod.indices.length
      pass.setBindGroup(0, l.compute)
      pass.dispatchWorkgroups(Math.ceil(n / 64))
    }
    pass.end()
  }

  draw(pass: GPURenderPassEncoder): void {
    for (const masked of [false, true]) {
      let bound = false
      for (const inst of this.instances) {
        if (!inst.visible) continue
        const li = Math.min(inst.lod, inst.model.lods.length - 1), l = inst.lods[li]
        if (!l) continue
        const ranges = inst.model.lods[li]!.lod.ranges
        for (const [k, r] of ranges.entries()) {
          const m = inst.model.asset.materials[r.material]!
          if ((m.alphaCutoff > 0) !== masked) continue
          if (!bound) { pass.setPipeline(this.pipes.pipeline(false, masked)); bound = true }
          pass.setVertexBuffer(0, l.out)
          pass.setBindGroup(1, l.groups[k]!)
          pass.draw(r.count, 1, r.start)
        }
      }
    }
  }

  /** Opaque skinned triangles of every visible person (or of `only`), for spot/beam shadow maps. */
  shadowCasters(only?: readonly PersonInstance[]): SpotShadowCaster[] {
    const out: SpotShadowCaster[] = []
    for (const inst of only ?? this.instances) {
      if (!inst.visible) continue
      const li = Math.min(inst.lod, inst.model.lods.length - 1), l = inst.lods[li]
      if (!l) continue
      const ranges = inst.model.lods[li]!.lod.ranges
      const opaque = ranges.filter((r) => inst.model.asset.materials[r.material]!.alphaCutoff <= 0)
      const count = opaque.length ? opaque[opaque.length - 1]!.start + opaque[opaque.length - 1]!.count : 0
      if (count) out.push({ buffer: l.out, count, stride: 32 })
    }
    return out
  }

  dispose(): void {
    for (const inst of [...this.instances]) this.remove(inst)
    this.white.destroy(); this.flat.destroy()
  }
}
