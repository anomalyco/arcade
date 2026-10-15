import {
  RUG_CONTROLS,
  RUG_MOTIF_IDS,
  RUG_PALETTE_IDS,
  RUG_STYLE_DEFS,
  RUG_STYLE_IDS,
  RugGpuBaker,
  createDefaultRugParams,
  createRugSampler,
  isRugMotifId,
  isRugPaletteId,
  isRugStyleId,
  randomizeRugParams,
  seededRugParamsForSlot,
  type RugMotifId,
  type RugPaletteId,
  type RugParams,
  type RugStyleId,
  type RugSymmetryMode,
} from "../rugs"
import { surfaceMaterialCoreWgsl } from "../gpu/surface-materials"
import { createFallbackMaterialTextureArray, loadMaterialTextureArray } from "../textures/loader"
import type { LabCommandRegistry } from "../lab-commands"
import type { LabControl, LabSettings } from "../lab-panel"
import { frameShader } from "./stage-shader"
import type { LabContext, LabSection } from "./types"

const rugLabShader =
  frameShader +
  /* wgsl */ `
fn hash2(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}
` +
  surfaceMaterialCoreWgsl +
  /* wgsl */ `
struct RugStageUniforms {
  // x: compareMode (0=crude boxes, 1=procedural, 2=split crude|proc, 3=256tex, 4=split 256tex|proc)
  // y: swatchMode (0=parlor, 1=flat, 2=gallery), z: pileHeight, w: aspect
  config: vec4f,
}

@group(0) @binding(1) var<uniform> RS: RugStageUniforms;
@group(0) @binding(2) var rugArray: texture_2d_array<f32>;
@group(0) @binding(3) var rugSamp: sampler;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) matLayer: vec2f, // x: matKind (0=rug, 1=parquet, 2=wainscot_wall, 3=trim), y: rugLayer
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) @interpolate(flat) matLayer: vec2f,
}

@vertex fn vs(v: VIn) -> VOut {
  var o: VOut;
  o.world = v.pos;
  o.pos = F.vp * vec4f(v.pos, 1.0);
  o.normal = normalize(v.normal);
  o.uv = v.uv;
  o.matLayer = v.matLayer;
  return o;
}

fn evalCrudeConcentricBoxes(uv: vec2f) -> vec3f {
  let dx = abs(uv.x - 0.5) * 2.0;
  let dy = abs(uv.y - 0.5) * 2.0;
  let d = max(dx, dy);
  if (d > 0.92) { return pow(vec3f(0.36, 0.30, 0.23), vec3f(2.2)); }
  if (d > 0.82) { return pow(vec3f(0.11, 0.14, 0.17), vec3f(2.2)); }
  if (d > 0.42) { return pow(vec3f(0.32, 0.14, 0.11), vec3f(2.2)); }
  if (d > 0.25) { return pow(vec3f(0.41, 0.24, 0.16), vec3f(2.2)); }
  if (d > 0.11) { return pow(vec3f(0.48, 0.39, 0.27), vec3f(2.2)); }
  return pow(vec3f(0.18, 0.09, 0.07), vec3f(2.2));
}

fn evalHerringboneParquet(p: vec2f) -> SurfaceSample {
  let scale = 3.2;
  let q = p * scale;
  let zig = floor(q.x + q.y);
  let dir = select(vec2f(1.0, -1.0), vec2f(1.0, 1.0), (i32(zig) & 1) == 0);
  let u = dot(q, dir) * 0.35;
  let v = dot(q, vec2f(-dir.y, dir.x)) * 2.1;
  let blockId = vec2f(floor(u), floor(v));
  let fu = fract(u);
  let fv = fract(v);
  let h = hash2(blockId * 1.37 + 0.5) - 0.5;
  let seamMask = smoothstep(0.0, 0.06, min(fu, 1.0 - fu)) * smoothstep(0.0, 0.08, min(fv, 1.0 - fv));
  let grainVal = grain(vec2f(u * 4.0, v * 18.0), 2.5) * 0.16;
  let baseWood = vec3f(0.095, 0.052, 0.028) * (0.92 + h * 0.28 + grainVal);
  let col = mix(baseWood * 0.35, baseWood, seamMask);
  return SurfaceSample(col, vec2f(38.0, 0.18 * seamMask), 0.54, seamMask);
}

@fragment fn fs(o: VOut) -> @location(0) vec4f {
  surfaceFootprint = max(length(dpdx(o.world)), length(dpdy(o.world)));
  var n = normalize(o.normal);
  let V = normalize(F.eye.xyz - o.world);
  let kind = i32(round(o.matLayer.x));
  let layer = clamp(i32(round(o.matLayer.y)), 0, 7);
  let cmp = i32(round(RS.config.x));

  var albedo = vec3f(0.2);
  var gloss = vec2f(0.0);
  var cavity = 1.0;

  if (kind == 0) {
    let uv = clamp(o.uv, vec2f(0.002), vec2f(0.998));
    let useProc = select(
      cmp == 1 || cmp == 4,
      o.world.x >= 0.0,
      cmp == 2 || cmp == 4
    );
    let use256Tex = cmp == 3 || (cmp == 4 && o.world.x < 0.0);

    if (use256Tex) {
      let tex256 = textureSampleLevel(materialTexArray, materialSampler, uv, 13, clamp(materialMipLod(0.35), 0.0, 8.0));
      let edgeBevel = smoothstep(0.0, 0.03, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
      albedo = tex256.rgb * 0.86 * mix(0.6, 1.0, edgeBevel);
      cavity = edgeBevel;
    } else if (!useProc) {
      albedo = evalCrudeConcentricBoxes(uv);
      let stepEdge = min(abs(abs(uv.x - 0.5) * 2.0 - 0.42), abs(abs(uv.y - 0.5) * 2.0 - 0.42));
      cavity = mix(0.65, 1.0, smoothstep(0.0, 0.02, stepEdge));
    } else {
      // Sample high-resolution GPU-baked rug array with anisotropic derivatives + negative mip bias (-0.55)
      let ddx = dpdx(uv) * 0.68;
      let ddy = dpdy(uv) * 0.68;
      let s = textureSampleGrad(rugArray, rugSamp, uv, layer, ddx, ddy);
      let eps = 1.5 / 1024.0;
      let hR = textureSampleLevel(rugArray, rugSamp, clamp(uv + vec2f(eps, 0.0), vec2f(0.002), vec2f(0.998)), layer, 1.0).a;
      let hD = textureSampleLevel(rugArray, rugSamp, clamp(uv + vec2f(0.0, eps), vec2f(0.002), vec2f(0.998)), layer, 1.0).a;
      let pileScale = RS.config.z * (1.0 - smoothstep(0.04, 0.25, surfaceFootprint));
      let nx = (s.a - hR) * 3.2 * pileScale;
      let nz = (s.a - hD) * 3.2 * pileScale;
      n = normalize(n + vec3f(nx, 0.0, nz));
      albedo = s.rgb * (0.72 + 0.34 * s.a);
      cavity = clamp(0.55 + 0.55 * s.a, 0.35, 1.05);
      gloss = vec2f(14.0, 0.04 * s.a);
    }
  } else if (kind == 1) {
    let pq = evalHerringboneParquet(o.world.xz);
    albedo = pq.albedo;
    gloss = pq.gloss;
    cavity = pq.cavity;
  } else if (kind == 2) {
    // RE wainscoted mahogany lower wall + Victorian damask upper wallpaper
    let s = evalPlasterWall(o.world, n, vec3f(0.24, 0.12, 0.09), defaultMaterialRecipe(2));
    albedo = s.albedo;
    if (o.world.y > 0.98) {
      let damUv = vec2f(o.world.x * 3.5, o.world.y * 3.5);
      let dam = evalRugMotif(3, fract(damUv.x) - 0.5, fract(damUv.y) - 0.5, 0.0);
      albedo = mix(vec3f(0.16, 0.065, 0.055), vec3f(0.24, 0.14, 0.08), dam.x * 0.45 + dam.y * 0.35);
    }
    gloss = s.gloss;
    cavity = s.cavity;
  } else {
    albedo = vec3f(0.07, 0.045, 0.03);
    gloss = vec2f(32.0, 0.15);
  }

  var diff = F.ambient.rgb * (0.55 + 0.45 * max(n.y, 0.0)) * cavity;
  let moonDir = normalize(F.moon.xyz);
  diff += vec3f(0.48, 0.61, 0.90) * F.moon.w * max(0.0, dot(n, moonDir)) * cavity;

  var spec = vec3f(0.0);
  let lightCount = min(8, i32(F.options.x));
  for (var i = 0; i < lightCount; i++) {
    let lpos = F.lights[i * 3];
    let lcol = F.lights[i * 3 + 1];
    let delta = lpos.xyz - o.world;
    let dist = length(delta);
    if (dist >= lpos.w || lcol.w <= 0.001) { continue; }
    let ldir = delta / max(dist, 0.001);
    let atten = pow(max(0.0, 1.0 - dist / lpos.w), 1.8) * lcol.w;
    let ndl = max(0.0, (dot(n, ldir) + 0.18) / 1.18);
    diff += lcol.rgb * atten * ndl * mix(0.65, 1.0, cavity);
    if (gloss.x > 0.0 && gloss.y > 0.0) {
      let h = normalize(ldir + V);
      let s = pow(max(0.0, dot(n, h)), gloss.x) * (gloss.x + 2.0) * 0.008;
      spec += lcol.rgb * atten * s * gloss.y;
    }
  }

  var color = albedo * diff * 1.22 + spec;
  if ((cmp == 2 || cmp == 4) && kind == 0) {
    let splitLine = 1.0 - smoothstep(max(surfaceFootprint * 0.75, 0.008), max(surfaceFootprint * 1.8, 0.022), abs(o.world.x));
    color = mix(color, vec3f(0.92, 0.82, 0.55), splitLine * 0.75);
  }
  if (F.options.z == 3.0) {
    color = diff * 1.5 + spec * 2.2;
  } else if (F.options.z == 5.0) {
    color = n * 0.5 + 0.5;
  }
  return vec4f(color, 1.0);
}
`

