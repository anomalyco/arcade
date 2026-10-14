import {
  MATERIAL_PARAM_SPECS,
  MATERIAL_RECIPES,
  MATERIAL_RECIPE_IDS,
  cloneMaterialParams,
  isMaterialRecipeId,
  legacyMaterialComparisonWgsl,
  packMaterialParams,
  randomizeMaterialParams,
  scatterClusteredGroundCover,
  surfaceMaterialCoreWgsl,
  type MaterialCompareMode,
  type MaterialRecipeId,
  type MaterialRecipeParams,
  type MaterialSwatchMode,
} from "../gpu/surface-materials"
import type { LabControl } from "../lab-panel"
import { lightingDefaults } from "./lighting"
import { frameShader } from "./stage-shader"
import type { LabContext, LabSection, MaterialAdapter } from "./types"

const SWATCH_LIGHTING_PRESETS: Record<string, { label: string; values: Partial<ReturnType<typeof lightingDefaults>> }> = {
  stage: { label: "Current stage lighting", values: {} },
  outbreak_dusk: {
    label: "Outbreak dusk",
    values: {
      lamps: true,
      lampPower: 2.8,
      lampRadius: 13,
      lampHeight: 3.1,
      spot: true,
      spotPower: 3.6,
      spotAngle: 38,
      spotYaw: -115,
      spotPitch: 42,
      shadows: true,
      moon: true,
      moonPower: 0.28,
      moonAzimuth: -48,
      moonElevation: 52,
      count: 2,
      exposure: 0.05,
      tone: 1,
      temperature: 0.14,
      saturation: 1.02,
    },
  },
  warm_interior: {
    label: "Warm interior lamp",
    values: {
      lamps: true,
      lampPower: 3.4,
      lampRadius: 12,
      lampHeight: 2.6,
      spot: false,
      spotPower: 0,
      shadows: true,
      moon: true,
      moonPower: 0.12,
      moonAzimuth: -35,
      moonElevation: 48,
      count: 2,
      exposure: 0.1,
      tone: 1,
      temperature: 0.28,
      saturation: 1.04,
    },
  },
  neutral: {
    label: "Neutral stage",
    values: {
      lamps: true,
      lampPower: 2.2,
      lampRadius: 11,
      lampHeight: 3.2,
      spot: true,
      spotPower: 4.0,
      spotAngle: 40,
      spotYaw: -120,
      spotPitch: 40,
      shadows: true,
      moon: true,
      moonPower: 0.38,
      moonAzimuth: -45,
      moonElevation: 55,
      count: 2,
      exposure: 0,
      tone: 0,
      temperature: 0,
      saturation: 1,
    },
  },
  night_street: {
    label: "Night street",
    values: {
      lamps: true,
      lampPower: 3.2,
      lampRadius: 14,
      lampHeight: 3.8,
      spot: true,
      spotPower: 6,
      spotAngle: 32,
      spotYaw: -95,
      spotPitch: 45,
      shadows: true,
      moon: true,
      moonPower: 0.18,
      moonAzimuth: -60,
      moonElevation: 42,
      count: 4,
      exposure: -0.1,
      tone: 1,
      temperature: -0.18,
      saturation: 1.05,
    },
  },
  cold_moon: {
    label: "Cold moon",
    values: {
      lamps: false,
      lampPower: 0.8,
      spot: true,
      spotPower: 3.5,
      spotAngle: 44,
      shadows: true,
      moon: true,
      moonPower: 0.85,
      moonAzimuth: -50,
      moonElevation: 62,
      count: 1,
      exposure: 0.05,
      tone: 1,
      temperature: -0.4,
      saturation: 0.9,
    },
  },
}

