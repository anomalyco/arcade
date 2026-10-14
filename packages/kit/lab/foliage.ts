import {
  FOLIAGE_CROWN_SHAPES,
  FOLIAGE_PARAM_SPECS,
  FOLIAGE_PRESETS,
  FOLIAGE_PRESET_IDS,
  buildFoliageTree,
  buildLegacyFoliageTree,
  emitGrassTuft,
  foliageSettings,
  foliageWindDeclarationsWgsl,
  isFoliageCrownShape,
  isFoliagePresetId,
  packFoliageUniforms,
  randomizeFoliageParams,
  resetFoliageParams,
  scatterGrassClumps,
  type FoliageCameraMode,
  type FoliageCompareMode,
  type FoliageCrownShape,
  type FoliageParams,
  type FoliagePresetId,
} from "../gpu/foliage"
import { MAT, Mesh, VERT_BYTES } from "../gpu/mesh"
import {
  legacyMaterialComparisonWgsl,
  scatterClusteredGroundCover,
  surfaceMaterialCoreWgsl,
} from "../gpu/surface-materials"
import type { LabControl } from "../lab-panel"
import { Rng } from "../sim/rng"
import { lightingDefaults } from "./lighting"
import { frameShader } from "./stage-shader"
import type { LabContext, LabSection } from "./types"

export const FOLIAGE_LIGHTING_PRESETS: Readonly<
  Record<string, { label: string; values: Partial<ReturnType<typeof lightingDefaults>> }>
> = {
  outbreak_dusk: {
    label: "Outbreak dusk (18:00)",
    values: {
      lamps: true,
      lampPower: 2.9,
      lampRadius: 13.5,
      lampHeight: 3.4,
      spot: true,
      spotPower: 3.8,
      spotAngle: 40,
      spotYaw: -118,
      spotPitch: 40,
      shadows: true,
      moon: true,
      moonPower: 0.42,
      moonAzimuth: -48,
      moonElevation: 38,
      count: 2,
      exposure: 0.08,
      tone: 1,
      temperature: 0.16,
      saturation: 1.04,
    },
  },
  outbreak_day: {
    label: "Outbreak day (14:00)",
    values: {
      lamps: false,
      lampPower: 0.6,
      lampRadius: 11,
      lampHeight: 3.5,
      spot: true,
      spotPower: 4.4,
      spotAngle: 48,
      spotYaw: -55,
      spotPitch: 56,
      shadows: true,
      moon: true,
      moonPower: 1.15,
      moonAzimuth: -42,
      moonElevation: 62,
      count: 2,
      exposure: 0.18,
      tone: 1,
      temperature: 0.12,
      saturation: 1.06,
    },
  },
  outbreak_night: {
    label: "Outbreak night (22:30)",
    values: {
      lamps: true,
      lampPower: 3.4,
      lampRadius: 14,
      lampHeight: 3.6,
      spot: true,
      spotPower: 5.2,
      spotAngle: 34,
      spotYaw: -102,
      spotPitch: 44,
      shadows: true,
      moon: true,
      moonPower: 0.22,
      moonAzimuth: -58,
      moonElevation: 46,
      count: 3,
      exposure: -0.06,
      tone: 1,
      temperature: -0.14,
      saturation: 1.02,
    },
  },
  cold_moon: {
    label: "Cold moonlight",
    values: {
      lamps: false,
      lampPower: 0.8,
      spot: true,
      spotPower: 3.2,
      spotAngle: 44,
      shadows: true,
      moon: true,
      moonPower: 0.85,
      moonAzimuth: -50,
      moonElevation: 60,
      count: 1,
      exposure: 0.05,
      tone: 1,
      temperature: -0.35,
      saturation: 0.92,
    },
  },
  stage: {
    label: "Current stage lighting",
    values: {},
  },
}

