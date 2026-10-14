import { surfaceMaterial, surfaceMaterialDeclarations } from "@arcade/kit/gpu/surface-materials"
import type { LabControl } from "@arcade/kit/lab-panel"
import { MAT, type Mesh } from "@arcade/kit/gpu/mesh"
import { Rng } from "@arcade/kit/sim/rng"
import type { Town } from "../shared/map"

export type GroundSettings = {
  wearAmount: number
  curbDirt: number
  puddleWetness: number
  clutterDensity: number
  rubbleAmount: number
  motionStrength: number
  windGustiness: number
  clutterSeed: number
  groundTuningSeed: number
}

export const DEFAULT_GROUND_SETTINGS: GroundSettings = {
  wearAmount: 1.0,
  curbDirt: 1.0,
  puddleWetness: 1.0,
  clutterDensity: 1.0,
  rubbleAmount: 1.0,
  motionStrength: 1.0,
  windGustiness: 1.0,
  clutterSeed: 7,
  groundTuningSeed: 41,
}

/**
 * Deterministic parameter randomization using an isolated `groundTuningSeed`.
 * Leaves structural seeds (`seed`, `houseSeed`, `clutterSeed`) unchanged per docs/lab.md.
 */
export function randomizeGroundSettings(
  current: GroundSettings,
  tuningSeed: number,
): Partial<GroundSettings> {
  const rng = new Rng((Math.trunc(tuningSeed) || 1) ^ 0x5f3759df)
  const snap = (v: number, min: number, max: number, step: number) => {
    const clamped = Math.max(min, Math.min(max, v))
    return Number((min + Math.round((clamped - min) / step) * step).toFixed(4))
  }
  return {
    wearAmount: snap(0.65 + rng.next() * 0.95, 0, 2, 0.05),
    curbDirt: snap(0.65 + rng.next() * 0.95, 0, 2, 0.05),
    puddleWetness: snap(0.55 + rng.next() * 1.05, 0, 2, 0.05),
    clutterDensity: snap(0.65 + rng.next() * 1.05, 0, 2.5, 0.05),
    rubbleAmount: snap(0.65 + rng.next() * 1.05, 0, 2.5, 0.05),
    motionStrength: snap(0.60 + rng.next() * 1.10, 0, 2.5, 0.05),
    windGustiness: snap(0.60 + rng.next() * 1.10, 0, 2.5, 0.05),
  }
}

export const groundControls: LabControl[] = [
  // Live uniform controls (update shader/motion immediately without rebuilding level)
  { key: "wearAmount", label: "Wear & cracks", group: "Ground & Clutter", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "curbDirt", label: "Edge dirt & moss", group: "Ground & Clutter", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "puddleWetness", label: "Road dampness", group: "Ground & Clutter", min: 0, max: 2, step: 0.05, unit: "×" },
  // Structural / instance controls
  { key: "clutterDensity", label: "Clutter density", group: "Ground & Clutter", min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "rubbleAmount", label: "Rubble amount", group: "Ground & Clutter", min: 0, max: 2.5, step: 0.05, unit: "×" },
  // Client-local ambient motion controls
  { key: "motionStrength", label: "Ambient motion", group: "Ground & Clutter", min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "windGustiness", label: "Wind gustiness", group: "Ground & Clutter", min: 0, max: 2.5, step: 0.05, unit: "×" },
  // Structural seed vs isolated tuning seed
  { key: "clutterSeed", label: "Clutter seed", group: "Ground & Clutter", min: 1, max: 999, step: 1, unit: "" },
  { key: "groundTuningSeed", label: "Ground tuning seed", group: "Ground & Clutter", min: 1, max: 9999, step: 1, unit: "" },
]