const materialSwatchShader =
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
  /* wgsl */ `
struct MaterialStageUniforms {
  // x: activeRecipeIndex, y: compareMode (0=before, 1=after, 2=split), z: swatchMode, w: splitX
  config: vec4f,
  recipes: array<MaterialRecipe, 6>,
}

@group(0) @binding(1) var<uniform> M: MaterialStageUniforms;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) matKind: f32,
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) @interpolate(flat) matKind: f32,
}

@vertex fn vs(v: VIn) -> VOut {
  var o: VOut;
  o.world = v.pos;
  o.pos = F.vp * vec4f(v.pos, 1.0);
  o.normal = normalize(v.normal);
  o.color = v.color;
  o.matKind = v.matKind;
  return o;
}

@fragment fn fs(o: VOut) -> @location(0) vec4f {
  // Compute world-space pixel footprint in uniform control flow before any recipe branches.
  surfaceFootprint = max(length(dpdx(o.world)), length(dpdy(o.world)));
  let n = normalize(o.normal);
  let V = normalize(F.eye.xyz - o.world);

  let rawKind = i32(round(o.matKind));
  let activeRecipe = clamp(i32(round(M.config.x)), 0, 5);
  let recipeId = clamp(select(rawKind, activeRecipe, rawKind < 0), 0, 5);
  let compareMode = i32(round(M.config.y));
  let splitX = M.config.w;
  let useAfter = select(compareMode == 1, o.world.x >= splitX, compareMode == 2);

  // Triplanar-aware evaluation coordinate so vertical block faces and the calibration sphere equator don't stretch xz.
  let evalWorld = select(vec3f(o.world.x + o.world.z * 0.35, o.world.y, o.world.y + o.world.z * 0.25), o.world, abs(n.y) > 0.52);

  var sample: SurfaceSample;
  if (rawKind == 10) {
    // Neutral architectural trim / plinth border.
    sample = SurfaceSample(pow(o.color, vec3f(2.2)), vec2f(0.0, 0.0), 0.9, 1.0);
  } else if (useAfter) {
    let r = M.recipes[recipeId];
    // Convert perceptual sRGB base sliders to linear light (matching production makeSceneShader's pow(v.color, 2.2)).
    let linearBase = pow(max(r.u0.xyz, vec3f(0.02)), vec3f(2.2));
    sample = evalRecipeById(recipeId, evalWorld, n, linearBase, r);
  } else {
    let def = defaultMaterialRecipe(recipeId).u0.xyz;
    let linearDef = pow(max(def, vec3f(0.02)), vec3f(2.2));
    sample = evalLegacyMaterial(recipeId, evalWorld, n, linearDef);
  }

  // Stage lighting: ambient + directional moon + up to 8 stage lights with specular response.
  var diff = F.ambient.rgb * (0.55 + 0.45 * max(n.y, 0.0)) * sample.cavity;
  let moonDir = normalize(F.moon.xyz);
  diff += vec3f(0.48, 0.61, 0.90) * F.moon.w * max(0.0, dot(n, moonDir)) * sample.cavity;

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
    let ndl = max(0.0, (dot(n, ldir) + 0.15) / 1.15);
    diff += lcol.rgb * atten * ndl * mix(0.65, 1.0, sample.cavity);
    if (sample.gloss.x > 0.0 && sample.gloss.y > 0.0) {
      let h = normalize(ldir + V);
      let s = pow(max(0.0, dot(n, h)), sample.gloss.x) * (sample.gloss.x + 2.0) * 0.008;
      spec += lcol.rgb * atten * s * sample.gloss.y;
      // Legacy glossy floor lamp streak (demonstrates why matte wood removes broad lamp sheen).
      if (!useAfter && recipeId == 0 && n.y > 0.85) {
        let k = lpos.y / max(0.1, lpos.y + F.eye.y);
        let pm = lpos.xz + (F.eye.xz - lpos.xz) * k;
        let q = o.world.xz - pm;
        let r2 = dot(q, q) / 0.55;
        spec += lcol.rgb * lcol.w * exp(-r2) * 0.22;
      }
    }
  }

  var color = sample.albedo * diff * 1.15 + spec;

  // Subtle split indicator line in A/B Split mode (compareMode == 2).
  if (compareMode == 2) {
    let splitLine = 1.0 - smoothstep(max(surfaceFootprint * 0.75, 0.008), max(surfaceFootprint * 1.8, 0.022), abs(o.world.x - splitX));
    color = mix(color, vec3f(0.85, 0.92, 0.98), splitLine * 0.65);
  }

  // Respect Lab debug views: 3 = Lighting only, 5 = Normals.
  if (F.options.z == 3.0) {
    color = diff * 1.6 + spec * 2.5;
  } else if (F.options.z == 5.0) {
    color = n * 0.5 + 0.5;
  }
  return vec4f(color, 1.0);
}
`

type VertexSink = number[]

