import {
  LOOK_GROUPS,
  LOOK_PRESETS,
  LOOK_PRESET_IDS,
  LOOK_UNIFORM_FLOATS,
  applyLookPreset,
  createLookControls,
  createLookSettings,
  exportLookPreset,
  importLookPreset,
  isLookPresetId,
  packLookUniforms,
  randomizeLookSettings,
  resolveLookGroup,
  resolveLookPresetId,
  type LookCompareMode,
  type LookGroup,
  type LookPresetId,
  type LookSettings,
} from "../gpu/look"
import { SURFACE_TEX_UNIFORM_FLOATS } from "../gpu/surface-materials"
import { createFallbackMaterialTextureArray, createMaterialSampler } from "../textures/loader"
import type { LabControl } from "../lab-panel"
import { buildLookDebugRoomMesh, lookRoomPostShader, lookRoomSceneShader } from "./looks-room"
import type { LabContext, LabSection, LabWorldObject } from "./types"

export { buildLookDebugRoomMesh, isLookPresetId }

export type LookLabController = {
  section: LabSection
  getLookSettings: () => LookSettings
  applyPreset: (preset: LookPresetId) => LookSettings
  setParam: (key: string, value: number | string | boolean) => { key: string; before: unknown; value: unknown }
  randomizeGroup: (group?: LookGroup | "all", seed?: number) => { group: string; tuningSeed: number; roomSeed: number; settings: LookSettings }
  exportPresetJson: () => string
  importPresetJson: (raw: string | unknown) => { ok: true } | { ok: false; error: string }
}