export function packGroundCfgBits(settings: Pick<GroundSettings, "wearAmount" | "curbDirt" | "puddleWetness">): number {
  const w = Math.max(0, Math.min(40, Math.round(settings.wearAmount / 0.05))) & 63
  const d = Math.max(0, Math.min(40, Math.round(settings.curbDirt / 0.05))) & 63
  const p = Math.max(0, Math.min(40, Math.round(settings.puddleWetness / 0.05))) & 63
  return (1 << 18) | (w & 63) | ((d & 63) << 6) | ((p & 63) << 12)
}

export const outbreakSurfaceMaterialDeclarationsWgsl = surfaceMaterialDeclarations.replace(
  /fn evalAsphaltConcrete\([\s\S]*?return SurfaceSample\(col, roughnessToGloss\(localRough, 0\.045\), localRough, cavity\);\n\}/,
  /* wgsl */ `fn unpackGroundParams() -> vec3f {
  let raw = u32(max(0.0, F.map.w));
  if ((raw & (1u << 18u)) == 0u) {
    return vec3f(1.0, 1.0, 1.0);
  }
  return vec3f(
    f32(raw & 63u) * 0.05,
    f32((raw >> 6u) & 63u) * 0.05,
    f32((raw >> 12u) & 63u) * 0.05
  );
}

fn evalAsphaltConcrete(p: vec2f, baseTint: vec3f, isConcrete: bool, r: MaterialRecipe) -> SurfaceSample {
  let gParams = unpackGroundParams();
  let wear = gParams.x;
  let dirtAmt = gParams.y;
  let wetness = gParams.z;
  var col = baseTint;
  var localRough = r.u0.w;
  var cavity = 1.0;

  let n1 = surfaceNoise(p * 1.45 + vec2f(2.3, 6.7));
  let n2 = surfaceNoise(p * 0.34 + vec2f(3.7, 8.1));
  let grit = grain(p, 11.5);

  if (isConcrete) {
    let isCurb = (p.y >= 39.74 && p.y <= 40.02) || (p.y >= 47.98 && p.y <= 48.26) || (p.x >= 39.74 && p.x <= 40.02) || (p.x >= 47.98 && p.x <= 48.26);
    let isWalkway = p.y < 38.02 || p.y > 49.98;
    let isNS = (p.x >= 37.95 && p.x <= 40.05) || (p.x >= 47.95 && p.x <= 50.05);
    col = select(vec3f(0.118, 0.124, 0.134), vec3f(0.052, 0.048, 0.042), isWalkway);
    if (isCurb) { col = vec3f(0.088, 0.092, 0.100); }

    let along = select(p.x, p.y, isNS || isWalkway);
    let across = select(p.y, p.x, isNS || isWalkway);
    let courseId = floor(across / select(0.92, 0.72, isWalkway));
    let stagger = (hash2(vec2f(courseId, 11.7)) - 0.5) * 0.45;
    let slabU = (along + (n1 - 0.5) * 0.58 * wear) / select(1.42, 1.08, isWalkway) + stagger;
    let slabV = (across + (n2 - 0.5) * 0.09 * wear) / select(0.92, 0.72, isWalkway);
    let cell = vec2f(floor(slabU), floor(slabV));
    let fq = vec2f(fract(slabU), fract(slabV));
    let hSlab = hash2(cell * 1.73 + 0.9) - 0.5;
    let hWarm = fract((hSlab + 0.5) * 11.3) - 0.5;
    col *= (0.88 + hSlab * 0.28 * wear) * vec3f(1.0 + hWarm * 0.08, 1.0 + hWarm * 0.02, 1.0 - hWarm * 0.08);

    let jW = (0.013 + 0.011 * n1) * clamp(wear, 0.5, 1.8);
    let joint = seam(slabU, jW, 0.75) * select(seam(slabV, jW * 0.85, 1.05), 1.0, isCurb);
    let diag = (fq.x - 0.5) * (0.75 + hWarm * 0.5) + (fq.y - 0.5) * (0.75 - hSlab * 0.5) + (n1 - 0.5) * 0.25;
    let slabCrack = (1.0 - smoothstep(0.005, 0.022 + surfaceFootprint * 0.8, abs(diag))) * step(0.02, hSlab + (wear - 1.0) * 0.25) * wear;
    let edgeDist = min(min(fq.x, 1.0 - fq.x), min(fq.y, 1.0 - fq.y));
    let edgeDirt = (1.0 - smoothstep(0.0, 0.13 * wear, edgeDist)) * (0.5 + 0.5 * n1) * 0.24;

    var borderDist = min(abs(p.y - 38.0), abs(p.y - 50.0));
    if (isWalkway) {
      let b = select(vec4f(21.0, 54.0, 36.0, 65.5), vec4f(22.0, 24.0, 37.0, 35.5), p.y < 44.0);
      let inPorch = p.y < b.w + 1.32 && p.y > b.w - 0.1;
      borderDist = max(0.0, select(0.70, 1.25, inPorch) - abs(p.x - select(b.x + 5.70, b.x + 5.75, inPorch)));
    } else if (isNS) {
      borderDist = min(abs(p.x - 38.0), abs(p.x - 50.0));
    }
    let borderSpill = (1.0 - smoothstep(0.0, (0.14 + n1 * 0.26) * dirtAmt, borderDist)) * clamp(dirtAmt, 0.0, 1.5);
    let creviceCol = mix(vec3f(0.024, 0.021, 0.017), vec3f(0.032, 0.052, 0.020), smoothstep(0.42, 0.74, n2) * 0.75);

    col *= 0.94 + grit * 0.22 - edgeDirt - n2 * 0.12 * wetness;
    col = mix(creviceCol, col, joint * (1.0 - slabCrack * 0.80));
    col = mix(col, creviceCol, borderSpill * 0.76);
    cavity = mix(0.42, 1.0, joint * (1.0 - slabCrack * 0.65) * (1.0 - borderSpill * 0.55));
  } else {
    col = vec3f(0.066, 0.074, 0.088);
    let roadU = clamp((p.y - 40.0) * 0.125, 0.0, 1.0);
    let dRut = min(abs(roadU - 0.26), abs(roadU - 0.74));
    let rut = max(0.0, 1.0 - dRut * dRut * 36.0);
    let dLane = min(abs(roadU - 0.32), abs(roadU - 0.68));
    let laneCenter = max(0.0, 1.0 - dLane * dLane * 52.0);

    let patchMask = smoothstep(0.58 - wear * 0.06, 0.64 - wear * 0.06, n2 * 0.65 + n1 * 0.35) * step(0.14, roadU) * step(roadU, 0.86);
    let r1 = abs(surfaceNoise(p * vec2f(0.42, 0.58) + vec2f(n1 - 0.5, n2 - 0.5) * 0.85) - 0.5);
    let ridgeMin = min(r1, abs(n1 - 0.5) * 0.85 + 0.02);
    let crackGate = smoothstep(0.40, 0.68, n2 + rut * 0.25);
    let aaM = max(surfaceFootprint * 0.48, 0.004);
    let crack = (1.0 - smoothstep(0.004, 0.016 + aaM, ridgeMin)) * crackGate * wear;
    let tarBand = (1.0 - smoothstep(0.010, 0.042 + aaM, r1)) * step(0.56, n2) * clamp(wear, 0.0, 1.4);
    let oilStain = smoothstep(0.36, 0.58, n1 * n2 * (0.65 + 0.60 * laneCenter)) * clamp(wear * 0.85, 0.0, 1.3);

    let gutterDist = min(abs(p.y - 40.0), abs(p.y - 48.0));
    let gutterWarp = (n1 - 0.5) * 0.50;
    let gutterShade = 1.0 - (1.0 - smoothstep(0.0, 0.52 + gutterWarp * 0.35, gutterDist)) * 0.44 * dirtAmt;
    let qLeaf = p * 5.2 + vec2f(n1 - 0.5, n2 - 0.5) * 1.4;
    let leafH = hash2(floor(qLeaf) + vec2f(4.7, 9.1));
    let leafUv = fract(qLeaf) - 0.5;
    let leafMask = step(0.76, leafH) * (1.0 - smoothstep(0.14, 0.32, length(leafUv * vec2f(1.0, 1.45)))) * (1.0 - smoothstep(0.0, 1.35 + gutterWarp, gutterDist)) * (1.0 - smoothstep(0.16, 0.52, surfaceFootprint * 5.2));

    col *= (0.94 + grit * 0.48 + (n2 - 0.5) * 0.28 - rut * 0.09) * gutterShade;
    col = mix(col, col * vec3f(0.72, 0.75, 0.80), patchMask * 0.50);
    col = mix(col, col * vec3f(0.48, 0.50, 0.54), tarBand * 0.52);
    col = mix(col, col * 0.38, oilStain * 0.65);
    col = mix(col, col * 0.24, crack * 0.82);
    col = mix(col, vec3f(0.13, 0.075, 0.028), leafMask * 0.82 * dirtAmt);
    cavity = (1.0 - crack * 0.45) * gutterShade;
  }

  return SurfaceSample(col, roughnessToGloss(localRough, 0.045), localRough, cavity);
}`,
)