function pushTri(
  out: VertexSink,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  n: readonly [number, number, number],
  col: readonly [number, number, number],
  matKind: number,
) {
  for (const p of [a, b, c]) {
    out.push(p[0], p[1], p[2], n[0], n[1], n[2], col[0], col[1], col[2], matKind)
  }
}

function pushQuad(
  out: VertexSink,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  d: readonly [number, number, number],
  n: readonly [number, number, number],
  col: readonly [number, number, number],
  matKind: number,
) {
  pushTri(out, a, b, c, n, col, matKind)
  pushTri(out, a, c, d, n, col, matKind)
}

function pushBox(
  out: VertexSink,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  col: readonly [number, number, number],
  matKind: number,
) {
  pushQuad(out, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], col, matKind)
  pushQuad(out, [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0], col, matKind)
  pushQuad(out, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], col, matKind)
  pushQuad(out, [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1], [0, 0, 1], col, matKind)
  pushQuad(out, [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [0, 0, -1], col, matKind)
}

function pushSphere(
  out: VertexSink,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  col: readonly [number, number, number],
  matKind: number,
  rings = 22,
  segments = 36,
) {
  for (let r = 0; r < rings; r++) {
    const v0 = r / rings
    const v1 = (r + 1) / rings
    const th0 = v0 * Math.PI
    const th1 = v1 * Math.PI
    for (let s = 0; s < segments; s++) {
      const u0 = (s / segments) * Math.PI * 2
      const u1 = ((s + 1) / segments) * Math.PI * 2
      const p = (th: number, u: number): [[number, number, number], [number, number, number]] => {
        const nx = Math.sin(th) * Math.cos(u)
        const ny = Math.cos(th)
        const nz = Math.sin(th) * Math.sin(u)
        return [
          [cx + nx * radius, cy + ny * radius, cz + nz * radius],
          [nx, ny, nz],
        ]
      }
      const [p00, n00] = p(th0, u0)
      const [p10, n10] = p(th0, u1)
      const [p11, n11] = p(th1, u1)
      const [p01, n01] = p(th1, u0)
      for (const [pt, nm] of [
        [p00, n00],
        [p11, n11],
        [p10, n10],
        [p00, n00],
        [p01, n01],
        [p11, n11],
      ] as const) {
        out.push(pt[0], pt[1], pt[2], nm[0], nm[1], nm[2], col[0], col[1], col[2], matKind)
      }
    }
  }
}

function buildBallSwatch(): Float32Array {
  const out: number[] = []
  const white: [number, number, number] = [1, 1, 1]
  // Ground swatch pad centered at x=0 so A/B split cuts cleanly across both pad and hero sphere.
  pushBox(out, -4.4, -0.08, -3.2, 4.4, 0.0, 3.2, white, -1)
  pushBox(out, -4.52, -0.12, -3.32, 4.52, -0.02, 3.32, [0.16, 0.18, 0.21], 10)
  // Center material calibration ball + dark plinth ring.
  pushBox(out, -0.85, 0.0, -0.95, 0.85, 0.14, 0.75, [0.18, 0.20, 0.23], 10)
  pushSphere(out, 0, 1.32, -0.1, 1.22, white, -1)
  // Paired left/right architectural blocks so A/B split compares identical angled faces side-by-side.
  pushBox(out, -2.95, 0.0, -0.8, -1.65, 1.25, 0.5, white, -1)
  pushBox(out, 1.65, 0.0, -0.8, 2.95, 1.25, 0.5, white, -1)
  return new Float32Array(out)
}

function buildPlaneSwatch(): Float32Array {
  const out: number[] = []
  const white: [number, number, number] = [1, 1, 1]
  pushBox(out, -5.2, -0.08, -3.8, 5.2, 0.0, 3.8, white, -1)
  pushBox(out, -5.35, -0.12, -3.95, 5.35, -0.02, 3.95, [0.16, 0.18, 0.21], 10)
  // Low grazing curb bars at the rear edge to show contact & normal response.
  pushBox(out, -4.8, 0.0, -3.45, -0.15, 0.22, -3.05, white, -1)
  pushBox(out, 0.15, 0.0, -3.45, 4.8, 0.22, -3.05, white, -1)
  return new Float32Array(out)
}