const foliageStageShader =
  frameShader +
  /* wgsl */ `
fn hash2(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}
` +
  surfaceMaterialCoreWgsl +
  legacyMaterialComparisonWgsl +
  foliageWindDeclarationsWgsl +
  /* wgsl */ `
struct FoliageStageUniforms {
  // x: time, y: compareMode (0=before, 1=after, 2=split), z: passSide (-1=before, 1=after, 0=full), w: splitX
  config: vec4f,
  // x: grassDryPatches, y: grassVariation, z: autumnMix, w: treeColorVariation
  extra: vec4f,
  wind: FoliageWindConfig,
}

@group(0) @binding(1) var<uniform> U: FoliageStageUniforms;

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
  var o: VOut;
  var world = v.pos;
  var norm = normalize(v.normal.xyz);
  let mat = i32(round(v.matAux.x));
  let isAfterPass = U.config.z >= 0.0;
  if (mat == 22 && isAfterPass) {
    let fw = applyFoliageVertexWind(world, norm, v.matAux.y, U.config.x, F.eye.xyz, U.wind);
    world = fw[0];
    norm = fw[1];
  }
  o.world = world;
  o.pos = F.vp * vec4f(world, 1.0);
  o.normal = norm;
  o.color = pow(max(v.color.rgb, vec3f(0.01)), vec3f(2.2));
  o.mat = v.matAux.x;
  o.aux = v.matAux.y;
  return o;
}

@fragment fn fs(o: VOut) -> @location(0) vec4f {
  surfaceFootprint = max(length(dpdx(o.world)), length(dpdy(o.world)));
  let compareMode = i32(round(U.config.y));
  let passSide = U.config.z;
  let splitX = U.config.w;
  if (compareMode == 2) {
    if (passSide < -0.5 && o.world.x >= splitX) { discard; }
    if (passSide > 0.5 && o.world.x < splitX) { discard; }
  }

  let mat = i32(round(o.mat));
  let n = normalize(o.normal);
  let V = normalize(F.eye.xyz - o.world);
  let isAfter = select(compareMode == 1, passSide > 0.0, compareMode == 2);

  var albedo = o.color;
  var gloss = vec2f(0.0);
  var cavity = 1.0;

  if (mat == 20) {
    let kind = i32(round(o.aux));
    let p = o.world.xz;
    if (kind == 0) {
      if (isAfter) {
        var r = defaultMaterialRecipe(4);
        r.u2.x = clamp(0.45 + U.extra.y * 0.45, 0.0, 1.0);
        r.u2.z = clamp(0.25 + U.extra.x * 0.55, 0.0, 1.0);
        let s = evalGrassSoil(p, albedo, false, r);
        albedo = s.albedo;
        gloss = s.gloss;
        cavity = s.cavity;
      } else {
        let s = evalLegacyMaterial(4, o.world, n, albedo);
        albedo = s.albedo;
        gloss = s.gloss;
      }
    } else if (kind == 2) {
      let s = evalAsphaltConcrete(p, albedo, true, defaultMaterialRecipe(3));
      albedo = s.albedo;
      gloss = s.gloss;
      cavity = s.cavity;
    } else if (kind == 5) {
      let s = evalGrassSoil(p, albedo, true, defaultMaterialRecipe(4));
      albedo = s.albedo;
      gloss = s.gloss;
      cavity = s.cavity;
    }
  } else if (mat == 24) {
    albedo *= 0.84 + surfaceNoise(vec2f(o.world.x + o.world.z, o.world.y * 0.18) * 28.0) * 0.24;
  } else if (mat == 22) {
    if (!isAfter) {
      albedo *= 0.82 + surfaceNoise(o.world.xz * 4.0 + o.world.y) * 0.30;
    } else if (o.aux < -0.02) {
      let bladeT = clamp(-o.aux, 0.0, 1.0);
      let vein = grain(o.world.xz * 2.2 + vec2f(o.world.y * 1.4), 14.0) * 0.16;
      albedo *= (0.94 + vein) * mix(0.76, 1.14, bladeT);
      gloss = vec2f(48.0, 0.24 * bladeT);
      cavity = mix(0.55, 1.0, bladeT);
    } else {
      let s = evalFoliageCanopy(o.world, n, albedo, defaultMaterialRecipe(5));
      albedo = s.albedo;
      gloss = s.gloss;
      cavity = s.cavity;
    }
  }

  // Ground contact shadow under the hero tree & companion shrubs
  if (mat == 20) {
    let dHero = length(o.world.xz - vec2f(0.0, -0.35));
    let dLeft = length(o.world.xz - vec2f(-2.7, -1.5));
    let dRight = length(o.world.xz - vec2f(2.7, -1.5));
    let treeOcc = max(
      exp(-(dHero * dHero) / 3.4) * 0.58,
      max(exp(-(dLeft * dLeft) / 1.1) * 0.42, exp(-(dRight * dRight) / 1.1) * 0.42)
    );
    cavity *= 1.0 - treeOcc;
  }

  let isFoliage = mat == 22;
  let wrap = select(0.18, 0.38, isFoliage && isAfter);
  let tipWeight = clamp(abs(o.aux), 0.0, 1.2);
  let transStrength = select(0.0, U.wind.u0.w * (0.35 + 0.65 * tipWeight), isFoliage && isAfter);

  var diff = F.ambient.rgb * (0.52 + 0.48 * max(n.y, 0.0)) * cavity;
  let moonDir = normalize(F.moon.xyz);
  let moonNdl = max(0.0, (dot(n, moonDir) + wrap) / (1.0 + wrap));
  let moonBack = max(0.0, dot(-n, moonDir)) * transStrength * 0.65;
  diff += vec3f(0.52, 0.65, 0.92) * F.moon.w * (moonNdl * cavity + moonBack);

  var spec = vec3f(0.0);
  let lightCount = min(8, i32(F.options.x));
  for (var i = 0; i < lightCount; i++) {
    let lpos = F.lights[i * 3];
    let lcol = F.lights[i * 3 + 1];
    let lcone = F.lights[i * 3 + 2];
    let delta = lpos.xyz - o.world;
    let dist = length(delta);
    if (dist >= lpos.w || lcol.w <= 0.001) { continue; }
    let ldir = delta / max(dist, 0.001);
    var atten = pow(max(0.0, 1.0 - dist / lpos.w), 2.0) * lcol.w;
    if (lcone.w > -1.0) {
      atten *= smoothstep(lcone.w, min(1.0, lcone.w + 0.08), dot(-ldir, lcone.xyz));
    }
    let ndl = max(0.0, (dot(n, ldir) + wrap) / (1.0 + wrap));
    let back = max(0.0, dot(-n, ldir)) * transStrength * 0.55;
    diff += lcol.rgb * atten * (ndl * mix(0.65, 1.0, cavity) + back);
    if (gloss.x > 0.0 && gloss.y > 0.0) {
      let h = normalize(ldir + V);
      let s = pow(max(0.0, dot(n, h)), gloss.x) * (gloss.x + 2.0) * 0.008;
      spec += lcol.rgb * atten * s * gloss.y;
    }
  }

  var color = albedo * diff * 1.15 + spec;

  if (compareMode == 2) {
    let splitLine = 1.0 - smoothstep(max(surfaceFootprint * 0.75, 0.008), max(surfaceFootprint * 1.8, 0.024), abs(o.world.x - splitX));
    color = mix(color, vec3f(0.88, 0.94, 1.0), splitLine * 0.7);
  }

  if (F.options.z == 3.0) {
    color = diff * 1.6 + spec * 2.5;
  } else if (F.options.z == 5.0) {
    color = n * 0.5 + 0.5;
  }
  return vec4f(color, 1.0);
}
`