// Helper to inject `evalRugMotif` into `rugLabShader`
const rugMotifHelperWgsl = /* wgsl */ `
fn evalRugMotif(motifIdx: i32, px: f32, py: f32, seedPhase: f32) -> vec3f {
  let ax = abs(px);
  let ay = abs(py);
  let r = length(vec2f(px, py));
  let ang = atan2(py, px);
  let diamond = abs(ax + ay - 0.36);
  let lattice = 1.0 - smoothstep(0.025, 0.055, diamond);
  let centerRosette = 1.0 - smoothstep(0.11 + 0.025 * cos(ang * 6.0), 0.145 + 0.025 * cos(ang * 6.0), r);
  let leafDist = abs(length(vec2f(ax - 0.22, ay - 0.22)) - 0.14);
  let fishLeaves = (1.0 - smoothstep(0.022, 0.05, leafDist)) * smoothstep(0.16, 0.22, max(ax, ay));
  return vec3f(clamp(lattice + centerRosette + fishLeaves, 0.0, 1.0), clamp(centerRosette + fishLeaves * 0.85, 0.0, 1.0), lattice);
}
`

type VList = number[]

function pushQuadUv(
  out: VList,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  d: readonly [number, number, number],
  n: readonly [number, number, number],
  uvA: readonly [number, number],
  uvB: readonly [number, number],
  uvC: readonly [number, number],
  uvD: readonly [number, number],
  matKind: number,
  layer = 0,
) {
  for (const [p, uv] of [
    [a, uvA],
    [b, uvB],
    [c, uvC],
    [a, uvA],
    [c, uvC],
    [d, uvD],
  ] as const) {
    out.push(p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1], matKind, layer)
  }
}