function buildRoomSwatch(roomSeed: number): Float32Array {
  const out: number[] = []
  // 1. Interior hardwood floor (wood_planks = 0), symmetric across x=0 for A/B split.
  pushBox(out, -4.2, 0.0, -3.5, 4.2, 0.12, 0.35, [0.55, 0.43, 0.31], 0)
  // 2. Interior plaster back wall & side wing walls (plaster_wall = 2) with dark baseboard.
  pushBox(out, -4.2, 0.12, -3.5, 4.2, 2.35, -3.28, [0.44, 0.40, 0.33], 2)
  pushBox(out, -4.2, 0.12, -3.28, -3.98, 2.15, 0.35, [0.43, 0.39, 0.32], 2)
  pushBox(out, 3.98, 0.12, -3.28, 4.2, 2.15, 0.35, [0.43, 0.39, 0.32], 2)
  pushBox(out, -4.18, 0.12, -3.28, 4.18, 0.26, -3.24, [0.24, 0.21, 0.17], 10)
  // 3. Exterior cobblestone walk & stoop (cobblestone = 1) centered across x=0.
  pushBox(out, -1.65, 0.0, 0.35, 1.65, 0.08, 2.35, [0.48, 0.47, 0.42], 1)
  // 4. Lawn turf wings (grass_soil = 4) flanking the cobblestone walk.
  pushBox(out, -4.2, 0.0, 0.35, -1.65, 0.05, 2.35, [0.34, 0.39, 0.26], 4)
  pushBox(out, 1.65, 0.0, 0.35, 4.2, 0.05, 2.35, [0.34, 0.39, 0.26], 4)
  // 5. Street asphalt & sidewalk apron (asphalt_concrete = 3) along the front.
  pushBox(out, -4.2, -0.02, 2.35, 4.2, 0.03, 3.85, [0.24, 0.26, 0.28], 3)
  // 6. Clustered foliage & ground cover (foliage_canopy = 5) in both left and right yard beds.
  const tufts = scatterClusteredGroundCover({
    seed: roomSeed,
    bounds: [1.85, 0.55, 3.85, 2.1],
    clusterCount: 4,
    tuftsPerCluster: 5,
  })
  for (const t of tufts) {
    for (const sign of [-1, 1] as const) {
      const cx = sign * t.x
      const cz = t.z
      const r = t.radius * 1.15
      const h = t.height * 1.45
      const top: [number, number, number] = [cx, 0.05 + h, cz]
      for (let i = 0; i < 4; i++) {
        const a0 = (i / 4) * Math.PI * 2 + 0.3
        const a1 = ((i + 1) / 4) * Math.PI * 2 + 0.3
        const p0: [number, number, number] = [cx + Math.cos(a0) * r, 0.05 + h * 0.25, cz + Math.sin(a0) * r]
        const p1: [number, number, number] = [cx + Math.cos(a1) * r, 0.05 + h * 0.25, cz + Math.sin(a1) * r]
        const nx = Math.cos((a0 + a1) * 0.5) * 0.45
        const nz = Math.sin((a0 + a1) * 0.5) * 0.45
        pushTri(out, top, p0, p1, [nx, 0.88, nz], t.tint, 5)
      }
    }
  }
  return new Float32Array(out)
}

