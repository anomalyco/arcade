import { BufferGeometry, Color, Matrix3, Matrix4, Vector3, Mesh, InstancedMesh, type Material, type Object3D } from "three/webgpu"
import { MAT, type Mat } from "@arcade/kit/gpu/mesh"
import { packTexturedVerts, texturedPipelines, type TexturedPrimitive } from "@arcade/kit/gpu/textured-mesh"
import type { PassContext, ScenePass } from "@arcade/kit/gpu/pass-graph"
import type { SceneHooks } from "@arcade/kit/gpu/shaders"
import type { SpotShadowCaster } from "@arcade/kit/gpu/shadows/spot-shadows"

export type BridgeSurface = Omit<TexturedPrimitive, "vertices" | "instances" | "instanceCount"> & { mat?: Mat; aux?: number }
/** The caller owns textures. TSL recipes must be mapped explicitly, not flattened to a material's fallback colour. */
export type SurfaceResolver = (material: Material) => Promise<BridgeSurface>
type Span = { start: number; count: number }

export function packWorldGeometry(geometry: BufferGeometry, matrix: Matrix4, span?: Span, mat: Mat = MAT.lit, aux = 0, instanceColor = new Color(1, 1, 1)): ArrayBuffer {
  const p = geometry.getAttribute("position"), n = geometry.getAttribute("normal")
  if (!p || !n) throw new Error("World bridge requires positions and normals")
  const uv = geometry.getAttribute("uv"), color = geometry.getAttribute("color"), index = geometry.index
  if ((p.count && !p.array.length) || (n.count && !n.array.length) || (index?.count && !index.array.length)) throw new Error("Build the native bridge before Ashwood releases CPU geometry after upload")
  const total = index?.count ?? p.count
  const start = Math.max(span?.start ?? 0, geometry.drawRange.start)
  const end = Math.min(total, (span?.start ?? 0) + (span?.count ?? total), geometry.drawRange.start + geometry.drawRange.count)
  if (start % 3 || (end - start) % 3) throw new Error("World bridge requires triangle-aligned draw ranges")
  const vertices: number[] = [], uvs: number[] = []
  const normalMatrix = new Matrix3().getNormalMatrix(matrix), pos = new Vector3(), normal = new Vector3(), tint = new Color()
  for (let i = start; i < end; i++) {
    const at = index ? index.getX(i) : i
    pos.fromBufferAttribute(p, at).applyMatrix4(matrix)
    normal.fromBufferAttribute(n, at).applyMatrix3(normalMatrix).normalize()
    if (color) tint.setRGB(color.getX(at), color.getY(at), color.getZ(at))
    else tint.setRGB(1, 1, 1)
    tint.multiply(instanceColor).convertLinearToSRGB()
    vertices.push(pos.x, pos.y, pos.z, normal.x, normal.y, normal.z, tint.r, tint.g, tint.b, mat, aux)
    uvs.push(uv?.getX(at) ?? 0, uv?.getY(at) ?? 0)
  }
  return packTexturedVerts(vertices, uvs)
}

/** Interior Builder merges paints with different roughness/metalness into one `rm` attribute.
 * Bucket its triangles by finish, retaining shared position/normal/UV arrays instead of flattening every paint. */
export function surfaceSections(geometry: BufferGeometry, span: Span): { geometry: BufferGeometry; span: Span; roughness?: number; metalness?: number }[] {
  const rm = geometry.getAttribute("rm")
  if (!rm) return [{ geometry, span }]
  if (rm.count && !rm.array.length) throw new Error("Interior paint attributes were released before native conversion")
  const index = geometry.index, count = index?.count ?? geometry.getAttribute("position").count
  const start = Math.max(span.start, geometry.drawRange.start), end = Math.min(count, span.start + span.count, geometry.drawRange.start + geometry.drawRange.count)
  const groups = new Map<string, { roughness: number; metalness: number; indices: number[] }>()
  for (let i = start; i < end; i += 3) {
    const ids = [0, 1, 2].map(k => index?.getX(i + k) ?? i + k)
    const roughness = rm.getX(ids[0]), metalness = rm.getY(ids[0])
    if (ids.some(at => rm.getX(at) !== roughness || rm.getY(at) !== metalness)) throw new Error("Interpolated paint finish needs a native material recipe")
    const key = `${roughness}:${metalness}`
    let group = groups.get(key)
    if (!group) { group = { roughness, metalness, indices: [] }; groups.set(key, group) }
    group.indices.push(...ids)
  }
  return [...groups.values()].map(group => {
    const part = new BufferGeometry()
    for (const [name, attribute] of Object.entries(geometry.attributes)) part.setAttribute(name, attribute)
    part.setIndex(group.indices)
    return { geometry: part, span: { start: 0, count: group.indices.length }, roughness: group.roughness, metalness: group.metalness }
  })
}

export function visibleInHierarchy(object: Object3D): boolean {
  for (let p: Object3D | null = object; p; p = p.parent) if (!p.visible) return false
  return true
}

type Draw = {
  object: Mesh
  instance?: number
  span?: Span
  surface: BridgeSurface
  material: Material
  geometry: BufferGeometry
  tint: Color
  matrix: Matrix4
  vertices: GPUBuffer
  uniform: GPUBuffer
  group: GPUBindGroup
  count: number
  visible: boolean
}

/** Snapshots a built world after Builder.flush/bakeModels, then follows visibility and rigid transforms.
 * Geometry edits/late model loads require rebuilding the bridge; no world coordinates or colliders are reauthored. */
export class WorldBridge {
  readonly opaque: ScenePass
  readonly alpha: ScenePass
  private readonly draws: Draw[] = []
  private readonly pipelines: ReturnType<typeof texturedPipelines>
  private readonly matrix = new Matrix4()
  private readonly instanceMatrix = new Matrix4()