function addGroundStage(m: Mesh): void {
  // Lawn turf pad (-5.2..5.2 in X, -3.8..2.6 in Z)
  m.box(-5.2, -0.08, -3.8, 5.2, 0.0, 2.6, [0.32, 0.39, 0.23], MAT.ground, 0)
  // Subtle rounded mulch ring directly around the hero trunk & shrub bases (no rectangular slab)
  m.prism(0, -0.35, 0.72, 0.68, 0.0, 0.015, 12, [0.20, 0.18, 0.13], MAT.ground, 5)
  m.prism(-2.7, -1.5, 0.58, 0.54, 0.0, 0.014, 10, [0.20, 0.18, 0.13], MAT.ground, 5)
  m.prism(2.7, -1.5, 0.58, 0.54, 0.0, 0.014, 10, [0.20, 0.18, 0.13], MAT.ground, 5)
  // Concrete sidewalk & curb apron along the front edge (z = 2.6..3.8)
  m.box(-5.2, -0.06, 2.6, 5.2, 0.05, 3.8, [0.60, 0.62, 0.65], MAT.ground, 2)
  // Plinth border trim
  m.box(-5.32, -0.12, -3.92, 5.32, -0.03, 3.92, [0.16, 0.18, 0.21], MAT.lit, 0)
}