export function createLooksSection(context: LabContext): LookLabController {
  const { device, stage } = context
  const lookState: LookSettings = createLookSettings("current")

  const settings: Record<string, string | number | boolean> = {
    preset: "current",
    compare: 1,
    wipeSplit: 0.5,
    roomSeed: 7,
    tuningSeed: 108,
  }

  for (const key of Object.keys(lookState) as (keyof LookSettings)[]) {
    if (key === "preset") continue
    Object.defineProperty(settings, key, {
      configurable: true,
      enumerable: true,
      get: () => lookState[key],
      set: (val: number | boolean) => {
        ;(lookState as Record<string, unknown>)[key] = val
      },
    })
  }
  Object.defineProperty(settings, "preset", {
    configurable: true,
    enumerable: true,
    get: () => lookState.preset,
    set: (val: string) => {
      const pid = resolveLookPresetId(val) ?? "current"
      lookState.preset = pid
    },
  })

  const frameBuffer = device.createBuffer({
    size: 148 * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const lookUniformData = new Float32Array(LOOK_UNIFORM_FLOATS)
  const lookUniformBuffer = device.createBuffer({
    size: lookUniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const surfaceTexBuffer = device.createBuffer({
    size: SURFACE_TEX_UNIFORM_FLOATS * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const fallbackTex = createFallbackMaterialTextureArray(device)
  const materialSampler = createMaterialSampler(device)

  const sceneBindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 10, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
      { binding: 11, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 12, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ],
  })
  const sceneBindGroup = device.createBindGroup({
    layout: sceneBindLayout,
    entries: [
      { binding: 0, resource: { buffer: frameBuffer } },
      { binding: 1, resource: { buffer: lookUniformBuffer } },
      { binding: 10, resource: fallbackTex.view },
      { binding: 11, resource: materialSampler },
      { binding: 12, resource: { buffer: surfaceTexBuffer } },
    ],
  })

  const sceneModule = device.createShaderModule({ code: lookRoomSceneShader, label: "Lab looks debug room scene" })
  const scenePipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sceneBindLayout] }),
    vertex: {
      module: sceneModule,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: 40,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x3" },
            { shaderLocation: 3, offset: 36, format: "float32" },
          ],
        },
      ],
    },
    fragment: {
      module: sceneModule,
      entryPoint: "fs",
      targets: [{ format: "rgba16float" }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less-equal" },
    multisample: { count: 4 },
  })

  const normalDepthPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sceneBindLayout] }),
    vertex: {
      module: sceneModule,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: 40,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x3" },
            { shaderLocation: 3, offset: 36, format: "float32" },
          ],
        },
      ],
    },
    fragment: {
      module: sceneModule,
      entryPoint: "fsNormalDepth",
      targets: [{ format: "rgba16float" }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less-equal" },
  })

  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
  const postBindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    ],
  })
  const postModule = device.createShaderModule({ code: lookRoomPostShader, label: "Lab looks post composite" })
  const postPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [postBindLayout] }),
    vertex: { module: postModule, entryPoint: "vs" },
    fragment: { module: postModule, entryPoint: "post", targets: [{ format: "rgba16float" }] },
    primitive: { topology: "triangle-list" },
  })

  let copyTex: GPUTexture | null = null
  let normalDepthTex: GPUTexture | null = null
  let normalDepthView: GPUTextureView | null = null
  let auxDepthTex: GPUTexture | null = null
  let auxDepthView: GPUTextureView | null = null
  let copyBindGroup: GPUBindGroup | null = null
  let copyW = 0
  let copyH = 0

  const ensureCopyTexture = (w: number, h: number) => {
    if (copyTex && copyW === w && copyH === h) return
    copyTex?.destroy()
    normalDepthTex?.destroy()
    auxDepthTex?.destroy()
    copyW = w
    copyH = h
    copyTex = device.createTexture({
      size: [w, h],
      format: "rgba16float",
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    })
    normalDepthTex = device.createTexture({
      size: [w, h],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    normalDepthView = normalDepthTex.createView()
    auxDepthTex = device.createTexture({
      size: [w, h],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    auxDepthView = auxDepthTex.createView()
    copyBindGroup = device.createBindGroup({
      layout: postBindLayout,
      entries: [
        { binding: 0, resource: { buffer: frameBuffer } },
        { binding: 1, resource: { buffer: lookUniformBuffer } },
        { binding: 2, resource: copyTex.createView() },
        { binding: 3, resource: sampler },
        { binding: 4, resource: normalDepthView },
      ],
    })
  }

  let builtSeed = Number(settings.roomSeed)
  const createRoomBuffer = (seed: number) => {
    const verts = buildLookDebugRoomMesh(seed)
    const buf = device.createBuffer({
      size: Math.max(40, verts.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(buf, 0, verts.buffer, verts.byteOffset, verts.byteLength)
    return { buf, count: verts.length / 10 }
  }
  let roomMesh = createRoomBuffer(builtSeed)

  const rebuildRoomIfNeeded = () => {
    const nextSeed = Math.max(1, Math.min(999, Math.round(Number(settings.roomSeed) || 7)))
    if (nextSeed === builtSeed) return
    builtSeed = nextSeed
    roomMesh.buf.destroy()
    roomMesh = createRoomBuffer(builtSeed)
  }

  let savedStageGrade: { exposure: number; tone: number; saturation: number; temperature: number } | null = null
  let elapsed = 0

  const applyPreset = (presetId: LookPresetId): LookSettings => {
    applyLookPreset(lookState, presetId)
    context.sync()
    return lookState
  }

  const randomizeGroup = (group: LookGroup | "all" = "all", explicitSeed?: number) => {
    const seed = Math.max(1, Math.min(9999, Math.round(explicitSeed ?? (Number(settings.tuningSeed) || 108))))
    const next = randomizeLookSettings(lookState, seed, group)
    Object.assign(lookState, next)
    settings.tuningSeed = (seed % 9999) + 1
    context.sync()
    return {
      group,
      tuningSeed: seed,
      roomSeed: builtSeed,
      settings: { ...lookState },
    }
  }

  const setParam = (key: string, value: number | string | boolean) => {
    if (key === "preset") {
      const before = lookState.preset
      const pid = resolveLookPresetId(value)
      if (!pid) throw new Error(`Unknown look preset "${String(value)}". Valid presets: ${LOOK_PRESET_IDS.join(", ")}.`)
      applyPreset(pid)
      return { key: "preset", before, value: pid }
    }
    if (key === "compare") {
      const before = settings.compare
      const num = Number(value)
      settings.compare = num === 0 ? 0 : num === 2 ? 2 : 1
      context.sync()
      return { key: "compare", before, value: settings.compare }
    }
    if (key === "wipeSplit") {
      const before = settings.wipeSplit
      settings.wipeSplit = Math.max(0.05, Math.min(0.95, Number(value) || 0.5))
      context.sync()
      return { key: "wipeSplit", before, value: settings.wipeSplit }
    }
    if (key === "roomSeed") {
      const before = settings.roomSeed
      settings.roomSeed = Math.max(1, Math.min(999, Math.round(Number(value) || 7)))
      rebuildRoomIfNeeded()
      context.sync()
      return { key: "roomSeed", before, value: settings.roomSeed }
    }
    if (key === "tuningSeed") {
      const before = settings.tuningSeed
      settings.tuningSeed = Math.max(1, Math.min(9999, Math.round(Number(value) || 108)))
      context.sync()
      return { key: "tuningSeed", before, value: settings.tuningSeed }
    }
    if (!(key in lookState)) {
      throw new Error(`Unknown look parameter "${key}".`)
    }
    const before = (lookState as Record<string, unknown>)[key]
    if (key === "grainAnimated") {
      lookState.grainAnimated = Boolean(value)
    } else {
      const num = Number(value)
      if (!Number.isFinite(num)) throw new Error(`Parameter "${key}" requires a finite number.`)
      ;(lookState as Record<string, unknown>)[key] = num
    }
    context.sync()
    return { key, before, value: (lookState as Record<string, unknown>)[key] }
  }

  const controls: LabControl[] = [
    {
      key: "preset",
      label: "Style preset",
      group: "Debug Room",
      type: "select",
      options: LOOK_PRESET_IDS.map(id => ({ value: id, label: LOOK_PRESETS[id].label })),
      change: val => {
        const pid = resolveLookPresetId(val) ?? "current"
        applyPreset(pid)
      },
    },
    {
      key: "compare",
      label: "Comparison",
      group: "Debug Room",
      type: "select",
      options: [
        { value: 1, label: "Active look (After)" },
        { value: 0, label: "Current identity (Before)" },
        { value: 2, label: "A/B wipe vs Current" },
      ],
      change: () => context.sync(),
    },
    {
      key: "wipeSplit",
      label: "Wipe split",
      group: "Debug Room",
      type: "range",
      min: 0.05,
      max: 0.95,
      step: 0.01,
      unit: "",
      visible: s => Number(s.compare) === 2,
      change: () => context.sync(),
    },
    {
      key: "roomSeed",
      label: "Room seed",
      group: "Debug Room",
      type: "range",
      min: 1,
      max: 999,
      step: 1,
      unit: "",
      change: rebuildRoomIfNeeded,
    },
    {
      key: "tuningSeed",
      label: "Tuning seed",
      group: "Debug Room",
      type: "range",
      min: 1,
      max: 9999,
      step: 1,
      unit: "",
    },
    {
      key: "randomizeAll",
      label: "Randomize all look groups",
      group: "Debug Room",
      type: "action",
      run: () => {
        randomizeGroup("all")
      },
    },
    {
      key: "resetToCurrent",
      label: "Reset to Current (Identity)",
      group: "Debug Room",
      type: "action",
      run: () => {
        applyPreset("current")
      },
    },
    ...createLookControls(settings, {
      includePresetPicker: false,
      onChange: () => context.sync(),
      onRandomizeGroup: grp => {
        randomizeGroup(grp)
      },
    }),
  ]

  const roomObjects: readonly LabWorldObject[] = [
    { id: "specimen:character", label: "Character silhouette", category: "specimen", x: -0.35, y: 0.36, z: 0.15, radius: 0.7 },
    { id: "specimen:sphere-gloss", label: "Gloss calibration sphere", category: "specimen", x: -1.15, y: 1.24, z: -0.85, radius: 0.85 },
    { id: "specimen:sphere-matte", label: "Matte calibration sphere", category: "specimen", x: 2.5, y: 1.5, z: -1.3, radius: 0.75 },
    { id: "specimen:column", label: "Threshold column", category: "specimen", x: 0.85, y: 1.2, z: -1.85, radius: 0.7 },
    { id: "specimen:cubes", label: "Room cubes & window shaft", category: "specimen", x: -2.9, y: 1.0, z: -2.3, radius: 0.9 },
    { id: "specimen:grass", label: "Yard grass strip", category: "specimen", x: 2.8, y: 0.1, z: 1.2, radius: 1.1 },
  ]

  const section: LabSection = {
    id: "looks",
    label: "Looks",
    settings,
    controls,
    enter() {
      stage.sceneMode = 5
      savedStageGrade = {
        exposure: stage.lighting.exposure,
        tone: stage.lighting.tone,
        saturation: stage.lighting.saturation,
        temperature: stage.lighting.temperature,
      }
      stage.lighting.exposure = 0
      stage.lighting.tone = 2
      stage.lighting.saturation = 1
      stage.lighting.temperature = 0
      stage.frameTarget(-0.3, 0.85, -0.5, 11.2)
      stage.afterScene = (encoder, hdrTexture, _depthView, width, height) => {
        ensureCopyTexture(width, height)
        if (!copyTex || !copyBindGroup || !normalDepthView || !auxDepthView) return
        const ndPass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: normalDepthView,
              loadOp: "clear",
              storeOp: "store",
              clearValue: { r: 0.5, g: 1, b: 0.5, a: 0 },
            },
          ],
          depthStencilAttachment: {
            view: auxDepthView,
            depthLoadOp: "clear",
            depthStoreOp: "discard",
            depthClearValue: 1,
          },
        })
        ndPass.setPipeline(normalDepthPipeline)
        ndPass.setBindGroup(0, sceneBindGroup)
        ndPass.setVertexBuffer(0, roomMesh.buf)
        ndPass.draw(roomMesh.count)
        ndPass.end()

        encoder.copyTextureToTexture({ texture: hdrTexture }, { texture: copyTex }, [width, height])
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: hdrTexture.createView(),
              loadOp: "clear",
              storeOp: "store",
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
        })
        pass.setPipeline(postPipeline)
        pass.setBindGroup(0, copyBindGroup)
        pass.draw(3)
        pass.end()
      }
    },
    leave() {
      stage.afterScene = undefined
      if (savedStageGrade) {
        stage.lighting.exposure = savedStageGrade.exposure
        stage.lighting.tone = savedStageGrade.tone
        stage.lighting.saturation = savedStageGrade.saturation
        stage.lighting.temperature = savedStageGrade.temperature
        savedStageGrade = null
      }
    },
    update(dt) {
      elapsed += dt
    },
    retrigger() {
      rebuildRoomIfNeeded()
    },
    reroll() {
      settings.roomSeed = ((Number(settings.roomSeed) * 1664525 + 1013904223) >>> 0) % 999 + 1
      rebuildRoomIfNeeded()
      context.sync()
    },
    frameTarget: () => ({ x: -0.3, y: 0.85, z: -0.5, dist: 11.2 }),
    objects: () => roomObjects,
    prepare() {
      stage.sceneMode = 5
      stage.lighting.exposure = 0
      stage.lighting.tone = 2
      stage.lighting.saturation = 1
      stage.lighting.temperature = 0
      rebuildRoomIfNeeded()
      const cmp: LookCompareMode =
        Number(settings.compare) === 0 ? 0 : Number(settings.compare) === 2 ? 2 : 1
      packLookUniforms(lookState, lookUniformData, 0, {
        compareMode: cmp,
        wipeSplit: Number(settings.wipeSplit) || 0.5,
        forceActive: true,
      })
      device.queue.writeBuffer(lookUniformBuffer, 0, lookUniformData)
    },
    draw(pass) {
      const frame = (stage as unknown as { frame: Float32Array }).frame
      if (frame) {
        const copy = frame.slice()
        // Pass elapsed time in options.x and viewport width in options.y for screen-space wipe & grain
        copy[36] = elapsed
        copy[37] = Math.max(1, (stage as unknown as { width: number }).width || 1000)
        device.queue.writeBuffer(frameBuffer, 0, copy.buffer, copy.byteOffset, copy.byteLength)
      }
      pass.setPipeline(scenePipeline)
      pass.setBindGroup(0, sceneBindGroup)
      pass.setVertexBuffer(0, roomMesh.buf)
      pass.draw(roomMesh.count)
    },
    telemetry() {
      const def = LOOK_PRESETS[lookState.preset] ?? LOOK_PRESETS.current
      const cmp = Number(settings.compare) === 0 ? "Before" : Number(settings.compare) === 2 ? "A/B Wipe" : "After"
      return `Looks · ${def.label} (${cmp}) {"exposure":${lookState.exposure.toFixed(2)},"contrast":${lookState.contrast.toFixed(2)},"shaft":${lookState.shaftStrength.toFixed(2)},"fog":${lookState.fogDensity.toFixed(2)}}`
    },
  }

  return {
    section,
    getLookSettings: () => ({ ...lookState }),
    applyPreset,
    setParam,
    randomizeGroup: (group, seed) => {
      const resolved = typeof group === "string" ? resolveLookGroup(group) : "all"
      if (!resolved) {
        throw new Error(`Unknown look group "${String(group)}". Valid groups: all, ${LOOK_GROUPS.join(", ")}.`)
      }
      return randomizeGroup(resolved, seed)
    },
    exportPresetJson: () =>
      JSON.stringify(
        exportLookPreset(lookState, {
          tuningSeed: Number(settings.tuningSeed) || 108,
          roomSeed: builtSeed,
        }),
        null,
        2,
      ),
    importPresetJson: raw => {
      const res = importLookPreset(raw)
      if (!res.ok) return res
      Object.assign(lookState, res.value.settings)
      settings.tuningSeed = res.value.tuningSeed
      settings.roomSeed = res.value.roomSeed
      rebuildRoomIfNeeded()
      context.sync()
      return { ok: true }
    },
  }
}