  private constructor(private readonly ctx: PassContext, private readonly root: Object3D, hooks: SceneHooks) {
    this.pipelines = texturedPipelines(ctx, hooks)
    this.opaque = { prepare: () => this.sync(), draw: pass => this.draw(pass, false) }
    this.alpha = { draw: pass => this.draw(pass, true) }
  }

  static async create(ctx: PassContext, root: Object3D, resolve: SurfaceResolver, hooks: SceneHooks, include: (mesh: Mesh) => boolean = () => true): Promise<WorldBridge> {
    const bridge = new WorldBridge(ctx, root, hooks)
    const meshes: Mesh[] = []
    root.updateWorldMatrix(true, true)
    root.traverse(node => { if (node instanceof Mesh && include(node)) meshes.push(node) })
    const materials = new Map<Material, BridgeSurface>()
    try {
      for (const object of meshes) {
        if ("isSkinnedMesh" in object || object.morphTargetInfluences?.length) throw new Error(`World bridge needs a rigid mesh: ${object.name}`)
        const list = Array.isArray(object.material) ? object.material : [object.material]
        const groups = Array.isArray(object.material) ? object.geometry.groups : [{ start: 0, count: Infinity, materialIndex: 0 }]
        for (const group of groups) {
          const material = list[group.materialIndex ?? 0]
          if (!material) throw new Error(`Missing material on ${object.name}`)
          let surface = materials.get(material)
          if (!surface) { surface = await resolve(material); materials.set(material, surface) }
          const count = object instanceof InstancedMesh ? object.count : 1
          for (const section of surfaceSections(object.geometry, group)) {
            const finish = section.roughness === undefined ? surface : { ...surface, roughness: section.roughness, metalness: section.metalness! }
            for (let i = 0; i < count; i++) bridge.add(object, section.geometry, material, finish, section.span, object instanceof InstancedMesh ? i : undefined)
          }
        }
      }
      bridge.sync()
      return bridge
    } catch (error) { bridge.dispose(); throw error }
  }

  private worldMatrix(object: Mesh, instance?: number): Matrix4 {
    this.matrix.copy(object.matrixWorld)
    if (object instanceof InstancedMesh && instance !== undefined) {
      object.getMatrixAt(instance, this.instanceMatrix)
      this.matrix.multiply(this.instanceMatrix)
    }
    return this.matrix
  }

  private add(object: Mesh, geometry: BufferGeometry, material: Material, surface: BridgeSurface, span: Span, instance?: number) {
    const d = this.ctx.device, matrix = this.worldMatrix(object, instance).clone()
    const tint = new Color(1, 1, 1)
    if (object instanceof InstancedMesh && object.instanceColor && instance !== undefined) object.getColorAt(instance, tint)
    const packed = packWorldGeometry(geometry, matrix, span, surface.mat, surface.aux, tint)
    if (!packed.byteLength) return
    const vertices = d.createBuffer({ size: packed.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(vertices, 0, packed)
    const uniform = d.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(uniform, 0, new Float32Array([...surface.color, surface.roughness, surface.metalness, surface.normalScale, surface.alphaCutoff ?? 0, surface.aoStrength ?? 0, Number(surface.blend), 0, 0]))
    const sampler = d.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat" })
    const group = d.createBindGroup({ layout: this.pipelines.layout, entries: [
      { binding: 0, resource: surface.base.createView() }, { binding: 1, resource: surface.normal.createView() },
      { binding: 2, resource: surface.orm.createView() }, { binding: 3, resource: sampler },
      { binding: 4, resource: { buffer: uniform } }, { binding: 5, resource: (surface.ao ?? surface.orm).createView() },
    ] })
    this.draws.push({ object, geometry, tint, instance, span, surface, material, matrix, vertices, uniform, group, count: packed.byteLength / 32, visible: true })
  }

  sync(): void {
    this.root.updateWorldMatrix(true, true)
    for (const draw of this.draws) {
      draw.visible = draw.material.visible && visibleInHierarchy(draw.object) && (!(draw.object instanceof InstancedMesh) || draw.instance! < draw.object.count)
      const matrix = this.worldMatrix(draw.object, draw.instance)
      const tint = new Color(1, 1, 1)
      if (draw.object instanceof InstancedMesh && draw.object.instanceColor && draw.instance !== undefined) draw.object.getColorAt(draw.instance, tint)
      if (matrix.equals(draw.matrix) && tint.equals(draw.tint)) continue
      draw.matrix.copy(matrix)
      draw.tint.copy(tint)
      const packed = packWorldGeometry(draw.geometry, matrix, draw.span, draw.surface.mat, draw.surface.aux, tint)
      this.ctx.device.queue.writeBuffer(draw.vertices, 0, packed)
    }
  }

  private draw(pass: GPURenderPassEncoder, blend: boolean) {
    for (const draw of this.draws) {
      if (!draw.visible || draw.surface.blend !== blend) continue
      pass.setPipeline(this.pipelines.pipeline(blend, (draw.surface.alphaCutoff ?? 0) > 0))
      pass.setBindGroup(1, draw.group)
      pass.setVertexBuffer(0, draw.vertices)
      pass.draw(draw.count)
    }
  }

  shadowCasters(): SpotShadowCaster[] {
    return this.draws.filter(d => d.visible && d.object.castShadow && !d.surface.blend && !d.surface.alphaCutoff)
      .map(d => ({ buffer: d.vertices, count: d.count, stride: 32 }))
  }

  get meshCount() { return this.draws.length }

  dispose(): void {
    for (const draw of this.draws) { draw.vertices.destroy(); draw.uniform.destroy() }
    this.draws.length = 0
  }
}
