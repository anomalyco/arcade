import { expect, test } from "bun:test"
import { batchHooks } from "../forest/shaders"
import { withPhysicalLights } from "./lights/physical"
import { validateWgsl } from "./test-naga"
import type { SceneVariant } from "./pass-graph"
import { makeSceneShader } from "./shaders"
import {
  TEXTURED_INST_LAYOUT, TEXTURED_VERTEX_LAYOUT, TexturedMeshPass, packTexturedVerts, propLookHooks, sceneHooksFor, texturedSceneShader,
  type SceneHookVariants,
} from "./textured-mesh"

const g = globalThis as Record<string, unknown>
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }
g.GPUBufferUsage ??= { VERTEX: 32, UNIFORM: 64, COPY_DST: 8 }

test("WGSL: texturedSceneShader compiles vsStatic, vsInst and fsSolid with physical lights and forest batchHooks", () => {
  const plain = texturedSceneShader({})
  expect(plain).toContain("@vertex fn vsInst(")
  validateWgsl(plain)

  const physical = texturedSceneShader(withPhysicalLights({ lampGrid: false }))
  expect(physical).toContain("pbrRough = rough; pbrMetal = metal;")
  validateWgsl(physical)

  const forest = texturedSceneShader(batchHooks)
  expect(forest).toContain("pbrRough = rough; pbrMetal = metal;")
  validateWgsl(forest)
})

test("TexturedMeshPass: instanced primitives bind TEXTURED_INST_LAYOUT, draw via vsInst, and pack SpotShadowInstances", () => {
  const createdPipelines: GPUVertexState[] = []
  const writes: { size: number; float0: number; float4: number }[] = []
  const draws: { vertexCount: number; instanceCount?: number }[] = []

  const fakeTex = { createView: () => ({}) as GPUTextureView } as unknown as GPUTexture
  const device = {
    createBindGroupLayout: () => ({}) as GPUBindGroupLayout,
    createPipelineLayout: () => ({}) as GPUPipelineLayout,
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }) as unknown as GPUShaderModule,
    createRenderPipeline: (desc: GPURenderPipelineDescriptor) => {
      createdPipelines.push(desc.vertex)
      return { label: desc.vertex.entryPoint } as unknown as GPURenderPipeline
    },
    createSampler: () => ({}) as GPUSampler,
    createBuffer: (desc: GPUBufferDescriptor) => ({ size: desc.size, destroy: () => {} }) as unknown as GPUBuffer,
    createBindGroup: () => ({}) as GPUBindGroup,
    queue: {
      writeBuffer: (_buf: GPUBuffer, _offset: number, data: ArrayBuffer | ArrayBufferView, byteOffset?: number, size?: number) => {
        if (data instanceof ArrayBuffer && typeof size === "number") {
          const f = new Float32Array(data, byteOffset ?? 0, size / 4)
          writes.push({ size, float0: f[0] ?? 0, float4: f[4] ?? 0 })
        }
      },
    },
  } as unknown as GPUDevice

  const ctx = {
    device,
    color: "rgba16float" as GPUTextureFormat,
    depth: "depth24plus" as GPUTextureFormat,
    samples: 1,
    frameLayout: {} as GPUBindGroupLayout,
  }

  const verts = new Float32Array(11 * 3)
  const uvs = new Float32Array(2 * 3)
  const packed = packTexturedVerts(verts, uvs)

  const inst = new Float32Array(24)
  // Instance 0: pos (10, 2, 30), yaw 0.5, tint (1, 1, 1), scale 1.25
  inst.set([10, 2, 30, 0.5, 1, 1, 1, 1.25, 0, 0, 1, 0], 0)
  // Instance 1: pos (20, 3, 40), yaw 1.5, tint (1, 1, 1), scale 0.8
  inst.set([20, 3, 40, 1.5, 1, 1, 1, 0.8, 0, 0, 1, 0], 12)

  const pass = new TexturedMeshPass(
    ctx,
    [
      {
        vertices: packed,
        instances: inst,
        base: fakeTex,
        normal: fakeTex,
        orm: fakeTex,
        color: [1, 1, 1, 1],
        roughness: 1,
        metalness: 1,
        normalScale: 1,
        blend: false,
      },
    ],
    {},
  )

  expect(createdPipelines.length).toBe(1)
  expect(createdPipelines[0]!.entryPoint).toBe("vsInst")
  expect(createdPipelines[0]!.buffers).toEqual([TEXTURED_VERTEX_LAYOUT, TEXTURED_INST_LAYOUT])

  const casters = pass.shadowCasters()
  expect(casters.length).toBe(1)
  expect(casters[0]!.count).toBe(3)
  expect(casters[0]!.instances?.count).toBe(2)
  // Shadow write should be 2 * 32 = 64 bytes with float0 = 10 and float4 (scaleXZ) = 1.25
  const shadowWrite = writes.find(w => w.size === 64)
  expect(shadowWrite).toBeDefined()
  expect(shadowWrite!.float0).toBeCloseTo(10, 5)
  expect(shadowWrite!.float4).toBeCloseTo(1.25, 5)

  const encoder = {
    setPipeline: () => {},
    setBindGroup: () => {},
    setVertexBuffer: () => {},
    draw: (vertexCount: number, instanceCount?: number) => draws.push({ vertexCount, instanceCount }),
  } as unknown as GPURenderPassEncoder

  pass.draw(encoder)
  expect(draws).toEqual([{ vertexCount: 3, instanceCount: 2 }])

  expect(() => pass.setAllInstances(inst, 1.5)).toThrow(RangeError)
  expect(() => pass.setAllInstances(inst, 3)).toThrow(RangeError)
  const tilted = inst.slice()
  tilted[8] = 0.25
  expect(() => pass.setAllInstances(tilted)).toThrow("yaw only")

  pass.setAllInstances(inst, 0)
  expect(pass.shadowCasters().length).toBe(0)
  pass.dispose()
})