export const outbreakSurfaceMaterialWgsl = surfaceMaterial
  .replace(
    "let inNorthVerge = kind == 2 && p.y > 39.32 && p.y < 39.78 && (p.x < 37.8 || p.x > 50.2);",
    "let vWarp = sin(p.x * 1.7 + sin(p.x * 0.63) * 1.2) * 0.055;\n      let inNorthVerge = kind == 2 && (p.y + vWarp) > 39.28 && (p.y + vWarp) < 39.78 && (p.x < 37.8 || p.x > 50.2);",
  )
  .replace(
    "let inSouthVerge = kind == 2 && p.y > 48.22 && p.y < 48.68 && (p.x < 37.8 || p.x > 50.2);",
    "let inSouthVerge = kind == 2 && (p.y - vWarp) > 48.22 && (p.y - vWarp) < 48.72 && (p.x < 37.8 || p.x > 50.2);",
  )
  .replace(
    "grassTint = vec3f(0.022, 0.038, 0.012) * (0.42 + 0.58 * vEdge);",
    "grassTint = vec3f(0.036, 0.054, 0.020) * (0.55 + 0.45 * vEdge);",
  )

export const groundSurfaceHookWgsl = /* wgsl */ `
    if (mat == 20) {
      let kind = i32(round(o.aux));
      if (kind == 0) {
        let turfPatch = surfaceNoise(o.world.xz * 0.46 + vec2f(1.9, 4.7));
        col *= mix(0.44, 1.04, smoothstep(0.26, 0.76, turfPatch));
      } else if (kind == 1) {
        let p = o.world.xz;
        let gParams = unpackGroundParams();
        let roadU = clamp((p.y - 40.0) * 0.125, 0.0, 1.0);
        let crown = 1.0 - abs(roadU * 2.0 - 1.0);
        let dxRoad = (p.x - 28.8) * 0.08;
        let centerFocus = max(0.0, 1.0 - dxRoad * dxRoad);
        let roadMacro = surfaceNoise(p * 0.32 + vec2f(3.7, 8.1));
        let sheen = crown * (0.42 + 0.58 * centerFocus) * (0.60 + 0.70 * roadMacro) * gParams.z;
        col += vec3f(0.011, 0.017, 0.032) * F.ambient.w * sheen;
      }
    }
    if (!inRoom && o.world.y < 0.35) {
      let dp = o.world.xz - lights[0].pos.xz;
      let d2 = dot(dp, dp);
      if (d2 < 12.0) {
        let aura = max(0.0, 1.0 - d2 / 12.0);
        let auraScale = select(0.32, 0.16, mat == 20 && i32(round(o.aux)) == 2);
        col += o.color * vec3f(0.48, 0.28, 0.10) * aura * aura * nightLamps * auraScale;
      }
    }
`