function buildAfterFoliageMesh(seed: number, params: Readonly<FoliageParams>): ArrayBuffer {
  const m = new Mesh()
  addGroundStage(m)

  // Hero tree centered at x = 0, z = -0.35 so A/B split bisects it cleanly
  buildFoliageTree(m, 0, -0.35, params.treeHeight, params.crownRadius, seed * 31 + 7, 0.015, params)

  // Left and right flanking shrubs for symmetric A/B comparison & yard framing
  const shrubH = Math.max(0.95, Math.min(1.85, params.treeHeight * 0.28))
  const shrubR = Math.max(0.65, Math.min(1.25, params.crownRadius * 0.42))
  buildFoliageTree(m, -2.7, -1.5, shrubH, shrubR, seed * 17 + 3, 0.015, params, "spreading")
  buildFoliageTree(m, 2.7, -1.5, shrubH, shrubR, seed * 17 + 3, 0.015, params, "spreading")

  // Lush, clumped curved 3D grass meadow across the lawn patch (Botanics / Ghost of Tsushima density)
  const grassRng = new Rng(seed ^ 0x51a9)
  const clumps = scatterGrassClumps({
    seed: seed ^ 0x2c91,
    bounds: [-4.9, -3.5, 4.9, 2.52],
    clusterCount: 165,
    tuftsPerCluster: 5,
    params,
    avoid: (x, z) =>
      Math.hypot(x, z + 0.35) < 0.38 ||
      Math.hypot(x + 2.7, z + 1.5) < 0.35 ||
      Math.hypot(x - 2.7, z + 1.5) < 0.35,
  })
  for (const c of clumps) {
    emitGrassTuft(m, c.x, 0.0, c.z, {
      bladeCount: c.blades + 1,
      radius: c.radius * 1.15,
      height: c.height * 1.15,
      width: c.width,
      curvature: c.curvature,
      leanAngle: c.leanAngle,
      rootColor: c.rootColor,
      tipColor: c.tipColor,
      rng: grassRng,
    })
  }
  return m.pack()
}

function buildBeforeFoliageMesh(seed: number, params: Readonly<FoliageParams>): ArrayBuffer {
  const m = new Mesh()
  addGroundStage(m)

  buildLegacyFoliageTree(m, 0, -0.35, params.treeHeight, params.crownRadius, seed * 31 + 7, 0.02)
  const shrubH = Math.max(0.95, Math.min(1.85, params.treeHeight * 0.28))
  const shrubR = Math.max(0.65, Math.min(1.25, params.crownRadius * 0.42))
  buildLegacyFoliageTree(m, -2.7, -1.5, shrubH, shrubR, seed * 17 + 3, 0.02)
  buildLegacyFoliageTree(m, 2.7, -1.5, shrubH, shrubR, seed * 17 + 3, 0.02)

  // Legacy 2-triangle intersecting flat grass caltrops
  const tufts = scatterClusteredGroundCover({
    seed: seed ^ 0x2c91,
    bounds: [-4.8, -3.4, 4.8, 2.45],
    clusterCount: Math.max(1, Math.round(28 * params.grassDensity)),
    tuftsPerCluster: 4,
    avoid: (x, z) => Math.hypot(x, z + 0.35) < 0.75,
  })
  for (const t of tufts) {
    const { x, z, radius: r, height: h, tint: c } = t
    m.facet([x - r * 0.7, 0, z - r * 0.3], [x + r * 0.2, h, z + r * 0.3], [x + r * 0.8, 0, z - r * 0.2], c, MAT.foliage, 0)
    m.facet([x - r * 0.2, 0, z - r * 0.8], [x - r * 0.3, h * 0.85, z + r * 0.2], [x + r * 0.4, 0, z + r * 0.7], c, MAT.foliage, 0)
  }
  return m.pack()
}