export function createMaterials(context: LabContext, adapters: readonly MaterialAdapter[]): LabSection {
  const { device, stage } = context
  const entries = adapters.flatMap(adapter =>
    Object.entries(adapter.codes).map(([name, code]) => ({ adapter, name, code })),
  )

  const recipeStore: Record<MaterialRecipeId, MaterialRecipeParams> = {
    wood_planks: cloneMaterialParams("wood_planks"),
    cobblestone: cloneMaterialParams("cobblestone"),
    plaster_wall: cloneMaterialParams("plaster_wall"),
    asphalt_concrete: cloneMaterialParams("asphalt_concrete"),
    grass_soil: cloneMaterialParams("grass_soil"),
    foliage_canopy: cloneMaterialParams("foliage_canopy"),
  }

  const settings: Record<string, string | number | boolean> = {
    recipe: "wood_planks",
    swatch: "room",
    compare: 1,
    lightingPreset: "stage",
    roomSeed: 7,
    tuningSeed: 41,
    material: 0,
  }

  for (const id of MATERIAL_RECIPE_IDS) {
    for (const spec of MATERIAL_PARAM_SPECS) {
      const key = `${id}.${spec.key}`
      Object.defineProperty(settings, key, {
        configurable: true,
        enumerable: true,
        get: () => recipeStore[id][spec.key],
        set: (value: number) => {
          if (typeof value === "number" && Number.isFinite(value)) {
            recipeStore[id][spec.key] = Math.max(spec.min, Math.min(spec.max, value))
          }
        },
      })
    }
  }

  // GPU pipeline and buffers sharing the production WGSL recipe evaluators.
  const frameBuffer = device.createBuffer({
    size: 148 * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  // meta (4 floats) + 6 recipes * 12 floats = 76 floats (304 bytes, aligned to 16 bytes)
  const materialUniformData = new Float32Array(76)
  const materialUniformBuffer = device.createBuffer({
    size: materialUniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  const bindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ],
  })
  const bindGroup = device.createBindGroup({
    layout: bindLayout,
    entries: [
      { binding: 0, resource: { buffer: frameBuffer } },
      { binding: 1, resource: { buffer: materialUniformBuffer } },
    ],
  })

  const module = device.createShaderModule({ code: materialSwatchShader, label: "Lab materials swatch" })
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindLayout] }),
    vertex: {
      module,
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
      module,
      entryPoint: "fs",
      targets: [{ format: "rgba16float" }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less-equal" },
    multisample: { count: 4 },
  })

  const createMeshBuffer = (verts: Float32Array) => {
    const buf = device.createBuffer({
      size: Math.max(40, verts.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(buf, 0, verts.buffer, verts.byteOffset, verts.byteLength)
    return { buf, count: verts.length / 10 }
  }

  const ballMesh = createMeshBuffer(buildBallSwatch())
  const planeMesh = createMeshBuffer(buildPlaneSwatch())
  let roomMeshSeed = Number(settings.roomSeed)
  let roomMesh = createMeshBuffer(buildRoomSwatch(roomMeshSeed))

  const rebuildRoomMesh = () => {
    const nextSeed = Math.max(1, Math.min(999, Math.round(Number(settings.roomSeed) || 7)))
    if (nextSeed === roomMeshSeed) return
    roomMeshSeed = nextSeed
    roomMesh.buf.destroy()
    roomMesh = createMeshBuffer(buildRoomSwatch(roomMeshSeed))
  }

  const applyLightingPreset = () => {
    const key = String(settings.lightingPreset)
    const preset = SWATCH_LIGHTING_PRESETS[key]
    if (preset && Object.keys(preset.values).length > 0) {
      Object.assign(stage.lighting, preset.values)
    }
    context.sync()
  }

  const controls: LabControl[] = [
    {
      key: "recipe",
      label: "Recipe",
      group: "Swatch",
      type: "select",
      options: MATERIAL_RECIPE_IDS.map(id => ({ value: id, label: MATERIAL_RECIPES[id].label })),
      change: () => context.sync(),
    },
    {
      key: "swatch",
      label: "Swatch geometry",
      group: "Swatch",
      type: "select",
      options: [
        { value: "room", label: "Room & walk vignette" },
        { value: "ball", label: "Material ball & blocks" },
        { value: "plane", label: "Surface plane" },
      ],
      change: () => context.sync(),
    },
    {
      key: "compare",
      label: "Comparison",
      group: "Swatch",
      type: "select",
      options: [
        { value: 1, label: "New recipe (After)" },
        { value: 0, label: "Current baseline (Before)" },
        { value: 2, label: "A/B split (Before | After)" },
      ],
      change: () => context.sync(),
    },
    {
      key: "lightingPreset",
      label: "Lighting preset",
      group: "Swatch",
      type: "select",
      options: Object.entries(SWATCH_LIGHTING_PRESETS).map(([value, p]) => ({ value, label: p.label })),
      change: applyLightingPreset,
    },
    {
      key: "roomSeed",
      label: "Room seed",
      group: "Swatch",
      type: "range",
      min: 1,
      max: 999,
      step: 1,
      unit: "",
      change: rebuildRoomMesh,
    },
    {
      key: "tuningSeed",
      label: "Tuning seed",
      group: "Swatch",
      type: "range",
      min: 1,
      max: 9999,
      step: 1,
      unit: "",
    },
  ]

  for (const id of MATERIAL_RECIPE_IDS) {
    const def = MATERIAL_RECIPES[id]
    const groupName = def.label
    for (const spec of MATERIAL_PARAM_SPECS) {
      controls.push({
        key: `${id}.${spec.key}`,
        label: spec.label,
        group: groupName,
        type: "range",
        min: spec.min,
        max: spec.max,
        step: spec.step,
        unit: spec.unit,
        visible: s => s.recipe === id,
      })
    }
    controls.push({
      key: `${id}.randomize`,
      label: `Randomize ${groupName}`,
      group: groupName,
      type: "action",
      visible: s => s.recipe === id,
      run: () => {
        const seed = Math.max(1, Math.min(9999, Math.round(Number(settings.tuningSeed) || 1)))
        const next = randomizeMaterialParams(id, seed)
        Object.assign(recipeStore[id], next)
        settings.tuningSeed = (seed % 9999) + 1
        context.sync()
      },
    })
  }

  if (entries.length) {
    controls.push({
      key: "material",
      label: "Material code",
      group: "Game Catalog",
      folded: true,
      type: "select",
      options: entries.map((e, value) => ({ value, label: `${e.adapter.game} · ${e.code} ${e.name}` })),
    })
  }

  const currentAdapterEntry = () => entries[Number(settings.material) || 0]
  const activeRecipeDef = () => {
    const id = String(settings.recipe)
    return isMaterialRecipeId(id) ? MATERIAL_RECIPES[id] : MATERIAL_RECIPES.wood_planks
  }

  return {
    id: "materials",
    label: "Materials",
    settings,
    controls,
    enter() {
      stage.sceneMode = 5
      stage.frameTarget(0, 0.55, 0.2, 9.5)
    },
    retrigger() {
      rebuildRoomMesh()
    },
    reroll() {
      settings.roomSeed = ((Number(settings.roomSeed) * 1664525 + 1013904223) >>> 0) % 999 + 1
      rebuildRoomMesh()
      context.sync()
    },
    frameTarget: () => ({ x: 0, y: 0.55, z: 0.2, dist: 9.5 }),
    prepare() {
      stage.sceneMode = 5
      rebuildRoomMesh()
      const def = activeRecipeDef()
      const swatchMode: MaterialSwatchMode =
        settings.swatch === "ball" ? "ball" : settings.swatch === "plane" ? "plane" : "room"
      const compareMode: MaterialCompareMode =
        Number(settings.compare) === 0 ? 0 : Number(settings.compare) === 2 ? 2 : 1

      materialUniformData[0] = def.index
      materialUniformData[1] = compareMode
      materialUniformData[2] = swatchMode === "room" ? 0 : swatchMode === "ball" ? 1 : 2
      materialUniformData[3] = 0.0

      for (const id of MATERIAL_RECIPE_IDS) {
        const idx = MATERIAL_RECIPES[id].index
        packMaterialParams(recipeStore[id], materialUniformData, 4 + idx * 12)
      }
      device.queue.writeBuffer(materialUniformBuffer, 0, materialUniformData)

      // Mirror Stage's current frame uniform block into our material pipeline uniform buffer.
      currentAdapterEntry()?.adapter.prepare?.(currentAdapterEntry()!.code, context)
    },
    draw(pass) {
      const frame = (stage as unknown as { frame: Float32Array }).frame
      if (frame) {
        device.queue.writeBuffer(frameBuffer, 0, frame.buffer, frame.byteOffset, frame.byteLength)
      }
      const swatchMode = settings.swatch
      const mesh = swatchMode === "ball" ? ballMesh : swatchMode === "plane" ? planeMesh : roomMesh
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.setVertexBuffer(0, mesh.buf)
      pass.draw(mesh.count)
      const e = currentAdapterEntry()
      e?.adapter.draw?.(pass, e.code)
    },
    telemetry() {
      const def = activeRecipeDef()
      const params = recipeStore[def.id]
      const cmp = Number(settings.compare) === 0 ? "Before" : Number(settings.compare) === 2 ? "A/B Split" : "After"
      return `Materials · ${def.label} (${cmp}) {"roughness":${params.roughness.toFixed(2)},"scale":${params.scale.toFixed(2)},"wear":${params.wear.toFixed(2)}}`
    },
  }
}