test("makeSceneShader: instanceVertex appends to vsInst only, and leaves the shader text unchanged when unset", () => {
  expect(makeSceneShader({ instanceVertex: undefined })).toBe(makeSceneShader({}))
  const tinted = makeSceneShader({ instanceVertex: "o.color *= 2.0;" })
  expect(tinted).toContain("o.extra = inst.extra;\n  o.color *= 2.0;")
  expect(tinted.match(/o\.color \*= 2\.0;/g)).toHaveLength(1)
})

// Look variants need a game's declarations; Outbreak's own test compiles all four with these hooks.
test("WGSL: propLookHooks compiles on plain and physical hooks", () => {
  validateWgsl(texturedSceneShader(propLookHooks({})))
  validateWgsl(texturedSceneShader(propLookHooks(withPhysicalLights({ lampGrid: false }))))
})

test("TexturedMeshPass: SceneHookVariants follow the renderer's scene variant, one bind group layout for all", () => {
  const modules: string[] = []
  let layouts = 0
  const fakeTex = { createView: () => ({}) as GPUTextureView } as unknown as GPUTexture
  const device = {
    createBindGroupLayout: () => { layouts++; return {} as GPUBindGroupLayout },
    createPipelineLayout: () => ({}) as GPUPipelineLayout,
    createShaderModule: (desc: GPUShaderModuleDescriptor) => {
      modules.push(desc.code)
      return { code: desc.code, getCompilationInfo: async () => ({ messages: [] }) } as unknown as GPUShaderModule
    },
    createRenderPipeline: (desc: GPURenderPipelineDescriptor) => ({ code: (desc.vertex.module as unknown as { code: string }).code }) as unknown as GPURenderPipeline,
    createSampler: () => ({}) as GPUSampler,
    createBuffer: (desc: GPUBufferDescriptor) => ({ size: desc.size, destroy: () => {} }) as unknown as GPUBuffer,
    createBindGroup: () => ({}) as GPUBindGroup,
    queue: { writeBuffer: () => {} },
  } as unknown as GPUDevice
  let variant: SceneVariant = "plain"
  const ctx = { device, color: "rgba16float" as GPUTextureFormat, depth: "depth24plus" as GPUTextureFormat, samples: 1, frameLayout: {} as GPUBindGroupLayout, sceneVariant: () => variant }
  const hooks: SceneHookVariants = {
    plain: { material: "/* plain */" },
    look: v => ({ material: `/* look ${v} */` }),
  }
  const primitive = { vertices: packTexturedVerts(new Float32Array(33), new Float32Array(6)), base: fakeTex, normal: fakeTex, orm: fakeTex,
    color: [1, 1, 1, 1], roughness: 1, metalness: 0, normalScale: 1, blend: false }
  const pass = new TexturedMeshPass(ctx, [primitive], hooks)
  const pipelines: string[] = []
  const encoder = {
    setPipeline: (p: { code: string }) => pipelines.push(p.code),
    setBindGroup: () => {}, setVertexBuffer: () => {}, draw: () => {},
  } as unknown as GPURenderPassEncoder
  for (const v of ["plain", "noir", "painterly", "noir", "generic"] as const) { variant = v; pass.draw(encoder) }
  expect(pipelines.map(code => /\/\* (plain|look \w+) \*\//.exec(code)?.[1])).toEqual(["plain", "look noir", "look painterly", "look noir", "look generic"])
  expect(modules).toHaveLength(4)
  expect(layouts).toBe(1)
  // A second pass on the same renderer and hooks reuses every compiled variant.
  new TexturedMeshPass(ctx, [primitive], hooks).draw(encoder)
  expect(modules).toHaveLength(4)
  expect(sceneHooksFor(hooks, "noir")).toEqual({ material: "/* look noir */" })
  expect(sceneHooksFor({ plain: { material: "p" } }, "noir")).toEqual({ material: "p" })
})