export function createFoliage(context: LabContext): LabSection {
  const { device, stage } = context

  const settings: Record<string, string | number | boolean> = {
    playing: true,
    cameraMode: "close",
    lightingPreset: "outbreak_dusk",
    compare: 1,
    seed: 7,
    tuningSeed: 41,
  }

  let meshDirty = true
  let simTime = 0

  Object.defineProperty(settings, "treePreset", {
    configurable: true,
    enumerable: true,
    get: () => foliageSettings.treePreset,
    set: (value: unknown) => {
      if (isFoliagePresetId(value)) {
        foliageSettings.treePreset = value
        meshDirty = true
      }
    },
  })

  Object.defineProperty(settings, "crownShape", {
    configurable: true,
    enumerable: true,
    get: () => foliageSettings.crownShape,
    set: (value: unknown) => {
      if (isFoliageCrownShape(value)) {
        foliageSettings.crownShape = value
        meshDirty = true
      }
    },
  })

  for (const spec of FOLIAGE_PARAM_SPECS) {
    Object.defineProperty(settings, spec.key, {
      configurable: true,
      enumerable: true,
      get: () => foliageSettings[spec.key],
      set: (value: number) => {
        if (typeof value === "number" && Number.isFinite(value)) {
          const clamped = Math.max(spec.min, Math.min(spec.max, value))
          if (foliageSettings[spec.key] !== clamped) {
            foliageSettings[spec.key] = clamped
            if (spec.boundary === "structural") meshDirty = true
          }
        }
      },
    })
  }

  const frameBuffer = device.createBuffer({
    size: 148 * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  // meta (4) + extra (4) + wind (8) = 16 floats (64 bytes)
  const uniformDataAfter = new Float32Array(16)
  const uniformDataBefore = new Float32Array(16)
  const uniformBufferAfter = device.createBuffer({
    size: uniformDataAfter.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const uniformBufferBefore = device.createBuffer({
    size: uniformDataBefore.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  const bindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ],
  })
  const bindGroupAfter = device.createBindGroup({
    layout: bindLayout,
    entries: [
      { binding: 0, resource: { buffer: frameBuffer } },
      { binding: 1, resource: { buffer: uniformBufferAfter } },
    ],
  })
  const bindGroupBefore = device.createBindGroup({
    layout: bindLayout,
    entries: [
      { binding: 0, resource: { buffer: frameBuffer } },
      { binding: 1, resource: { buffer: uniformBufferBefore } },
    ],
  })

  const module = device.createShaderModule({ code: foliageStageShader, label: "Lab foliage stage" })
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindLayout] }),
    vertex: {
      module,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: VERT_BYTES,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "snorm8x4" },
            { shaderLocation: 2, offset: 16, format: "unorm8x4" },
            { shaderLocation: 3, offset: 20, format: "float16x2" },
          ],
        },
      ],
    },
    fragment: {
      module,
      entryPoint: "fs",
      targets: [{ format: "rgba16float" }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less-equal" },
    multisample: { count: 4 },
  })

  const uploadPackedMesh = (packed: ArrayBuffer, prev?: { buf: GPUBuffer; count: number }) => {
    prev?.buf.destroy()
    const buf = device.createBuffer({
      size: Math.max(64, packed.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    if (packed.byteLength) device.queue.writeBuffer(buf, 0, packed)
    return { buf, count: packed.byteLength / VERT_BYTES }
  }

  let afterMesh = uploadPackedMesh(buildAfterFoliageMesh(7, foliageSettings))
  let beforeMesh = uploadPackedMesh(buildBeforeFoliageMesh(7, foliageSettings))
  let builtSeed = 7

  const ensureMeshes = () => {
    const nextSeed = Math.max(1, Math.min(999, Math.round(Number(settings.seed) || 7)))
    if (!meshDirty && nextSeed === builtSeed) return
    builtSeed = nextSeed
    meshDirty = false
    afterMesh = uploadPackedMesh(buildAfterFoliageMesh(builtSeed, foliageSettings), afterMesh)
    beforeMesh = uploadPackedMesh(buildBeforeFoliageMesh(builtSeed, foliageSettings), beforeMesh)
  }

  const applyCameraMode = () => {
    const mode: FoliageCameraMode = settings.cameraMode === "game" ? "game" : "close"
    const focusY = Math.min(2.2, foliageSettings.treeHeight * 0.34)
    if (mode === "game") {
      stage.camYaw = 0
      stage.camPitch = 0.78
      stage.frameTarget(0, 0.8, 0, 38)
    } else {
      stage.camYaw = 0.24
      stage.camPitch = 0.42
      stage.frameTarget(0, focusY, -0.2, 8.8)
    }
  }

  const applyLightingPreset = () => {
    const key = String(settings.lightingPreset)
    const preset = FOLIAGE_LIGHTING_PRESETS[key]
    if (preset && Object.keys(preset.values).length > 0) {
      Object.assign(stage.lighting, preset.values)
    }
    if (key === "outbreak_dusk") {
      stage.dynamicLights = [
        { x: -3.2, y: 4.2, z: 2.8, radius: 14, r: 1.0, g: 0.76, b: 0.48, power: 2.8 },
        { x: 3.4, y: 2.6, z: -2.2, radius: 11, r: 1.0, g: 0.64, b: 0.34, power: 1.8 },
      ]
    } else if (key === "outbreak_day") {
      stage.dynamicLights = [
        { x: -2.5, y: 6.0, z: 3.5, radius: 16, r: 1.0, g: 0.94, b: 0.80, power: 2.6 },
        { x: 3.0, y: 4.5, z: -2.5, radius: 13, r: 0.68, g: 0.82, b: 1.0, power: 1.1 },
      ]
    } else if (key === "outbreak_night") {
      stage.dynamicLights = [
        { x: -3.4, y: 3.8, z: 2.6, radius: 13, r: 1.0, g: 0.74, b: 0.44, power: 3.2 },
        { x: 2.8, y: 2.2, z: -1.8, radius: 9.5, r: 1.0, g: 0.58, b: 0.26, power: 2.1 },
      ]
    } else if (key === "cold_moon") {
      stage.dynamicLights = [
        { x: -3.0, y: 5.5, z: 3.0, radius: 14, r: 0.56, g: 0.74, b: 1.0, power: 1.6 },
      ]
    } else {
      stage.dynamicLights = null
    }
    context.sync()
  }

  const runRandomize = (scope: "all" | "tree" | "grass") => {
    const tSeed = Math.max(1, Math.min(9999, Math.round(Number(settings.tuningSeed) || 41)))
    const next = randomizeFoliageParams(foliageSettings, tSeed, scope)
    Object.assign(foliageSettings, next)
    settings.tuningSeed = (tSeed % 9999) + 1
    meshDirty = true
    ensureMeshes()
    context.sync()
  }

  const controls: LabControl[] = [
    {
      key: "treePreset",
      label: "Preset",
      group: "Stage & View",
      type: "select",
      options: FOLIAGE_PRESET_IDS.map(id => ({ value: id, label: FOLIAGE_PRESETS[id].label })),
      change: val => {
        const id: FoliagePresetId = isFoliagePresetId(val) ? val : "oak"
        resetFoliageParams(id, foliageSettings)
        meshDirty = true
        ensureMeshes()
        context.sync()
      },
    },
    {
      key: "crownShape",
      label: "Crown shape",
      group: "Stage & View",
      type: "select",
      options: [...FOLIAGE_CROWN_SHAPES],
      change: () => {
        meshDirty = true
        ensureMeshes()
        context.sync()
      },
    },
    {
      key: "cameraMode",
      label: "Camera view",
      group: "Stage & View",
      type: "select",
      options: [
        { value: "close", label: "Close inspect (8.8 m)" },
        { value: "game", label: "Game camera (38 m)" },
      ],
      change: () => {
        applyCameraMode()
        context.sync()
      },
    },
    {
      key: "lightingPreset",
      label: "Lighting preset",
      group: "Stage & View",
      type: "select",
      options: Object.entries(FOLIAGE_LIGHTING_PRESETS).map(([value, p]) => ({ value, label: p.label })),
      change: applyLightingPreset,
    },
    {
      key: "compare",
      label: "Comparison",
      group: "Stage & View",
      type: "select",
      options: [
        { value: 1, label: "Improved foliage (After)" },
        { value: 0, label: "Shipped baseline (Before)" },
        { value: 2, label: "A/B split (Before | After)" },
      ],
      change: () => context.sync(),
    },
    {
      key: "seed",
      label: "Structure seed",
      group: "Stage & View",
      type: "range",
      min: 1,
      max: 999,
      step: 1,
      unit: "",
      change: () => {
        meshDirty = true
        ensureMeshes()
      },
    },
    {
      key: "tuningSeed",
      label: "Tuning seed",
      group: "Stage & View",
      type: "range",
      min: 1,
      max: 9999,
      step: 1,
      unit: "",
    },
    {
      key: "foliage.randomizeAll",
      label: "Randomize Tree + Grass",
      group: "Stage & View",
      type: "action",
      run: () => runRandomize("all"),
    },
    {
      key: "foliage.resetPreset",
      label: "Reset to preset defaults",
      group: "Stage & View",
      type: "action",
      run: () => {
        resetFoliageParams(foliageSettings.treePreset, foliageSettings)
        meshDirty = true
        ensureMeshes()
        context.sync()
      },
    },
  ]

  for (const spec of FOLIAGE_PARAM_SPECS) {
    controls.push({
      key: spec.key,
      label: spec.label,
      group: spec.group,
      type: "range",
      min: spec.min,
      max: spec.max,
      step: spec.step,
      unit: spec.unit,
      change: () => {
        if (spec.boundary === "structural") {
          meshDirty = true
          ensureMeshes()
        }
      },
    })
    if (spec.key === "porosity") {
      controls.push({
        key: "foliage.randomizeTree",
        label: "Randomize Tree",
        group: "Tree Structure",
        type: "action",
        run: () => runRandomize("tree"),
      })
    }
    if (spec.key === "grassClumping") {
      controls.push({
        key: "foliage.randomizeGrass",
        label: "Randomize Grass",
        group: "Grass Blades",
        type: "action",
        run: () => runRandomize("grass"),
      })
    }
  }

  return {
    id: "foliage",
    label: "Foliage",
    settings,
    controls,
    enter() {
      stage.sceneMode = 5
      applyLightingPreset()
      applyCameraMode()
      ensureMeshes()
    },
    leave() {
      stage.dynamicLights = null
    },
    update(dt) {
      if (settings.playing) {
        simTime += dt
      }
    },
    retrigger() {
      simTime = 0
      meshDirty = true
      ensureMeshes()
    },
    reroll() {
      settings.seed = (((Number(settings.seed) * 1664525 + 1013904223) >>> 0) % 999) + 1
      meshDirty = true
      ensureMeshes()
      context.sync()
    },
    frameTarget: () => {
      const mode: FoliageCameraMode = settings.cameraMode === "game" ? "game" : "close"
      return mode === "game"
        ? { x: 0, y: 0.8, z: 0, dist: 38 }
        : { x: 0, y: Math.min(2.2, foliageSettings.treeHeight * 0.34), z: -0.2, dist: 8.8 }
    },
    prepare() {
      stage.sceneMode = 5
      ensureMeshes()
    },
    draw(pass) {
      const frame = (stage as unknown as { frame: Float32Array }).frame
      if (frame) {
        device.queue.writeBuffer(frameBuffer, 0, frame.buffer, frame.byteOffset, frame.byteLength)
      }
      const compareMode: FoliageCompareMode =
        Number(settings.compare) === 0 ? 0 : Number(settings.compare) === 2 ? 2 : 1

      const fillUniform = (arr: Float32Array<ArrayBuffer>, buf: GPUBuffer, passSide: number) => {
        arr[0] = simTime
        arr[1] = compareMode
        arr[2] = passSide
        arr[3] = 0.0
        arr[4] = foliageSettings.dryPatches
        arr[5] = foliageSettings.grassVariation
        arr[6] = foliageSettings.autumnMix
        arr[7] = foliageSettings.treeColorVariation
        packFoliageUniforms(foliageSettings, arr, 8)
        device.queue.writeBuffer(buf, 0, arr)
      }

      pass.setPipeline(pipeline)

      if (compareMode === 0) {
        fillUniform(uniformDataBefore, uniformBufferBefore, -1)
        pass.setBindGroup(0, bindGroupBefore)
        pass.setVertexBuffer(0, beforeMesh.buf)
        pass.draw(beforeMesh.count)
      } else if (compareMode === 1) {
        fillUniform(uniformDataAfter, uniformBufferAfter, 1)
        pass.setBindGroup(0, bindGroupAfter)
        pass.setVertexBuffer(0, afterMesh.buf)
        pass.draw(afterMesh.count)
      } else {
        // A/B split: draw left half with Before mesh, right half with After mesh.
        fillUniform(uniformDataBefore, uniformBufferBefore, -1)
        fillUniform(uniformDataAfter, uniformBufferAfter, 1)
        pass.setBindGroup(0, bindGroupBefore)
        pass.setVertexBuffer(0, beforeMesh.buf)
        pass.draw(beforeMesh.count)
        pass.setBindGroup(0, bindGroupAfter)
        pass.setVertexBuffer(0, afterMesh.buf)
        pass.draw(afterMesh.count)
      }
    },
    telemetry() {
      const preset = FOLIAGE_PRESETS[foliageSettings.treePreset]?.label ?? foliageSettings.treePreset
      const cmp = Number(settings.compare) === 0 ? "Before" : Number(settings.compare) === 2 ? "A/B Split" : "After"
      return `Foliage · ${preset} (${cmp}) {"verts":${afterMesh.count},"softness":${foliageSettings.normalSoftness.toFixed(2)},"wind":${foliageSettings.treeWindStrength.toFixed(2)}}`
    },
  }
}
