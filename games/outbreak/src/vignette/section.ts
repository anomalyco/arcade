import { mat4, vec4 } from "wgpu-matrix"
import { Camera } from "@arcade/kit/client/camera"
import type { LabCommandRegistry } from "@arcade/kit/lab-commands"
import type { LabControl, LabSettings } from "@arcade/kit/lab-panel"
import { LIGHT_FLOATS, MAX_LIGHTS, MAX_OCCLUDERS, OCC_FLOATS } from "@arcade/kit/gpu/limits"
import { MAT, Mesh, VERT_BYTES, hex } from "@arcade/kit/gpu/mesh"
import { Renderer, type Batch, type FrameInput } from "@arcade/kit/gpu/renderer"
import { FRAME_FLOATS } from "@arcade/kit/gpu/shaders"
import {
  LOOK_PARAM_SPECS,
  applyLookPreset,
  createLookControls,
  createLookSettings,
  type LookCompareMode,
  type LookSettings,
} from "@arcade/kit/look"
import {
  MATERIAL_PARAM_SPECS,
  MATERIAL_RECIPES,
  packMaterialParams,
  randomizeMaterialParams,
  validateMaterialParams,
  type MaterialRecipeParams,
} from "@arcade/kit/gpu/surface-materials"
import type { LabWorldObject, SectionFactory } from "@arcade/kit/lab/types"
import { clockText, dayCycle, wrapHour } from "../../shared/day-cycle"
import {
  DEFAULT_FLASHLIGHT_TUNING,
  createFlashlightState,
  flashlightColor,
  flashlightControls,
  stepFlashlight,
  type FlashlightState,
  type FlashlightTuning,
} from "../../shared/flashlight"
import { propShape, sightRects, SIZE } from "../../shared/map"
import { SceneryMemory } from "../../shared/scenery-memory"
import { supportHeight } from "../../shared/terrain"
import { FOG_SIZE, Vision } from "../../shared/vision"
import { Survivor } from "../survivor"
import {
  VIGNETTE_CAMERA_PRESETS,
  VIGNETTE_DIRECTIONS,
  VIGNETTE_DIRECTION_ORDER,
  VIGNETTE_SURFACES,
  VIGNETTE_SURFACE_IDS,
  buildVignetteLevel,
  getVignetteLookHook,
  isVignetteSurfaceId,
  kelvinToRgb,
  makeVignetteTown,
  surfaceParamKey,
  type VignetteCameraPreset,
  type VignetteDirectionId,
  type VignetteSurfaceId,
} from "./presets"
import { vignetteShaders } from "./shaders"

function computeGroundRectFromVP(viewProj: Float32Array, top = 5.5): [number, number, number, number] {
  const inv = mat4.inverse(viewProj)
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const nx of [-1, 1]) {
    for (const ny of [-1, 1]) {
      const a = vec4.transformMat4([nx, ny, 0, 1], inv)
      const b = vec4.transformMat4([nx, ny, 1, 1], inv)
      for (const h of [0, top]) {
        const ay = a[1]! / (a[3]! || 1e-6)
        const by = b[1]! / (b[3]! || 1e-6)
        const t = (h - ay) / (by - ay || 1e-6)
        const x = a[0]! / (a[3]! || 1e-6) + (b[0]! / (b[3]! || 1e-6) - a[0]! / (a[3]! || 1e-6)) * t
        const z = a[2]! / (a[3]! || 1e-6) + (b[2]! / (b[3]! || 1e-6) - a[2]! / (a[3]! || 1e-6)) * t
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, z)
        y1 = Math.max(y1, z)
      }
    }
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return [0, 0, SIZE, SIZE]
  return [Math.max(0, x0 - 4), Math.max(0, y0 - 4), Math.min(SIZE, x1 + 4), Math.min(SIZE, y1 + 4)]
}