function buildParlorMesh(aspect: number, galleryMode: boolean): Float32Array {
  const out: number[] = []
  // 1. Herringbone parquet floor
  pushQuadUv(out, [-5.6, 0.0, 3.8], [5.6, 0.0, 3.8], [5.6, 0.0, -3.8], [-5.6, 0.0, -3.8], [0, 1, 0], [0, 1], [1, 1], [1, 0], [0, 0], 1, 0)
  // 2. Back wainscoted + damask wall
  pushQuadUv(out, [-5.6, 0.0, -3.65], [5.6, 0.0, -3.65], [5.6, 2.55, -3.65], [-5.6, 2.55, -3.65], [0, 0, 1], [0, 0], [1, 0], [1, 1], [0, 1], 2, 0)
  // Baseboard & crown rail
  pushQuadUv(out, [-5.6, 0.0, -3.62], [5.6, 0.0, -3.62], [5.6, 0.18, -3.62], [-5.6, 0.18, -3.62], [0, 0, 1], [0, 0], [1, 0], [1, 1], [0, 1], 3, 0)

  if (galleryMode) {
    // 6-tradition gallery: 3x2 grid of rugs on the parlor floor
    for (let i = 0; i < 6; i++) {
      const col = i % 3
      const row = Math.floor(i / 3)
      const cx = (col - 1) * 3.25
      const cz = (row - 0.5) * 2.95 + 0.25
      const hw = 1.32
      const hd = 1.18
      pushQuadUv(
        out,
        [cx - hw, 0.015, cz + hd],
        [cx + hw, 0.015, cz + hd],
        [cx + hw, 0.015, cz - hd],
        [cx - hw, 0.015, cz - hd],
        [0, 1, 0],
        [0, 1],
        [1, 1],
        [1, 0],
        [0, 0],
        0,
        i,
      )
    }
  } else {
    const hw = Math.min(3.8, 1.85 * Math.sqrt(Math.max(0.6, aspect)))
    const hd = Math.min(2.8, 1.85 / Math.sqrt(Math.max(0.6, aspect)))
    pushQuadUv(
      out,
      [-hw, 0.015, hd + 0.2],
      [hw, 0.015, hd + 0.2],
      [hw, 0.015, -hd + 0.2],
      [-hw, 0.015, -hd + 0.2],
      [0, 1, 0],
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
      0,
      0,
    )
  }
  return new Float32Array(out)
}