export const outbreakVignetteSection: SectionFactory = context => {
  const { stage, device } = context

  // Initialize surface recipes from Direction 3 (Noir, primary preset) over surface defaults
  const surfaceState: Record<VignetteSurfaceId, MaterialRecipeParams> = {
    wood_floor: { ...VIGNETTE_SURFACES.wood_floor.defaults },
    plaster: { ...VIGNETTE_SURFACES.plaster.defaults },
    siding: { ...VIGNETTE_SURFACES.siding.defaults },
    shingles: { ...VIGNETTE_SURFACES.shingles.defaults },
    asphalt: { ...VIGNETTE_SURFACES.asphalt.defaults },
    concrete: { ...VIGNETTE_SURFACES.concrete.defaults },
    grass: { ...VIGNETTE_SURFACES.grass.defaults },
  }

  const primaryDir = VIGNETTE_DIRECTIONS[3]
  for (const id of VIGNETTE_SURFACE_IDS) {
    const patch = primaryDir.surfaces[id]
    if (patch) Object.assign(surfaceState[id], patch)
  }

  const lookSettings: LookSettings = createLookSettings(primaryDir.lookPreset)
  if (primaryDir.lookOverrides) Object.assign(lookSettings, primaryDir.lookOverrides)
  const flashlightState: FlashlightState = createFlashlightState(primaryDir.values.flashlightOn)

  const flatSurfaceSettings: Record<string, number> = {}
  for (const id of VIGNETTE_SURFACE_IDS) {
    for (const spec of MATERIAL_PARAM_SPECS) {
      flatSurfaceSettings[surfaceParamKey(id, spec.key)] = surfaceState[id][spec.key]
    }
  }

  /**
   * Typed Lab settings for the Outbreak vignette.
   * Update boundaries (per docs/lab.md):
   * - `uniform`: live uniform/light buffer update; does not rebuild static level geometry.
   * - `structural`: rebuilds single-lot static mesh (`houseSeed`, `clutterDensity`, `foliageDensity`, `treeSlot`) while preserving camera/lights/recipes.
   */
  const s: LabSettings &
    FlashlightTuning & {
      directionPreset: VignetteDirectionId
      cameraPreset: VignetteCameraPreset
      cutawayMode: 0 | 1 | 2
      compareMode: 0 | 1 | 2
      compareSplit: number
      diagnostic: number
      hour: number
      exposure: number
      ambientFill: number
      skyFill: number
      skyTemp: number
      moonStrength: number
      moonTemp: number
      shadowSoftness: number
      diffuseWrap: number
      streetLampPower: number
      streetLampTemp: number
      streetLampFalloff: number
      porchLightPower: number
      porchLightTemp: number
      porchLightFalloff: number
      windowLightPower: number
      windowLightTemp: number
      windowLightFalloff: number
      flashlightOn: boolean
      flashlightAim: number
      flashlightHaze: number
      activeSurface: VignetteSurfaceId
      tuningSeed: number
      baseR: number
      baseG: number
      baseB: number
      roughness: number
      scale: number
      elementRatio: number
      irregularity: number
      grainScale: number
      colorVariation: number
      jointWidth: number
      wear: number
      macroVariation: number
      clutterDensity: number
      foliageDensity: number
      overgrowth: number
      treeSlot: number
      houseSeed: number
      fogStyle: 0 | 1 | 2
      fogEdgeSoftness: number
      fogMemoryDim: number
      fogUnknownGrain: number
      playing: boolean
    } = {
    directionPreset: 3,
    cameraPreset: "game",
    cutawayMode: 1,
    compareMode: 0,
    compareSplit: 0.5,
    diagnostic: 0,
    ...DEFAULT_FLASHLIGHT_TUNING,
    ...lookSettings,
    ...primaryDir.values,
    activeSurface: "asphalt",
    tuningSeed: 101,
    ...surfaceState.asphalt,
    ...flatSurfaceSettings,
    treeSlot: 1,
    houseSeed: 7,
    fogStyle: 1,
    fogEdgeSoftness: 0.78,
    fogMemoryDim: 0.42,
    fogUnknownGrain: 0,
    playing: true,
  }

  let renderer: Renderer | null = null
  let avatar: Survivor | null = null
  let doorModel = -1
  const doorData = new Float32Array(4 * 12)
  const doorBatch: Batch = { model: 0, data: doorData, count: 0 }
  const frame = new Float32Array(FRAME_FLOATS)
  const lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
  const occluders = new Float32Array(MAX_OCCLUDERS * OCC_FLOATS)
  const lampPower = new Float32Array(MAX_LIGHTS)
  const empty = new Float32Array(0)
  const vignetteUniforms = new Float32Array(128)
  const cam = new Camera()
  const vision = new Vision()
  const scenery = new SceneryMemory()

  let town = makeVignetteTown({
    seed: 7,
    houseSeed: s.houseSeed,
    foliageDensity: s.foliageDensity,
    clutterDensity: s.clutterDensity,
    treeSlot: s.treeSlot,
  })
  let blockers = sightRects(town)
  let lightOccluders = 0
  let staticVertices = 0
  let simTime = 0
  const player = { x: 27.7, y: 38.6, vx: 0, vy: 0, aim: -Math.PI / 2 }

  function ensureRenderer() {
    if (renderer) return renderer
    const format = navigator.gpu.getPreferredCanvasFormat()
    const dummyCanvas = document.createElement("canvas")
    dummyCanvas.width = 16
    dummyCanvas.height = 16
    const dummyCtx = dummyCanvas.getContext("webgpu")!
    dummyCtx.configure({ device, format, alphaMode: "opaque" })
    renderer = new Renderer(device, dummyCtx, format, vignetteShaders)
    avatar = new Survivor(renderer)
    const doorMesh = new Mesh()
    doorMesh.box(0, 0.13, -0.1, 1.4, 2.3, 0.1, hex(0x463322), MAT.timber)
    doorMesh.box(0.08, 0.35, -0.11, 1.32, 2.1, -0.105, hex(0x57402b), MAT.timber)
    doorMesh.box(1.14, 1.08, 0.1, 1.25, 1.19, 0.18, hex(0xc9a96a), MAT.shiny)
    for (const dx of [0.15, 0.75]) {
      for (const dy of [0.42, 1.36]) {
        doorMesh.box(dx, dy, 0.101, dx + 0.48, dy + 0.70, 0.125, hex(0x5b432d), MAT.timber)
        doorMesh.box(dx + 0.035, dy + 0.04, 0.126, dx + 0.445, dy + 0.66, 0.132, hex(0x3a2a1c), MAT.timber)
      }
    }
    doorModel = renderer.addModel(doorMesh)
    doorBatch.model = doorModel
    rebuildVignetteLevel()
    return renderer
  }

  function rebuildOccluders() {
    blockers = sightRects(town)
    occluders.fill(0)
    blockers.forEach((r, i) => occluders.set([...r, 2.8, 0, 0, 0], i * OCC_FLOATS))
    lightOccluders = blockers.length
    for (const b of town.barriers) {
      if (b.kind === "window") occluders.set([...b.rect, 0.85, 0, 0, 0], lightOccluders++ * OCC_FLOATS)
    }
    for (const p of town.props) {
      const sh = propShape(p)
      if (sh) occluders.set([...sh.rect, sh.height, 0, 0, 0], lightOccluders++ * OCC_FLOATS)
    }
  }

  function rebuildVignetteLevel() {
    town = makeVignetteTown({
      seed: 7,
      houseSeed: s.houseSeed,
      foliageDensity: s.foliageDensity,
      clutterDensity: s.clutterDensity,
      treeSlot: s.treeSlot,
    })
    rebuildOccluders()
    if (!renderer) return
    const data = buildVignetteLevel(town)
    staticVertices = [...data.chunks, ...data.glass].reduce((n, c) => n + c.data.byteLength / VERT_BYTES, 0)
    renderer.setLevel(data)
    // Mark the vignette house interior explored so cutaway living room + kitchen is always readable
    scenery.mask.fill(255)
    renderer.setVisibility(scenery.mask, FOG_SIZE, FOG_SIZE)
  }

  function syncActiveSurfaceToFlat(id: VignetteSurfaceId) {
    const rec = surfaceState[id]
    for (const spec of MATERIAL_PARAM_SPECS) {
      s[surfaceParamKey(id, spec.key)] = rec[spec.key]
      if (s.activeSurface === id) {
        s[spec.key] = rec[spec.key]
      }
    }
  }

  function loadActiveSurfaceSliders(id: VignetteSurfaceId) {
    s.activeSurface = id
    const rec = surfaceState[id]
    for (const spec of MATERIAL_PARAM_SPECS) {
      s[spec.key] = rec[spec.key]
    }
  }

  function pullFlatIntoSurfaceState() {
    for (const id of VIGNETTE_SURFACE_IDS) {
      for (const spec of MATERIAL_PARAM_SPECS) {
        const k = surfaceParamKey(id, spec.key)
        const v = Number(s[k])
        if (Number.isFinite(v)) surfaceState[id][spec.key] = v
      }
    }
    if (isVignetteSurfaceId(s.activeSurface)) {
      const activeRec = surfaceState[s.activeSurface]
      for (const spec of MATERIAL_PARAM_SPECS) {
        const v = Number(s[spec.key])
        if (Number.isFinite(v)) {
          activeRec[spec.key] = v
          s[surfaceParamKey(s.activeSurface, spec.key)] = v
        }
      }
    }
  }

  function syncLookSettingsFromState() {
    for (const spec of LOOK_PARAM_SPECS) {
      const val = s[spec.key]
      if (spec.key === "grainAnimated" && typeof val === "boolean") {
        lookSettings.grainAnimated = val
      } else if (spec.key !== "grainAnimated" && typeof val === "number" && Number.isFinite(val)) {
        lookSettings[spec.key] = val
      }
    }
  }

  function applyDirectionPreset(dirId: VignetteDirectionId) {
    const spec = VIGNETTE_DIRECTIONS[dirId] ?? VIGNETTE_DIRECTIONS[3]
    const prevClutter = s.clutterDensity
    const prevFoliage = s.foliageDensity
    s.directionPreset = spec.id
    applyLookPreset(lookSettings, spec.lookPreset)
    if (spec.lookOverrides) Object.assign(lookSettings, spec.lookOverrides)
    for (const lSpec of LOOK_PARAM_SPECS) {
      ;(s as LabSettings)[lSpec.key] = lookSettings[lSpec.key]
    }
    Object.assign(s, spec.values)
    flashlightState.flashlightOn = s.flashlightOn
    flashlightState.battery = 1
    flashlightState.batteryDepleted = false
    flashlightState.flashlightOutput = s.flashlightOn ? 1 : 0

    for (const id of VIGNETTE_SURFACE_IDS) {
      surfaceState[id] = { ...VIGNETTE_SURFACES[id].defaults, ...(spec.surfaces[id] ?? {}) }
      syncActiveSurfaceToFlat(id)
    }
    loadActiveSurfaceSliders(s.activeSurface)

    if (prevClutter !== s.clutterDensity || prevFoliage !== s.foliageDensity) {
      rebuildVignetteLevel()
    }
    getVignetteLookHook()?.({
      directionPreset: spec.id,
      directionSlug: spec.slug,
      settings: s,
    })
  }

  function applyCameraPreset(preset: VignetteCameraPreset, overrideCutaway?: 0 | 1 | 2) {
    const cfg = VIGNETTE_CAMERA_PRESETS[preset] ?? VIGNETTE_CAMERA_PRESETS.game
    s.cameraPreset = preset
    s.cutawayMode = overrideCutaway ?? cfg.cutawayMode
    player.x = cfg.playerPos[0]
    player.y = cfg.playerPos[1]
    player.aim = cfg.playerPos[2]
    stage.focus[0] = cfg.focus[0]
    stage.focus[1] = cfg.focus[1]
    stage.focus[2] = cfg.focus[2]
    stage.targetFocus[0] = cfg.focus[0]
    stage.targetFocus[1] = cfg.focus[1]
    stage.targetFocus[2] = cfg.focus[2]
    stage.camYaw = cfg.yaw
    stage.targetYaw = cfg.yaw
    stage.camPitch = cfg.pitch
    stage.targetPitch = cfg.pitch
    stage.camDist = cfg.dist
    stage.targetDist = cfg.dist
    stage.camCustom = false
  }

  function packVignetteUniformBuffer() {
    pullFlatIntoSurfaceState()
    vignetteUniforms.fill(0)
    // Slot 0: wood_floor
    packMaterialParams(surfaceState.wood_floor, vignetteUniforms, 0 * 12)
    // Slot 1: cobblestone (derived from concrete/pavers)
    packMaterialParams(MATERIAL_RECIPES.cobblestone.defaults, vignetteUniforms, 1 * 12)
    // Slot 2: plaster
    packMaterialParams(surfaceState.plaster, vignetteUniforms, 2 * 12)
    // Slot 3: asphalt
    packMaterialParams(surfaceState.asphalt, vignetteUniforms, 3 * 12)
    // Slot 4: concrete
    packMaterialParams(surfaceState.concrete, vignetteUniforms, 4 * 12)
    // Slot 5: grass
    packMaterialParams(surfaceState.grass, vignetteUniforms, 5 * 12)
    // Slot 6: siding
    packMaterialParams(surfaceState.siding, vignetteUniforms, 6 * 12)
    // Slot 7: shingles
    packMaterialParams(surfaceState.shingles, vignetteUniforms, 7 * 12)

    // params0 (offset 96): compareMode, compareSplit, cutawayMode, diffuseWrap
    vignetteUniforms[96] = s.compareMode
    vignetteUniforms[97] = s.compareSplit
    vignetteUniforms[98] = s.cutawayMode
    vignetteUniforms[99] = s.diffuseWrap

    // params1 (offset 100): ambientFill, skyTemp, moonTemp, overgrowth
    vignetteUniforms[100] = s.ambientFill
    vignetteUniforms[101] = s.skyTemp
    vignetteUniforms[102] = s.moonTemp
    vignetteUniforms[103] = s.overgrowth

    // params2 (offset 104): true player x, z, skyScaleRatio, moonScaleRatio
    vignetteUniforms[104] = player.x
    vignetteUniforms[105] = player.y
    vignetteUniforms[106] = s.compareMode === 2 ? Math.max(0.05, s.skyFill) : 1.0
    vignetteUniforms[107] = s.compareMode === 2 ? Math.max(0.05, s.moonStrength) : 1.0
  }

  const controls: LabControl[] = [
    // --- Presets & Comparison ---
    {
      key: "directionPreset",
      label: "Art direction",
      group: "Direction & View",
      type: "select",
      options: VIGNETTE_DIRECTION_ORDER.map(id => ({
        value: id,
        label: VIGNETTE_DIRECTIONS[id].label,
      })),
      change: val => {
        applyDirectionPreset(Number(val) as VignetteDirectionId)
        context.sync()
      },
    },
    {
      key: "cameraPreset",
      label: "Camera preset",
      group: "Direction & View",
      type: "select",
      options: [
        { value: "game", label: "Game camera (lot + street)" },
        { value: "interior", label: "Interior close (living + kitchen)" },
        { value: "street", label: "Street close (lamp + porch)" },
        { value: "target_street", label: "Target street (1000×680 aligned)" },
        { value: "target_interior", label: "Target interior (1000×680 aligned)" },
      ],
      change: val => {
        applyCameraPreset(String(val) as VignetteCameraPreset)
        context.sync()
      },
    },
    {
      key: "cutawayMode",
      label: "Interior cutaway",
      group: "Direction & View",
      type: "select",
      options: [
        { value: 1, label: "Cutaway interior (living + kitchen)" },
        { value: 0, label: "Auto (by player position)" },
        { value: 2, label: "Closed roof" },
      ],
    },
    {
      key: "compareMode",
      label: "A/B vs Shipped",
      group: "Direction & View",
      type: "select",
      options: [
        { value: 0, label: "Vignette (Active)" },
        { value: 1, label: "Current shipped (Before)" },
        { value: 2, label: "Split A/B vs Shipped" },
      ],
      change: () => context.sync(),
    },
    {
      key: "compareSplit",
      label: "A/B split line",
      group: "Direction & View",
      type: "range",
      min: 0.1,
      max: 0.9,
      step: 0.05,
      unit: "",
      visible: () => s.compareMode === 2,
    },
    {
      key: "diagnostic",
      label: "Contribution",
      group: "Direction & View",
      type: "select",
      options: ["Beauty", "Albedo", "Direct", "Ambient + sky", "Specular", "Bloom", "Before memory"].map((label, value) => ({
        label,
        value,
      })),
    },
    {
      key: "fogStyle",
      label: "Fog of war style",
      group: "Direction & View",
      type: "select",
      options: [
        { value: 1, label: "Soft memory (Default)" },
        { value: 2, label: "Stark Cone + Pulse" },
        { value: 0, label: "Soft Shroud (Classic)" },
      ],
    },
    { key: "fogEdgeSoftness", label: "LOS edge feather", group: "Direction & View", type: "range", min: 0.05, max: 1.5, step: 0.05, unit: "" },
    { key: "fogMemoryDim", label: "Memory brightness", group: "Direction & View", type: "range", min: 0.1, max: 0.9, step: 0.02, unit: "×" },
    { key: "fogUnknownGrain", label: "Unknown area grain", group: "Direction & View", type: "range", min: 0.0, max: 1.0, step: 0.02, unit: "" },

    // --- Time, Sky & Shadows ---
    { key: "hour", label: "Time of day", group: "Sky & Shadows", type: "range", min: 0, max: 24, step: 0.1, unit: "h" },
    { key: "exposure", label: "Exposure", group: "Sky & Shadows", type: "range", min: 0.4, max: 2.2, step: 0.05, unit: "×" },
    { key: "ambientFill", label: "Sheltered ambient", group: "Sky & Shadows", type: "range", min: 0, max: 2.0, step: 0.05, unit: "×" },
    { key: "skyFill", label: "Sky fill", group: "Sky & Shadows", type: "range", min: 0, max: 2.0, step: 0.05, unit: "×" },
    { key: "skyTemp", label: "Sky warmth", group: "Sky & Shadows", type: "range", min: -1, max: 1, step: 0.05, unit: "" },
    { key: "moonStrength", label: "Moon / sun fill", group: "Sky & Shadows", type: "range", min: 0, max: 2.5, step: 0.05, unit: "×" },
    { key: "moonTemp", label: "Moon / sun warmth", group: "Sky & Shadows", type: "range", min: -1, max: 1, step: 0.05, unit: "" },
    { key: "shadowSoftness", label: "Shadow softness", group: "Sky & Shadows", type: "range", min: 0.04, max: 0.6, step: 0.02, unit: "m" },
    { key: "diffuseWrap", label: "Painterly wrap", group: "Sky & Shadows", type: "range", min: 0, max: 1, step: 0.05, unit: "" },

    // --- Practical Lights & Flashlight (shared games/outbreak/shared/flashlight.ts) ---
    {
      key: "flashlightOn",
      label: "Flashlight switch",
      group: "Flashlight",
      change: val => {
        flashlightState.flashlightOn = Boolean(val)
        flashlightState.flashlightOutput = flashlightState.flashlightOn ? 1 : 0
      },
    },
    ...flashlightControls.map(
      (fc): LabControl => ({
        key: fc.key,
        label: fc.label,
        group: fc.group,
        type: "range",
        min: fc.min,
        max: fc.max,
        step: fc.step,
        unit: fc.unit,
        folded: fc.key.startsWith("flashlightD") || fc.key.startsWith("flashlightR") || fc.key === "flashlightFlicker",
      }),
    ),
    { key: "flashlightHaze", label: "Volumetric cone haze", group: "Flashlight", type: "range", min: 0, max: 2.0, step: 0.05, unit: "×" },
    { key: "flashlightAim", label: "Beam yaw", group: "Flashlight", type: "range", min: -180, max: 180, step: 1, unit: "deg" },
    { key: "streetLampPower", label: "Streetlamp power", group: "Practical Lights", type: "range", min: 0, max: 2.5, step: 0.05, unit: "×" },
    { key: "streetLampTemp", label: "Streetlamp colour", group: "Practical Lights", type: "range", min: 1800, max: 5500, step: 50, unit: "K" },
    { key: "streetLampFalloff", label: "Streetlamp radius", group: "Practical Lights", type: "range", min: 0.5, max: 1.8, step: 0.05, unit: "×" },
    { key: "porchLightPower", label: "Porch light power", group: "Practical Lights", type: "range", min: 0, max: 2.5, step: 0.05, unit: "×" },
    { key: "porchLightTemp", label: "Porch light colour", group: "Practical Lights", type: "range", min: 1800, max: 5500, step: 50, unit: "K" },
    { key: "porchLightFalloff", label: "Porch light radius", group: "Practical Lights", type: "range", min: 0.5, max: 1.8, step: 0.05, unit: "×" },
    { key: "windowLightPower", label: "Window & room power", group: "Practical Lights", type: "range", min: 0, max: 2.5, step: 0.05, unit: "×" },
    { key: "windowLightTemp", label: "Window & room colour", group: "Practical Lights", type: "range", min: 1800, max: 5500, step: 50, unit: "K" },
    { key: "windowLightFalloff", label: "Window & room radius", group: "Practical Lights", type: "range", min: 0.5, max: 1.8, step: 0.05, unit: "×" },

    // --- Surface Materials (shared surface-materials system) ---
    {
      key: "activeSurface",
      label: "Surface",
      group: "Surface Materials",
      type: "select",
      options: VIGNETTE_SURFACE_IDS.map(id => ({
        value: id,
        label: VIGNETTE_SURFACES[id].label,
      })),
      change: val => {
        if (isVignetteSurfaceId(val)) {
          loadActiveSurfaceSliders(val)
          context.sync()
        }
      },
    },
    {
      key: "tuningSeed",
      label: "Recipe tuning seed",
      group: "Surface Materials",
      type: "range",
      min: 1,
      max: 9999,
      step: 1,
      unit: "",
    },
    {
      key: "randomizeSurface",
      label: "Randomize surface",
      group: "Surface Materials",
      type: "action",
      run: () => {
        context.transact?.(`Randomize ${s.activeSurface} recipe`, () => {
          const meta = VIGNETTE_SURFACES[s.activeSurface]
          const next = randomizeMaterialParams(meta.baseRecipe, s.tuningSeed + meta.slot * 31)
          surfaceState[s.activeSurface] = next
          syncActiveSurfaceToFlat(s.activeSurface)
          s.tuningSeed = (s.tuningSeed % 9999) + 1
        })
        context.sync()
      },
    },
    {
      key: "resetSurface",
      label: "Reset surface",
      group: "Surface Materials",
      type: "action",
      run: () => {
        context.transact?.(`Reset ${s.activeSurface} recipe`, () => {
          surfaceState[s.activeSurface] = { ...VIGNETTE_SURFACES[s.activeSurface].defaults }
          syncActiveSurfaceToFlat(s.activeSurface)
        })
        context.sync()
      },
    },
    ...MATERIAL_PARAM_SPECS.map(
      (spec): LabControl => ({
        key: spec.key,
        label: spec.label,
        group: spec.group === "Surface" ? "Surface Materials" : `Material ${spec.group}`,
        folded: spec.group !== "Surface",
        type: "range",
        min: spec.min,
        max: spec.max,
        step: spec.step,
        unit: spec.unit,
        change: val => {
          if (typeof val === "number" && Number.isFinite(val)) {
            surfaceState[s.activeSurface][spec.key] = val
            s[surfaceParamKey(s.activeSurface, spec.key)] = val
          }
        },
      }),
    ),

    // --- Lot & Interior Clutter ---
    {
      key: "clutterDensity",
      label: "Interior clutter",
      group: "Lot & Clutter",
      type: "range",
      min: 0,
      max: 1.5,
      step: 0.05,
      unit: "×",
      change: () => rebuildVignetteLevel(),
    },
    {
      key: "foliageDensity",
      label: "Ground-cover density",
      group: "Lot & Clutter",
      type: "range",
      min: 0.25,
      max: 1.75,
      step: 0.05,
      unit: "×",
      change: () => rebuildVignetteLevel(),
    },
    {
      key: "overgrowth",
      label: "Crack moss & sun-shafts",
      group: "Lot & Clutter",
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      unit: "",
    },
    {
      key: "treeSlot",
      label: "Tree slot",
      group: "Lot & Clutter",
      type: "select",
      options: [
        { value: 1, label: "Broadleaf oak" },
        { value: 2, label: "Autumn maple" },
        { value: 3, label: "Compact birch" },
        { value: 0, label: "Empty slot" },
      ],
      change: () => rebuildVignetteLevel(),
    },
    {
      key: "houseSeed",
      label: "House palette seed",
      group: "Lot & Clutter",
      type: "range",
      min: 1,
      max: 32,
      step: 1,
      unit: "",
      change: () => rebuildVignetteLevel(),
    },

    // --- Shared @arcade/kit LookSettings Controls ---
    ...createLookControls(lookSettings, { includePresetPicker: false }).map(
      (c): LabControl => ({
        ...c,
        folded: true,
        change: val => {
          ;(c as { change?: (v: any) => void }).change?.(val)
          syncLookSettingsFromState()
        },
      }),
    ),
  ]

  function renderVignetteToStage(width: number, height: number, outputView: GPUTextureView): number | null {
    const r = ensureRenderer()
    r.resize(width, height)
    r.setSurfaceTexUniforms({ enabled: s.compareMode === 1 ? 0 : 1, globalScale: 1.0, globalContrast: 1.15, globalRoughness: 0.0 })
    packVignetteUniformBuffer()
    r.setCustomUniforms(vignetteUniforms)

    const useShippedGlobal = s.compareMode === 1
    const effHour = wrapHour(useShippedGlobal ? 18.0 : s.hour)
    const day = dayCycle(effHour)

    // Camera matrix: always build column-major wgpu-matrix from stage focus/pitch/dist
    {
      cam.x = stage.focus[0]!
      cam.z = stage.focus[2]!
      cam.pitch = stage.camPitch
      cam.dist = stage.camDist
      cam.zoomOffset = 0
      cam.update(width / Math.max(1, height))
      stage.viewProj.set(cam.viewProj)
      mat4.inverse(cam.viewProj, stage.inverse)
      stage.eye.set(cam.eye)
    }

    const view = computeGroundRectFromVP(stage.viewProj, 5.5)
    const groundY = supportHeight(town, player.x, player.y)

    // Populate lights: slot 0 is eye visibility
    lights.fill(0)
    lights.set([player.x, 1.65 + groundY, player.y, 27, 0, 0, 0, 0, 0, 0, 0, 0, 0, blockers.length, 0.01, -1], 0)
    let count = 1

    const isInteriorCam = s.cameraPreset === "interior" || s.cameraPreset === "target_interior"
    const isNoirPreset = !useShippedGlobal && s.directionPreset === 3
    const soft = useShippedGlobal ? 0.20 : s.shadowSoftness
    for (const [i, lamp] of town.lamps.entries()) {
      const kindMult = useShippedGlobal
        ? 1.0
        : lamp.kind === "street"
          ? s.streetLampPower
          : lamp.kind === "porch"
            ? s.porchLightPower * (isInteriorCam && isNoirPreset ? 0.36 : 1.0)
            : s.windowLightPower
      const radiusMult = useShippedGlobal
        ? 1.0
        : lamp.kind === "street"
          ? s.streetLampFalloff
          : lamp.kind === "porch"
            ? s.porchLightFalloff
            : s.windowLightFalloff
      let noirRoomMult = 1.0
      let noirColorOverride: [number, number, number] | null = null
      if (isNoirPreset) {
        if (lamp.kind === "window") {
          // Left window off; right window subtle
          noirRoomMult = lamp.x < 26 ? 0.0 : isInteriorCam ? 0.0 : 0.45
          noirColorOverride = [0.95, 0.76, 0.48]
        } else if (lamp.kind === "room") {
          if (lamp.x < 26 && lamp.y < 28) {
            // Bedroom nightstand lamp: cool pale ice-blue pool
            noirRoomMult = 1.55
            noirColorOverride = [0.64, 0.82, 1.0]
          } else if (lamp.x > 30 && lamp.y > 29) {
            // Dining/kitchen lamp: warm amber pool
            noirRoomMult = 1.22
            noirColorOverride = [1.0, 0.58, 0.22]
          } else {
            // SW living room & central hallway lamps off in Noir
            noirRoomMult = 0.0
          }
        }
      }
      const lampScale = Math.max(0.18, day.lamps) * kindMult * noirRoomMult
      lampPower[i] = lampScale
      const power = lampScale * lamp.power
      if (power <= 0.001) continue
      const lx = lamp.x + (lamp.kind === "street" ? 0.55 : 0)
      const ly = lamp.y
      const rad = lamp.radius * radiusMult
      const color: [number, number, number] = useShippedGlobal
        ? lamp.kind === "street"
          ? [1, 0.78, 0.54]
          : lamp.kind === "porch"
            ? [1, 0.66, 0.28]
            : lamp.kind === "window"
              ? [1, 0.60, 0.24]
              : [1, 0.52, 0.19]
        : noirColorOverride ??
          (lamp.kind === "street"
            ? kelvinToRgb(s.streetLampTemp)
            : lamp.kind === "porch"
              ? kelvinToRgb(s.porchLightTemp)
              : kelvinToRgb(s.windowLightTemp))
      const cone =
        lamp.kind === "window"
          ? [0, 1, -0.15, 1]
          : lamp.kind === "porch"
            ? [0, 1, -0.35, 1]
            : [0, 0, 0, lamp.kind === "room" ? -1 : 0]
      const fixtureSoft = lamp.kind === "room" ? soft * 0.8 : soft * 1.1
      lights.set(
        [lx, lamp.h, ly, rad, ...color, power, ...cone, 0, lightOccluders, fixtureSoft, i],
        count++ * LIGHT_FLOATS,
      )
    }

    // Player flashlight cone via shared games/outbreak/shared/flashlight.ts
    const flashActive = !useShippedGlobal && s.flashlightOn && s.flashlightIntensity > 0.001
    const flashPower = flashActive ? s.flashlightIntensity * Math.max(0.2, flashlightState.flashlightOutput) : 0
    let flashSlot = -1
    const beamDeg = isInteriorCam && Math.abs(s.flashlightAim - 45.5) < 3 ? 54.5 : s.flashlightAim
    const effRange = isInteriorCam && Math.abs(s.flashlightRange - 10.5) < 1 ? 6.2 : s.flashlightRange
    const halfConeDeg = s.flashlightCone * 0.5
    const beamRad = (beamDeg * Math.PI) / 180
    const dirX = Math.cos(beamRad)
    const dirZ = Math.sin(beamRad)
    const fx = player.x + 0.24
    const fz = player.y + 0.08
    const fy = groundY + 1.08
    if (flashPower > 0.001 && count < MAX_LIGHTS) {
      flashSlot = count
      const fCol = flashlightColor(isInteriorCam ? Math.max(s.flashlightWarmth, 0.72) : s.flashlightWarmth)
      const cosHalf = Math.cos((halfConeDeg * Math.PI) / 180)
      lights.set(
        [
          fx,
          fy,
          fz,
          effRange,
          fCol[0],
          fCol[1],
          fCol[2],
          flashPower * 0.85,
          dirX,
          dirZ,
          cosHalf,
          1,
          0,
          lightOccluders,
          Math.max(0.03, soft * 0.45),
          -1,
        ],
        count++ * LIGHT_FLOATS,
      )
    }
    vignetteUniforms[108] = fx
    vignetteUniforms[109] = fz
    vignetteUniforms[110] = dirX
    vignetteUniforms[111] = dirZ
    vignetteUniforms[112] = Math.tan((halfConeDeg * Math.PI) / 180)
    vignetteUniforms[113] = effRange
    vignetteUniforms[114] = useShippedGlobal ? 0 : s.flashlightHaze
    vignetteUniforms[115] = flashSlot
    vignetteUniforms[116] = s.fogStyle
    vignetteUniforms[117] = s.fogEdgeSoftness
    vignetteUniforms[118] = s.fogMemoryDim
    vignetteUniforms[119] = s.fogUnknownGrain
    r.setCustomUniforms(vignetteUniforms)

    // Cutaway coordinate in F.eye.xy:
    // - cutawayMode 1: place cutaway probe inside `ash` (29.5, 30.0) so living room + kitchen roof is cut away,
    //   and set cutOn = 0 so the screen-space Bayer wall circle does not dither the front wall.
    // - cutawayMode 2: place probe at (0, 0) with cutOn = 0 so roof stays closed.
    // - cutawayMode 0: use player's plan coordinates with cutOn = 1.
    const cutX = s.cutawayMode === 1 ? 29.5 : s.cutawayMode === 2 ? 0 : player.x
    const cutZ = s.cutawayMode === 1 ? 30.0 : s.cutawayMode === 2 ? 0 : player.y
    const cutOn = s.cutawayMode === 0 ? 1 : 0

    const skyFill = useShippedGlobal || s.compareMode === 2 ? 1.0 : s.skyFill
    const skyTemp = useShippedGlobal ? 0.0 : s.skyTemp
    const skyTint: [number, number, number] = [
      1 + Math.max(0, skyTemp) * 0.45 - Math.max(0, -skyTemp) * 0.15,
      1 + Math.max(0, skyTemp) * 0.12 - Math.max(0, -skyTemp) * 0.05,
      1 - Math.max(0, skyTemp) * 0.28 + Math.max(0, -skyTemp) * 0.28,
    ]
    const moonMult = useShippedGlobal || s.compareMode === 2 ? 1.0 : s.moonStrength

    frame.set(stage.viewProj, 0)
    frame.set([stage.eye[0]!, stage.eye[1]!, stage.eye[2]!, simTime], 16)
    frame.set([width, height, count, town.lamps.length], 20)
    frame.set([cutX, cutZ, cutOn, 0.48], 24)
    frame.set(
      [
        day.ambient[0] * skyFill * skyTint[0],
        day.ambient[1] * skyFill * skyTint[1],
        day.ambient[2] * skyFill * skyTint[2],
        day.strength * moonMult,
      ],
      28,
    )
    const focusProj = stage.projectWorld(cutX, 1, cutZ)
    frame.set([focusProj.u * 2 - 1, 1 - focusProj.v * 2, 1.0, count], 32)
    frame.set([...day.direction, day.sun], 36)
    frame.set([1 / SIZE, 1 / SIZE, s.diagnostic, SIZE], 40)
    frame.set([player.aim, Math.cos((110 * Math.PI) / 360), 2.5, 0.32], 44)

    town.doors.forEach((door, i) =>
      doorData.set(
        [door.rect[0], 0, (door.rect[1] + door.rect[3]) / 2, door.open ? -Math.PI / 2 : 0, 1, 1, 1, 1, 0, 0, 1, 0],
        i * 12,
      ),
    )
    doorBatch.count = town.doors.length
    const batches = [...(avatar ? avatar.draw(player, 1 / 60, simTime, (x, z) => supportHeight(town, x, z)) : []), doorBatch]

    syncLookSettingsFromState()
    const lookCompareMode: LookCompareMode = s.compareMode === 1 ? 0 : s.compareMode === 2 ? 2 : 1
    r.setLook(lookSettings, { mode: lookCompareMode, wipeSplit: s.compareSplit })

    const renderInput: FrameInput = {
      frame,
      lights,
      lightCount: count,
      shadowLightCount: count,
      occluders,
      occluderCount: lightOccluders,
      lampPower,
      lampCount: town.lamps.length,
      view,
      batches,
      alphaSprites: empty,
      alphaCount: 0,
      addSprites: empty,
      addCount: 0,
      grade: [simTime, s.diagnostic, 0, useShippedGlobal ? 1.0 : s.exposure],
      look: lookSettings,
      lookCompare: { mode: lookCompareMode, wipeSplit: s.compareSplit },
    }

    r.drawTo(renderInput, outputView)
    return null
  }

  const sceneObjects = (): LabWorldObject[] => [
    {
      id: "player",
      label: "Survivor (Player)",
      category: "character",
      x: player.x,
      y: supportHeight(town, player.x, player.y),
      z: player.y,
      yaw: player.aim,
      radius: 0.7,
      movable: true,
    },
    {
      id: "lamp:street",
      label: "Streetlamp",
      category: "light",
      x: 34.4,
      y: 0.1,
      z: 39.12,
      radius: 0.85,
      movable: false,
    },
    {
      id: "lamp:porch",
      label: "Porch Sconce",
      category: "light",
      x: 27.7,
      y: 0.13,
      z: 36.65,
      radius: 0.8,
      movable: false,
    },
    {
      id: "house:interior",
      label: "House Cutaway (Living + Kitchen)",
      category: "specimen",
      x: 29.5,
      y: 0.13,
      z: 31.2,
      radius: 1.5,
      movable: false,
    },
  ]

  let selectedObjectId = "player"

  return {
    id: "outbreak-vignette",
    label: "Outbreak vignette",
    settings: s,
    controls,
    get selectedObjectId() {
      return selectedObjectId
    },
    set selectedObjectId(v: string) {
      selectedObjectId = v
    },
    objects: sceneObjects,
    selectObject(id) {
      if (id) selectedObjectId = id
    },
    moveObject(id, x, z, yaw) {
      if (id === "player") {
        player.x = Math.max(15, Math.min(40, x))
        player.y = Math.max(21, Math.min(47, z))
        if (typeof yaw === "number" && Number.isFinite(yaw)) player.aim = yaw
        return true
      }
      return false
    },
    groundHeight: (x, z) => supportHeight(town, x, z),
    frameTarget: () => {
      const cfg = VIGNETTE_CAMERA_PRESETS[s.cameraPreset] ?? VIGNETTE_CAMERA_PRESETS.game
      return { x: cfg.focus[0], y: cfg.focus[1], z: cfg.focus[2], dist: cfg.dist }
    },
    retrigger: () => {
      rebuildVignetteLevel()
    },
    reroll: () => {
      s.houseSeed = (s.houseSeed % 32) + 1
      rebuildVignetteLevel()
      context.sync()
    },
    enter() {
      ensureRenderer()
      applyCameraPreset(s.cameraPreset, s.cutawayMode)
      stage.cameraOverride = (w, h, vp, inverse, eye, focus) => {
        cam.x = focus[0]!
        cam.z = focus[2]!
        cam.pitch = stage.camPitch
        cam.dist = stage.camDist
        cam.zoomOffset = 0
        cam.update(w / Math.max(1, h))
        vp.set(cam.viewProj)
        mat4.inverse(cam.viewProj, inverse)
        eye.set(cam.eye)
      }
      stage.customRender = (w, h, outputView) => renderVignetteToStage(w, h, outputView)
    },
    leave() {
      stage.customRender = undefined
      stage.cameraOverride = undefined
    },
    update(dt) {
      if (s.playing) {
        simTime += dt
        flashlightState.flashlightOn = s.flashlightOn
        // Keep battery topped up in static vignette inspection while exercising stepFlashlight
        if (flashlightState.battery < 0.65) flashlightState.battery = 1
        stepFlashlight(flashlightState, dt, simTime, s)
      }
    },
    prepare() {
      vision.update(player.x, player.y, player.aim, blockers, {
        cone: 110,
        awareness: 2.5,
        range: 27,
      })
    },
    telemetry: () => {
      const dir = VIGNETTE_DIRECTIONS[s.directionPreset] ?? VIGNETTE_DIRECTIONS[3]
      return `Outbreak vignette · ${dir.slug} (${dir.lookPreset}) · ${clockText(s.hour)} {"vertices":${staticVertices},"chunks":${renderer?.drawnChunks ?? 0},"lights":${town.lamps.length + (s.flashlightOn && s.flashlightIntensity > 0 ? 1 : 0)}}`
    },
    registerCommands(commands: LabCommandRegistry) {
      commands.registerAll([
        {
          id: "vignette.preset",
          label: "Set Outbreak Vignette Art Direction Preset",
          shortLabel: "Vignette Preset",
          category: "Preset",
          undoable: true,
          args: {
            direction: {
              type: "value",
              required: true,
              description: "Direction ID (0..5) or slug ('noir', 'painterly', 'dusk', 'cozy', '70s', 'shipped')",
            },
          },
          enabled: () => true,
          run: (_ctx, args) => {
            const raw = args?.direction
            let targetId: VignetteDirectionId | undefined
            if (typeof raw === "number" && raw in VIGNETTE_DIRECTIONS) {
              targetId = raw as VignetteDirectionId
            } else if (typeof raw === "string") {
              const q = raw.trim().toLowerCase()
              if (/^[0-5]$/.test(q)) {
                targetId = Number(q) as VignetteDirectionId
              } else {
                const match = Object.values(VIGNETTE_DIRECTIONS).find(
                  d => d.slug === q || d.label.toLowerCase().includes(q) || (q === "70s" && d.id === 5) || (q === "cozy" && d.id === 4),
                )
                if (match) targetId = match.id
              }
            }
            if (targetId === undefined) {
              throw new Error("Unknown vignette direction. Expected 0..5 or 'noir', 'painterly', 'dusk', 'cozy', '70s', 'shipped'.")
            }
            applyDirectionPreset(targetId)
            context.sync()
            const spec = VIGNETTE_DIRECTIONS[targetId]
            return {
              directionPreset: spec.id,
              slug: spec.slug,
              label: spec.label,
              rendererGaps: spec.rendererGaps,
            }
          },
        },
        {
          id: "vignette.camera",
          label: "Set Outbreak Vignette Camera & Cutaway Preset",
          shortLabel: "Vignette Camera",
          category: "Scene",
          undoable: true,
          args: {
            preset: {
              type: "string",
              required: true,
              enum: ["game", "interior", "street", "target_street", "target_interior"],
              description: "Camera preset ('game', 'interior', 'street', 'target_street', 'target_interior')",
            },
            cutaway: {
              type: "string",
              required: false,
              enum: ["auto", "cutaway", "closed"],
              description: "Optional roof cutaway mode",
            },
          },
          enabled: () => true,
          run: (_ctx, args) => {
            const rawPreset = String(args?.preset ?? "game").trim().toLowerCase() as VignetteCameraPreset
            if (!(rawPreset in VIGNETTE_CAMERA_PRESETS)) {
              throw new Error(`Unknown vignette camera preset "${rawPreset}". Expected 'game', 'interior', or 'street'.`)
            }
            const rawCut = typeof args?.cutaway === "string" ? args.cutaway.trim().toLowerCase() : undefined
            const cutOverride: 0 | 1 | 2 | undefined =
              rawCut === "auto" ? 0 : rawCut === "cutaway" ? 1 : rawCut === "closed" ? 2 : undefined
            applyCameraPreset(rawPreset, cutOverride)
            context.sync()
            return {
              cameraPreset: s.cameraPreset,
              cutawayMode: s.cutawayMode,
              focus: [...stage.focus],
              distance: stage.camDist,
            }
          },
        },
        {
          id: "vignette.compare",
          label: "Set Outbreak Vignette A/B Comparison vs Shipped",
          shortLabel: "Vignette A/B",
          category: "Compare",
          undoable: true,
          args: {
            mode: {
              type: "string",
              required: true,
              enum: ["active", "shipped", "split"],
              description: "'active' (vignette), 'shipped' (baseline), or 'split' (side-by-side wipe)",
            },
            split: {
              type: "number",
              required: false,
              min: 0.1,
              max: 0.9,
              description: "Split position (0.1..0.9) when mode is 'split'",
            },
          },
          enabled: () => true,
          run: (_ctx, args) => {
            const m = String(args?.mode ?? "active").trim().toLowerCase()
            s.compareMode = m === "shipped" || m === "before" ? 1 : m === "split" ? 2 : 0
            if (typeof args?.split === "number" && Number.isFinite(args.split)) {
              s.compareSplit = Math.max(0.1, Math.min(0.9, args.split))
            }
            context.sync()
            return { compareMode: s.compareMode, compareSplit: s.compareSplit }
          },
        },
        {
          id: "vignette.surface",
          label: "Inspect or Update Vignette Surface Material Recipe",
          shortLabel: "Vignette Surface",
          category: "Inspector",
          undoable: true,
          args: {
            surface: {
              type: "string",
              required: true,
              enum: [...VIGNETTE_SURFACE_IDS],
              description: "Surface ID (wood_floor, plaster, siding, shingles, asphalt, concrete, grass)",
            },
            randomize: {
              type: "boolean",
              required: false,
              description: "Deterministically randomize this surface using tuningSeed",
            },
            tuningSeed: {
              type: "number",
              required: false,
              min: 1,
              max: 9999,
              description: "Optional tuning seed for deterministic randomization",
            },
            params: {
              type: "value",
              required: false,
              description: "Optional partial MaterialRecipeParams object to apply",
            },
          },
          enabled: () => true,
          run: (_ctx, args) => {
            const surf = String(args?.surface ?? "").trim()
            if (!isVignetteSurfaceId(surf)) {
              throw new Error(`Unknown surface "${surf}". Expected one of: ${VIGNETTE_SURFACE_IDS.join(", ")}.`)
            }
            if (typeof args?.tuningSeed === "number" && Number.isFinite(args.tuningSeed)) {
              s.tuningSeed = Math.max(1, Math.min(9999, Math.trunc(args.tuningSeed)))
            }
            if (args?.randomize === true) {
              const meta = VIGNETTE_SURFACES[surf]
              surfaceState[surf] = randomizeMaterialParams(meta.baseRecipe, s.tuningSeed + meta.slot * 31)
            }
            if (args?.params && typeof args.params === "object" && !Array.isArray(args.params)) {
              const candidate = { ...surfaceState[surf], ...(args.params as Record<string, unknown>) }
              const checked = validateMaterialParams(candidate)
              if (!checked.ok) throw new Error(checked.error)
              surfaceState[surf] = checked.value
            }
            syncActiveSurfaceToFlat(surf)
            loadActiveSurfaceSliders(surf)
            context.sync()
            return {
              surface: surf,
              tuningSeed: s.tuningSeed,
              recipe: { ...surfaceState[surf] },
            }
          },
        },
      ])
    },
  }
}