export function createRugsSection(context: LabContext): LabSection {
  const { device, stage } = context
  const initial = createDefaultRugParams("persian_medallion", 7)

  const settings: LabSettings & RugParams & {
    swatch: "parlor" | "flat" | "gallery"
    compare: 0 | 1 | 2 | 3 | 4
    resolution: 1024 | 2048
  } = {
    swatch: "parlor",
    compare: 1,
    resolution: 1024,
    ...initial,
  }

  let baker1024: RugGpuBaker | null = new RugGpuBaker(device, 1024, 6)
  let baker2048: RugGpuBaker | null = null
  const rugSampler = createRugSampler(device)

  const fallbackMat = createFallbackMaterialTextureArray(device)
  let materialTex = fallbackMat.texture
  let materialTexView = fallbackMat.view
  const materialSampler = createRugSampler(device)

  const frameBuffer = device.createBuffer({
    size: 148 * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const rugStageData = new Float32Array(4)
  const rugStageBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  const bindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 10, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
      { binding: 11, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  })

  const activeBaker = (): RugGpuBaker => {
    if (Number(settings.resolution) === 2048) {
      baker2048 ??= new RugGpuBaker(device, 2048, 6)
      return baker2048
    }
    baker1024 ??= new RugGpuBaker(device, 1024, 6)
    return baker1024
  }

  const makeBindGroup = () =>
    device.createBindGroup({
      layout: bindLayout,
      entries: [
        { binding: 0, resource: { buffer: frameBuffer } },
        { binding: 1, resource: { buffer: rugStageBuffer } },
        { binding: 2, resource: activeBaker().srgbArrayView },
        { binding: 3, resource: rugSampler },
        { binding: 10, resource: materialTexView },
        { binding: 11, resource: materialSampler },
      ],
    })

  let bindGroup = makeBindGroup()

  void loadMaterialTextureArray(device).then((loaded) => {
    if (!loaded) return
    materialTex.destroy()
    materialTex = loaded.texture
    materialTexView = loaded.view
    bindGroup = makeBindGroup()
    context.sync()
  })

  const module = device.createShaderModule({
    code: rugLabShader.replace("struct RugStageUniforms {", rugMotifHelperWgsl + "\nstruct RugStageUniforms {"),
    label: "Lab rugs shader",
  })
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
            { shaderLocation: 2, offset: 24, format: "float32x2" },
            { shaderLocation: 3, offset: 32, format: "float32x2" },
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

  let lastMeshKey = ""
  let meshBuf: GPUBuffer | null = null
  let meshVertCount = 0

  const ensureMesh = () => {
    const gallery = settings.swatch === "gallery"
    const key = `${gallery ? "G" : "S"}:${Number(settings.aspect).toFixed(2)}`
    if (key === lastMeshKey && meshBuf) return
    lastMeshKey = key
    meshBuf?.destroy()
    const verts = buildParlorMesh(Number(settings.aspect) || 1.45, gallery)
    meshBuf = device.createBuffer({
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(meshBuf, 0, verts.buffer, verts.byteOffset, verts.byteLength)
    meshVertCount = verts.length / 10
  }

  const currentRugParams = (): RugParams => ({
    seed: Math.max(1, Math.min(9999, Math.round(Number(settings.seed) || 7))),
    tuningSeed: Math.max(1, Math.min(9999, Math.round(Number(settings.tuningSeed) || 41))),
    style: isRugStyleId(settings.style) ? settings.style : "persian_medallion",
    palette: isRugPaletteId(settings.palette) ? settings.palette : "madder_indigo",
    motif: isRugMotifId(settings.motif) ? settings.motif : "auto",
    symmetry: Number(settings.symmetry) === 2 ? 2 : 4,
    aspect: Number(settings.aspect) || 1.45,
    borderWidth: Number(settings.borderWidth) || 0.24,
    medallionScale: Number(settings.medallionScale) || 0.92,
    motifScale: Number(settings.motifScale) || 1.0,
    knotDensity: Number(settings.knotDensity) || 1.15,
    abrash: Number(settings.abrash) ?? 0.36,
    wear: Number(settings.wear) ?? 0.34,
    fringeLength: Number(settings.fringeLength) ?? 0.04,
    pileHeight: Number(settings.pileHeight) || 0.85,
  })

  const bakeActiveRugs = () => {
    const baker = activeBaker()
    const primary = currentRugParams()
    baker.bakeLayer(0, primary)
    if (settings.swatch === "gallery") {
      for (let i = 0; i < RUG_STYLE_IDS.length; i++) {
        const st = RUG_STYLE_IDS[i]!
        const def = RUG_STYLE_DEFS[st].defaults
        baker.bakeLayer(i, {
          ...def,
          seed: primary.seed + i * 17,
          tuningSeed: primary.tuningSeed,
          wear: primary.wear,
          abrash: primary.abrash,
        })
      }
    }
    bindGroup = makeBindGroup()
  }

  const applyStyleDefaults = (style: RugStyleId) => {
    const def = RUG_STYLE_DEFS[style].defaults
    Object.assign(settings, def, { style })
  }

  const controls: LabControl[] = [
    {
      key: "swatch",
      label: "Stage view",
      group: "View & Comparison",
      type: "select",
      options: [
        { value: "parlor", label: "RE Parlor & Warm Lamp" },
        { value: "flat", label: "Top-down Close Inspection" },
        { value: "gallery", label: "6-Tradition Gallery" },
      ],
      change: () => {
        if (settings.swatch === "flat") {
          stage.frameTarget(0, 0.05, 0.2, 4.8)
        } else if (settings.swatch === "gallery") {
          stage.frameTarget(0, 0.15, 0.2, 9.8)
        } else {
          stage.frameTarget(0, 0.25, 0.2, 6.8)
        }
        context.sync()
      },
    },
    {
      key: "compare",
      label: "Comparison",
      group: "View & Comparison",
      type: "select",
      options: [
        { value: 1, label: "Procedural High-Res (After)" },
        { value: 0, label: "Crude Concentric Boxes (Before)" },
        { value: 2, label: "A/B Split (Crude Boxes | Procedural)" },
        { value: 3, label: "Hand-made 256 px Texture" },
        { value: 4, label: "A/B Split (256 px Tex | Procedural)" },
      ],
      change: () => context.sync(),
    },
    {
      key: "resolution",
      label: "Bake resolution",
      group: "View & Comparison",
      type: "select",
      options: [
        { value: 1024, label: "1024 × 1024 (11 mips)" },
        { value: 2048, label: "2048 × 2048 (12 mips)" },
      ],
      change: () => {
        bakeActiveRugs()
        context.sync()
      },
    },
    ...RUG_CONTROLS.map((c): LabControl => {
      if (c.key === "style") {
        return {
          ...c,
          change: (val) => {
            if (isRugStyleId(val)) applyStyleDefaults(val)
            context.sync()
          },
        }
      }
      return { ...c, change: () => context.sync() }
    }),
    {
      key: "randomizeRug",
      label: "Randomize Rug",
      group: "Pattern & Structure",
      type: "action",
      run: () => {
        context.transact?.("Randomize rug recipe", () => {
          const next = randomizeRugParams(currentRugParams(), Number(settings.tuningSeed) || 41)
          Object.assign(settings, next)
          settings.tuningSeed = ((Number(settings.tuningSeed) || 41) % 9999) + 1
        })
        context.sync()
      },
    },
  ]

  return {
    id: "rugs",
    label: "Rugs",
    settings,
    controls,
    library: {
      category: "materials",
      label: "Procedural Rugs",
      tag: "GPU",
      items: () =>
        RUG_STYLE_IDS.map((id) => ({
          id: `rug:${id}`,
          label: RUG_STYLE_DEFS[id].label,
          tag: "Rug",
          group: "Procedural Rugs",
          active: () => settings.style === id,
          select: () => {
            context.transact?.(`Select rug ${RUG_STYLE_DEFS[id].label}`, () => {
              applyStyleDefaults(id)
            })
            context.sync()
          },
        })),
    },
    enter() {
      stage.sceneMode = 5
      Object.assign(stage.lighting, {
        lamps: true,
        lampPower: 3.4,
        lampRadius: 12,
        lampHeight: 2.5,
        spot: false,
        shadows: true,
        moon: true,
        moonPower: 0.14,
        count: 2,
        exposure: 0.12,
        tone: 1,
        temperature: 0.24,
        saturation: 1.04,
      })
      stage.frameTarget(0, 0.25, 0.2, 6.8)
    },
    retrigger() {
      bakeActiveRugs()
    },
    reroll() {
      settings.seed = ((Number(settings.seed) * 1664525 + 1013904223) >>> 0) % 9999 + 1
      bakeActiveRugs()
      context.sync()
    },
    frameTarget: () => ({ x: 0, y: 0.25, z: 0.2, dist: 6.8 }),
    prepare() {
      stage.sceneMode = 5
      ensureMesh()
      bakeActiveRugs()
      rugStageData[0] = Number(settings.compare) || 0
      rugStageData[1] = settings.swatch === "flat" ? 1 : settings.swatch === "gallery" ? 2 : 0
      rugStageData[2] = Number(settings.pileHeight) || 0.85
      rugStageData[3] = Number(settings.aspect) || 1.45
      device.queue.writeBuffer(rugStageBuffer, 0, rugStageData)
    },
    draw(pass) {
      const frame = (stage as unknown as { frame: Float32Array }).frame
      if (frame) {
        device.queue.writeBuffer(frameBuffer, 0, frame.buffer, frame.byteOffset, frame.byteLength)
      }
      if (!meshBuf) return
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.setVertexBuffer(0, meshBuf)
      pass.draw(meshVertCount)
    },
    telemetry() {
      const st = isRugStyleId(settings.style) ? RUG_STYLE_DEFS[settings.style].label : String(settings.style)
      return `Rugs · ${st} (${settings.resolution}px) {"seed":${settings.seed},"palette":"${settings.palette}","wear":${Number(settings.wear).toFixed(2)}}`
    },
    registerCommands(commands: LabCommandRegistry) {
      commands.registerAll([
        {
          id: "rug.preset",
          label: "Select Procedural Rug Tradition & Palette",
          shortLabel: "Rug Preset",
          category: "Preset",
          undoable: true,
          args: {
            style: { type: "string", required: false, enum: [...RUG_STYLE_IDS] },
            palette: { type: "string", required: false, enum: [...RUG_PALETTE_IDS] },
            motif: { type: "string", required: false, enum: [...RUG_MOTIF_IDS] },
            swatch: { type: "string", required: false, enum: ["parlor", "flat", "gallery"] },
            compare: { type: "number", required: false },
            resolution: { type: "number", required: false },
            seed: { type: "number", required: false },
          },
          enabled: () => true,
          run: (_ctx, args) => {
            if (args?.style && isRugStyleId(args.style)) {
              applyStyleDefaults(args.style)
            }
            if (args?.palette && isRugPaletteId(args.palette)) {
              settings.palette = args.palette
            }
            if (args?.motif && isRugMotifId(args.motif)) {
              settings.motif = args.motif
            }
            if (args?.swatch === "parlor" || args?.swatch === "flat" || args?.swatch === "gallery") {
              settings.swatch = args.swatch
            }
            if (typeof args?.compare === "number") {
              settings.compare = args.compare as 0 | 1 | 2 | 3 | 4
            }
            if (args?.resolution === 1024 || args?.resolution === 2048) {
              settings.resolution = args.resolution
            }
            if (typeof args?.seed === "number" && Number.isFinite(args.seed)) {
              settings.seed = Math.max(1, Math.min(9999, Math.trunc(args.seed)))
            }
            bakeActiveRugs()
            context.sync()
            return { ...currentRugParams(), swatch: settings.swatch, compare: settings.compare, resolution: settings.resolution }
          },
        },
        {
          id: "rug.randomize",
          label: "Randomize Procedural Rug Recipe",
          shortLabel: "Randomize Rug",
          category: "Preset",
          undoable: true,
          args: {
            tuningSeed: { type: "number", required: false },
          },
          enabled: () => true,
          run: (_ctx, args) => {
            const seed = typeof args?.tuningSeed === "number" ? Math.trunc(args.tuningSeed) : Number(settings.tuningSeed) || 41
            const next = randomizeRugParams(currentRugParams(), seed)
            Object.assign(settings, next)
            settings.tuningSeed = (seed % 9999) + 1
            bakeActiveRugs()
            context.sync()
            return next
          },
        },
      ])
    },
  }
}

export { seededRugParamsForSlot, type RugMotifId, type RugPaletteId, type RugParams, type RugStyleId, type RugSymmetryMode }
