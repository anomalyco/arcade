import { buildSurfaceMaterialDeclarationsWgsl, surfaceMaterial } from "@arcade/kit/gpu/surface-materials"
import type { LabControl } from "@arcade/kit/lab-panel"
import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { Rng } from "@arcade/kit/sim/rng"
import { frontageEnd, SIZE, type Town } from "../shared/map"
import { supportHeight } from "../shared/terrain"
import { STREET_LAMP_POSTS } from "./lighting"
import { GROUND_STYLES } from "./look/world"

const rgb = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]

export { GROUND_STYLES }

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

export function packGroundCfgBits(settings: Pick<GroundSettings, "wearAmount" | "curbDirt" | "puddleWetness"> & { groundStyle?: number }): number {
  const w = Math.max(0, Math.min(40, Math.round(settings.wearAmount / 0.05))) & 63
  const d = Math.max(0, Math.min(40, Math.round(settings.curbDirt / 0.05))) & 63
  const p = Math.max(0, Math.min(40, Math.round(settings.puddleWetness / 0.05))) & 63
  const style = Math.max(0, Math.min(3, Math.round(settings.groundStyle ?? 0))) & 3
  return (1 << 18) | (w & 63) | ((d & 63) << 6) | ((p & 63) << 12) | (style << 19)
}

export const outbreakSurfaceMaterialDeclarationsWgsl = buildSurfaceMaterialDeclarationsWgsl({
  asphaltConcrete: /* wgsl */ `fn unpackGroundParams() -> vec3f {
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

fn unpackGroundStyle() -> i32 {
  let raw = u32(max(0.0, F.map.w));
  if ((raw & (1u << 18u)) == 0u) { return 0; }
  return i32((raw >> 19u) & 3u);
}

fn evalAsphaltConcrete(pIn: vec2f, baseTint: vec3f, isConcrete: bool, r: MaterialRecipe) -> SurfaceSample {
  let p = select(pIn, pIn - floor(pIn / 96.0) * 96.0, OL.win.z > 0.5);
  let gParams = unpackGroundParams();
  let gStyle = max(unpackGroundStyle(), i32(round(OL.round.w)));
  let wear = gParams.x;
  let dirtAmt = gParams.y;
  let wetness = gParams.z;
  var col = baseTint;
  var localRough = r.roughness;
  var cavity = 1.0;

  let n1 = surfaceNoise(p * 1.45 + vec2f(2.3, 6.7));
  let n2 = surfaceNoise(p * 0.34 + vec2f(3.7, 8.1));
  let grit = (hash2(floor(p * 11.5)) - 0.5) * (1.0 - smoothstep(0.18, 0.55, surfaceFootprint * 11.5));

  if (isConcrete) {
    let isCurb = (p.y >= 39.74 && p.y <= 40.02) || (p.y >= 47.98 && p.y <= 48.26) || (p.x >= 39.74 && p.x <= 40.02) || (p.x >= 47.98 && p.x <= 48.26);
    let isWalkway = (p.y < 39.82 && p.x > 26.4 && p.x < 29.0) || p.y < 38.02 || p.y > 49.98;
    let isNS = (p.x >= 37.95 && p.x <= 40.05) || (p.x >= 47.95 && p.x <= 50.05);
    // Preserve baseTint while calibrating porch walkway vs street sidewalk reflectance
    let concBase = select(
      select(vec3f(0.58, 0.56, 0.52), vec3f(0.72, 0.66, 0.56), isWalkway),
      select(vec3f(0.48, 0.44, 0.36), vec3f(0.62, 0.55, 0.43), isWalkway),
      gStyle > 0,
    );
    col = baseTint * concBase;
    if (isCurb) { col = baseTint * select(vec3f(0.56, 0.54, 0.50), vec3f(0.42, 0.40, 0.36), gStyle > 0); }

    let along = select(p.x, p.y, isNS || isWalkway);
    let across = select(p.y, p.x, isNS || isWalkway);
    let courseId = floor(across / select(0.94, 0.74, isWalkway));
    let stagger = (hash2(vec2f(courseId, 11.7)) - 0.5) * 0.38;
    let chipJitter = (grit * select(0.024, 0.008, gStyle > 0) + (n1 - 0.5) * 0.028) * wear;
    let slabU = (along + chipJitter) / select(1.48, 1.12, isWalkway) + stagger;
    let slabV = (across + chipJitter * 0.5) / select(0.94, 0.74, isWalkway);
    let cell = vec2f(floor(slabU), floor(slabV));
    let fq = vec2f(fract(slabU), fract(slabV));
    let hSlab = hash2(cell * 1.73 + 0.9) - 0.5;
    let hWarm = fract((hSlab + 0.5) * 11.3) - 0.5;
    let slabVar = select(0.22, 0.30, gStyle > 0);
    col *= (0.92 + hSlab * slabVar * wear) * vec3f(1.0 + hWarm * 0.10, 1.0 + hWarm * 0.02, 1.0 - hWarm * 0.09);

    let jW = (select(0.008, 0.012, gStyle > 0) + 0.006 * n1) * clamp(wear, 0.5, 1.8);
    let joint = seam(slabU, jW, 0.72) * select(seam(slabV, jW * 0.80, 1.04), 1.0, isCurb);
    let edgeDist = min(min(fq.x, 1.0 - fq.x), min(fq.y, 1.0 - fq.y));
    let diag = (fq.x - 0.5) * (0.75 + hWarm * 0.5) + (fq.y - 0.5) * (0.75 - hSlab * 0.5) + grit * select(0.14, 0.04, gStyle > 0) + (n1 - 0.5) * 0.10;
    let edgeCrackMask = 1.0 - smoothstep(0.05, 0.42, edgeDist);
    let crackBoost = select(1.0, 1.45, gStyle == 3);
    let slabCrack = (1.0 - smoothstep(0.002, 0.009 + surfaceFootprint * 0.40, abs(diag))) * step(0.18, hSlab + (wear * crackBoost - 1.0) * 0.20) * edgeCrackMask * wear * crackBoost;
    let edgeDirt = (1.0 - smoothstep(0.0, select(0.15, 0.22, gStyle > 0) * wear, edgeDist)) * (0.5 + 0.5 * n1) * select(0.24, 0.34, gStyle > 0);

    var borderDist = min(abs(p.y - 38.0), abs(p.y - 50.0));
    if (isWalkway) {
      let b = select(vec4f(21.0, 54.0, 36.0, 65.5), vec4f(22.0, 24.0, 37.0, 35.5), p.y < 44.0);
      let inPorch = p.y < b.w + 1.32 && p.y > b.w - 0.1;
      borderDist = max(0.0, select(0.70, 1.25, inPorch) - abs(p.x - select(b.x + 5.70, b.x + 5.75, inPorch)));
    } else if (isNS) {
      borderDist = min(abs(p.x - 38.0), abs(p.x - 50.0));
    }
    let borderSpill = (1.0 - smoothstep(0.0, (0.13 + n1 * 0.22) * dirtAmt, borderDist)) * clamp(dirtAmt, 0.0, 1.5);
    let smoothGrain = (surfaceNoise(p * 4.2 + vec2f(5.1, 1.9)) - 0.5) * 0.14;
    col *= 0.98 + select(grit * 0.30, smoothGrain + grit * 0.06, gStyle > 0) - edgeDirt - n2 * 0.10 * wetness;
    let jointMask = joint * (1.0 - slabCrack * 0.75);
    cavity = mix(select(0.52, 0.36, gStyle > 0), 1.0, joint * (1.0 - slabCrack * 0.55) * (1.0 - borderSpill * 0.45));
    let mossShare = select(0.70, 0.95, gStyle == 3);
    let creviceCol = mix(vec3f(0.036, 0.029, 0.021), select(vec3f(0.042, 0.055, 0.024), vec3f(0.075, 0.135, 0.042), gStyle == 3), smoothstep(0.38, 0.72, n2) * mossShare);
    col = mix(creviceCol, col, jointMask);
    col = mix(col, creviceCol, borderSpill * select(0.68, 0.82, gStyle == 3));
    if (gStyle >= 1) {
      let dampSlab = smoothstep(0.42, 0.68, n2 * 0.7 + (1.0 - edgeDist) * 0.38) * clamp(wetness, 0.35, 1.6);
      let dampScale = select(0.14, 0.24, gStyle == 2);
      col *= 1.0 - dampSlab * dampScale;
      localRough = mix(localRough, select(0.38, 0.26, gStyle == 2), dampSlab * 0.75);
    }

    let sLeafQ = p * 5.6 + vec2f(n1 - 0.5, n2 - 0.5) * 1.3;
    let sLeafH = hash2(floor(sLeafQ) + vec2f(7.3, 2.1));
    let sLeafD = fract(sLeafQ) - 0.5;
    let sLeafMask = step(0.80 - 0.12 * borderSpill, sLeafH) * (1.0 - smoothstep(0.0196, 0.1024, dot(sLeafD, sLeafD))) * (1.0 - smoothstep(0.16, 0.52, surfaceFootprint * 5.6));
    col = mix(col, vec3f(0.18, 0.11, 0.042), sLeafMask * 0.78 * dirtAmt);
  } else {
    let roadU = clamp((p.y - 40.0) * 0.125, 0.0, 1.0);
    let dRut = min(abs(roadU - 0.26), abs(roadU - 0.74));
    let rut = max(0.0, 1.0 - dRut * dRut * select(36.0, 24.0, gStyle > 0));
    let gutterDist = min(abs(p.y - 40.0), abs(p.y - 48.0));
    let gutterWarp = (n1 - 0.5) * 0.55;
    let gutterShade = 1.0 - (1.0 - smoothstep(0.0, select(0.52, 0.72, gStyle > 0) + gutterWarp * 0.35, gutterDist)) * select(0.28, 0.44, gStyle > 0) * dirtAmt;

    if (gStyle == 0) {
      // Today: original hash-cell stipple
      col = baseTint * vec3f(1.12, 1.15, 1.18);
      let aggCell1 = hash2(floor(p * 9.5) + vec2f(1.7, 5.3)) - 0.5;
      let aggCell2 = hash2(floor(p * 19.0) + vec2f(8.1, 2.9)) - 0.5;
      let aggFade = 1.0 - smoothstep(0.20, 0.65, surfaceFootprint * 9.5);
      let aggDetail = (aggCell1 * 0.38 + aggCell2 * 0.32 + grit * 0.52) * aggFade;
      let pebbleGlint = step(0.42, aggCell2) * (0.45 + 0.55 * wetness) * aggFade;
      col *= (1.04 + aggDetail + pebbleGlint * 0.28 + (n2 - 0.5) * 0.26 - rut * 0.07) * gutterShade;
    } else {
      // Candidates 1..3: smooth multi-octave macadam aggregate without 1-px salt-and-pepper static, deep wheel ruts & curb gutter
      col = baseTint * vec3f(0.56, 0.60, 0.68);
      let macadam1 = surfaceNoise(p * 3.1 + vec2f(1.7, 5.3)) - 0.5;
      let macadam2 = surfaceNoise(p * 6.4 + vec2f(8.1, 2.9)) - 0.5;
      let fineFade = 1.0 - smoothstep(0.14, 0.48, surfaceFootprint * 6.4);
      let macadam = macadam1 * 0.18 + macadam2 * 0.11 * fineFade + grit * 0.06 * fineFade;
      let crownLift = 1.0 - abs(roadU * 2.0 - 1.0);
      let gutterDamp = (1.0 - smoothstep(0.0, 1.25, gutterDist)) * (0.55 + 0.45 * n2);
      col *= (0.94 + macadam + (n2 - 0.5) * 0.22 + crownLift * 0.08 - rut * 0.24 - gutterDamp * 0.18) * gutterShade;
      localRough = mix(localRough, 0.48, clamp(rut * 0.65 + gutterDamp * 0.45, 0.0, 0.85));
    }

    let patchMask = smoothstep(0.58 - wear * 0.06, 0.64 - wear * 0.06, n2 * 0.65 + n1 * 0.35) * step(0.14, roadU) * step(roadU, 0.86);
    col = mix(col, col * vec3f(0.76, 0.78, 0.82), patchMask * select(0.42, 0.55, gStyle > 0));

    let jagWarp = vec2f(n1 - 0.5, n2 - 0.5) * 0.68 + vec2f(grit, -grit) * select(0.19, 0.07, gStyle > 0);
    let r1 = abs(fract(p.x * 0.38 + p.y * 0.14 + jagWarp.x) - 0.5);
    let r2 = abs(fract(p.y * 0.44 - p.x * 0.19 + jagWarp.y) - 0.5);
    let ridgeMin = min(r1, r2 + step(0.12, r1) * 0.08);
    let wearMult = select(1.0, 1.45, gStyle == 3);
    let crackGate = smoothstep(0.42, 0.68, n2 + rut * 0.25) * wear * wearMult;
    let aaM = max(surfaceFootprint * 0.35, 0.0025);
    let crack = (1.0 - smoothstep(0.0015, 0.0085 + aaM, ridgeMin)) * crackGate;
    let spallPocket = (1.0 - smoothstep(0.008, 0.028, max(r1, r2))) * crackGate;
    let tarBand = (1.0 - smoothstep(0.004, 0.016 + aaM, r1)) * step(select(0.60, 0.52, gStyle > 0), n2) * clamp(wear * wearMult, 0.0, 1.6);
    col = mix(col, col * vec3f(0.44, 0.46, 0.50), tarBand * select(0.42, 0.62, gStyle > 0));

    let dLane = min(abs(roadU - 0.32), abs(roadU - 0.68));
    let laneCenter = max(0.0, 1.0 - dLane * dLane * 52.0);
    let oilStain = smoothstep(0.38, 0.60, n1 * n2 * (0.65 + 0.60 * laneCenter)) * clamp(wear * 0.85, 0.0, 1.3);
    col = mix(col, col * 0.46, oilStain * select(0.52, 0.65, gStyle > 0));
    col = mix(col, col * 0.16, clamp(crack + spallPocket * 0.85, 0.0, 1.0) * 0.85);
    cavity = (1.0 - crack * 0.46) * gutterShade;

    if (gStyle == 2) {
      // Rain-Slick Nocturne: low-frequency puddles in wheel ruts & curb gutters with physical wet darkening & low roughness
      let gutterPool = 1.0 - smoothstep(0.0, 1.35, gutterDist);
      let puddleField = n2 * 0.65 + n1 * 0.35 + rut * 0.22 + gutterPool * 0.26;
      let puddleMask = smoothstep(0.52, 0.70, puddleField) * clamp(wetness, 0.4, 1.8);
      col *= 1.0 - puddleMask * 0.32;
      localRough = mix(localRough, 0.12, clamp(puddleMask, 0.0, 0.92));
    } else if (gStyle == 3) {
      // Cracked & Overgrown: moss & weed encroachment along gutters and fracture seams
      let gutterMoss = (1.0 - smoothstep(0.0, 1.15 + n1 * 0.5, gutterDist)) * smoothstep(0.36, 0.68, n2);
      let crackMoss = clamp(crack * 0.75 + spallPocket * 0.6, 0.0, 1.0) * smoothstep(0.42, 0.72, n1);
      col = mix(col, vec3f(0.11, 0.17, 0.065), clamp(gutterMoss * 0.75 + crackMoss * 0.55, 0.0, 0.85));
    }

    let qLeaf = p * 5.4 + vec2f(n1 - 0.5, n2 - 0.5) * 1.45;
    let leafH = hash2(floor(qLeaf) + vec2f(4.7, 9.1));
    let leafUv = (fract(qLeaf) - 0.5) * vec2f(1.0, 1.45);
    let gutterLeafBias = 1.0 - smoothstep(0.0, 1.85 + gutterWarp, gutterDist);
    let leafMask = step(0.78 - 0.12 * gutterLeafBias, leafH) * (1.0 - smoothstep(0.0196, 0.1024, dot(leafUv, leafUv))) * (0.28 + 0.72 * gutterLeafBias) * (1.0 - smoothstep(0.16, 0.52, surfaceFootprint * 5.4));
    col = mix(col, vec3f(0.20, 0.12, 0.046), leafMask * 0.86 * dirtAmt);
  }

  return SurfaceSample(col, roughnessToGloss(localRough, select(0.045, 0.065, gStyle == 2)), localRough, cavity);
}`,
})

export const outbreakSurfaceMaterialWgsl = surfaceMaterial

export const groundSurfaceHookWgsl = /* wgsl */ `
    if (mat == 20) {
      let kind = i32(round(o.aux));
      let p = o.world.xz;
      let gStyle = max(unpackGroundStyle(), i32(round(OL.round.w)));
      if (kind == 0) {
        let turfLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
        let oliveOchre = vec3f(turfLum) * mix(vec3f(0.92, 0.96, 1.14), vec3f(1.26, 0.96, 0.58), w);
        if (gStyle == 0 && OL.round.x < 0.5) {
          col = mix(col, oliveOchre, 0.72) * 0.94;
        } else {
          // Preserve rich clumped chlorophyll greens and damp loam variation without any greyscale ochre wash
          let isV5Ground = OL.round.x > 3.5 || OL.round.z > 3.5;
          let lawnMacro = surfaceNoise(p * 0.42 + vec2f(3.1, 7.4));
          let loamPatch = smoothstep(0.54, 0.82, surfaceNoise(p * 0.88 + vec2f(6.2, 1.8)));
          let richTurf = col * mix(
            select(vec3f(0.68, 0.88, 0.52), vec3f(0.64, 0.98, 0.44), isV5Ground),
            select(vec3f(0.86, 1.02, 0.62), vec3f(0.92, 1.16, 0.54), isV5Ground),
            lawnMacro,
          );
          let dampLoam = vec3f(turfLum) * vec3f(0.50, 0.39, 0.25);
          let turfScale = select(0.72, mix(0.76, 1.04, clamp(F.monitorBounds.w, 0.0, 1.0)), isV5Ground);
          col = mix(richTurf, dampLoam, loamPatch * select(0.38, 0.56, gStyle == 3)) * turfScale;
        }
      } else if (kind == 1) {
        let gParams = unpackGroundParams();
        let roadU = clamp((p.y - 40.0) * 0.125, 0.0, 1.0);
        let crown = 1.0 - abs(roadU * 2.0 - 1.0);
        let dxRoad = (p.x - 31.5) * 0.055;
        let centerFocus = max(0.0, 1.0 - dxRoad * dxRoad);
        let rainBoost = select(0.0, 1.35, gStyle == 2);
        let sheen = (0.52 + 0.48 * crown) * (0.54 + 0.46 * centerFocus) * (0.72 + col.g * 3.8) * (gParams.z + (OL.u8.y + rainBoost * 0.45) * 1.45);
        let roadSheenCol = select(mix(vec3f(0.030, 0.038, 0.060), vec3f(0.078, 0.076, 0.072), w), vec3f(0.022, 0.036, 0.068), gStyle > 0);
        col = col * (1.0 - (OL.u8.y + rainBoost * 0.25) * 0.22) + roadSheenCol * max(F.ambient.w, 0.35 * rainBoost) * OL.u2.y * sheen;
      } else if (kind == 2 || kind == 6) {
        let inVerge = (o.world.z > 39.28 && o.world.z < 39.80) || (o.world.z > 48.20 && o.world.z < 48.72);
        if (!inVerge) {
          let isV5Walk = OL.round.x > 3.5 || OL.round.z > 3.5;
          let walkLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
          let warmStone = vec3f(walkLum) * vec3f(1.22, 0.95, 0.56);
          let stoneMix = select(w * 0.65, w * 0.32, gStyle > 0 || OL.round.x > 0.5);
          col = mix(col, warmStone, stoneMix) * select(0.76, select(0.72, mix(0.76, 0.94, clamp(F.monitorBounds.w, 0.0, 1.0)), isV5Walk), gStyle > 0);
          let dxWalk = o.world.x - 27.7;
          if (abs(dxWalk) < 4.5 && o.world.z > 34.8 && o.world.z < 40.4) {
            let dxWalk2 = dxWalk * dxWalk;
            let walkCore = fastExpNeg(dxWalk2 * 0.8) * smoothstep(40.4, 35.0, o.world.z);
            let sideSpread = fastExpNeg(dxWalk2 * 0.133333) * smoothstep(37.4, 38.4, o.world.z) * smoothstep(40.2, 38.8, o.world.z);
            let extScale = select(1.05, 0.68, OL.u5.w > 0.5) * (1.0 + OL.u8.y * 0.85) * select(1.0, select(0.54, 0.96, isV5Walk), gStyle > 0 || OL.round.x > 0.5);
            let walkPool = (walkCore * 0.88 + sideSpread * 0.35) * OL.u2.y * nightLamps * extScale;
            col += col * vec3f(1.26, 0.72, 0.22) * walkPool;
            outbreakPracticalIrr += walkPool * select(0.42, 0.68, isV5Walk);
          }
        }
      }
    }
`

type WearInstance = {
  x: number
  y: number
  z: number
  yaw: number
  r: number
  g: number
  b: number
  scale: number
  pitch: number
  roll: number
  threshold: number
}

/**
 * Instanced 3D ground-wear & street-infrastructure renderer:
 * - Cast-iron circular manhole covers with recessed tar collars & waffle ribs
 * - Storm drain catch-basins with curb hoods & clogged autumn leaf drifts
 * - 3D potholes & spalled asphalt depressions with wet puddle centers & broken asphalt rim chunks
 * - Faded, chipped, tire-worn road paint dashes
 * - Lifted/cracked concrete sidewalk & front-walkway slabs, chipped curb blocks, and weathered verge stones
 * - Creeping soil/moss clods spilling over hard sidewalk, walkway, and driveway boundaries
 *
 * Frustum-culled per frame against `view` and scaled live by `wearAmount` / `curbDirt` without rebuilding `LevelData`.
 */
export class GroundWearRenderer {
  private readonly manholeModel: number
  private readonly drainModel: number
  private readonly potholeModel: number
  private readonly crackedSlabModel: number
  private readonly curbBlockModel: number
  private readonly paintDashModel: number
  private readonly edgeClodModel: number
  private readonly streetLampModel: number

  private cachedKey = ""
  private manholes: WearInstance[] = []
  private drains: WearInstance[] = []
  private potholes: WearInstance[] = []
  private slabs: WearInstance[] = []
  private curbs: WearInstance[] = []
  private paints: WearInstance[] = []
  private clods: WearInstance[] = []
  private streetLamps: WearInstance[] = []

  private readonly manholeData = new Float32Array(16 * INST_FLOATS)
  private readonly drainData = new Float32Array(16 * INST_FLOATS)
  private readonly potholeData = new Float32Array(32 * INST_FLOATS)
  private readonly slabData = new Float32Array(160 * INST_FLOATS)
  private readonly curbData = new Float32Array(192 * INST_FLOATS)
  private readonly paintData = new Float32Array(128 * INST_FLOATS)
  private readonly clodData = new Float32Array(256 * INST_FLOATS)
  private readonly streetLampData = new Float32Array(8 * INST_FLOATS)

  constructor(renderer: Pick<Renderer, "addModel">) {
    // 1. Cast-iron manhole cover + recessed asphalt collar (toned to blend naturally with weathered asphalt)
    const mh = new Mesh()
    mh.prism(0, 0, 0.44, 0.41, 0.0, 0.006, 12, rgb(0x282d35), MAT.lit)
    mh.prism(0, 0, 0.37, 0.35, 0.006, 0.015, 12, rgb(0x3a3f47), MAT.shiny)
    mh.prism(0, 0, 0.32, 0.31, 0.012, 0.020, 12, rgb(0x46423d), MAT.shiny)
    for (const d of [-0.14, 0, 0.14]) {
      mh.box(-0.24, 0.019, d - 0.016, 0.24, 0.024, d + 0.016, rgb(0x524d46), MAT.shiny)
      mh.box(d - 0.016, 0.019, -0.24, d + 0.016, 0.024, 0.24, rgb(0x524d46), MAT.shiny)
    }
    this.manholeModel = renderer.addModel(mh)

    // 2. Storm drain grate + curb inlet hood + clogged leaf drift
    const dr = new Mesh()
    dr.box(-0.44, 0.0, -0.16, 0.44, 0.009, 0.16, rgb(0x16191f), MAT.lit)
    dr.box(-0.48, 0.005, -0.19, 0.48, 0.013, 0.19, rgb(0x323740), MAT.shiny)
    for (let i = -3; i <= 3; i++) {
      const bx = i * 0.115
      dr.box(bx - 0.020, 0.012, -0.14, bx + 0.020, 0.019, 0.14, rgb(0x484d56), MAT.shiny)
    }
    dr.yawBox(-0.32, 0.07, 0.14, 0.09, 0.010, 0.022, 0.4, rgb(0x4e2e14), MAT.lit)
    dr.yawBox(0.30, -0.05, 0.12, 0.08, 0.010, 0.020, -0.5, rgb(0x5c3818), MAT.lit)
    this.drainModel = renderer.addModel(dr)

    // 3. Spalled pothole rim & loose asphalt fragments (irregular cluster of small stones/tar, no big dark octagon)
    const ph = new Mesh()
    ph.yawBox(0, 0, 0.28, 0.19, 0.0, 0.009, 0.3, rgb(0x262b33), MAT.lit)
    ph.yawBox(0.08, 0.04, 0.19, 0.13, 0.004, 0.013, -0.4, rgb(0x303640), MAT.shiny)
    ph.yawBox(-0.18, 0.11, 0.085, 0.065, 0.0, 0.024, 0.6, rgb(0x424752), MAT.lit)
    ph.yawBox(0.21, -0.09, 0.075, 0.055, 0.0, 0.020, -0.7, rgb(0x383d47), MAT.lit)
    ph.yawBox(0.06, -0.16, 0.065, 0.050, 0.0, 0.018, 1.1, rgb(0x4a505c), MAT.lit)
    this.potholeModel = renderer.addModel(ph)

    // 4. Broken concrete corner chunk & spalled slab fragment (compact 3D rubble along slab seams)
    const sl = new Mesh()
    sl.bevelBox(-0.11, 0.0, -0.08, 0.11, 0.028, 0.08, 0.007, rgb(0x4a4e56), rgb(0x5c606a), MAT.lit, MAT.lit)
    sl.yawBox(0.14, 0.06, 0.08, 0.06, 0.0, 0.020, 0.5, rgb(0x42464e), MAT.lit)
    sl.yawBox(-0.12, -0.07, 0.06, 0.05, 0.0, 0.016, -0.4, rgb(0x525660), MAT.lit)
    this.crackedSlabModel = renderer.addModel(sl)

    // 5. Weathered stone verge border block / chipped curb segment
    const cb = new Mesh()
    cb.bevelBox(-0.24, 0.0, -0.055, 0.24, 0.032, 0.055, 0.007, rgb(0x3e424a), rgb(0x4e525b), MAT.lit, MAT.lit)
    cb.box(-0.27, 0.0, -0.06, -0.23, 0.022, 0.06, rgb(0x1c1f24), MAT.lit)
    this.curbBlockModel = renderer.addModel(cb)

    // 6. Chipped, eroded road paint dash (3 broken paint flakes per dash)
    const pd = new Mesh()
    pd.box(-0.82, 0.0, -0.048, -0.28, 0.004, 0.048, rgb(0x564f3a), MAT.lit)
    pd.box(-0.12, 0.0, -0.045, 0.30, 0.004, 0.046, rgb(0x4c4533), MAT.lit)
    pd.box(0.44, 0.0, -0.046, 0.78, 0.004, 0.044, rgb(0x5c543e), MAT.lit)
    this.paintDashModel = renderer.addModel(pd)

    // 7. Small irregular gravel/twig/leaf litter cluster along sidewalk & curb edges
    const ec = new Mesh()
    ec.yawBox(0, 0, 0.09, 0.06, 0.0, 0.015, 0.3, rgb(0x483018), MAT.lit)
    ec.yawBox(0.08, 0.04, 0.07, 0.05, 0.0, 0.014, 1.2, rgb(0x583a1c), MAT.lit)
    ec.yawBox(-0.07, 0.05, 0.05, 0.04, 0.0, 0.018, -0.6, rgb(0x4a4d52), MAT.lit)
    ec.yawBox(0.03, -0.06, 0.14, 0.018, 0.0, 0.012, 0.8, rgb(0x3a2c1e), MAT.timber)
    this.edgeClodModel = renderer.addModel(ec)

    // 8. 1970s suburban cobra-head sodium streetlamp pole + curved mast arm + glowing 2100K bulb (MAT.lamp uses lampPower[0])
    const slp = new Mesh()
    slp.prism(0, 0, 0.11, 0.08, 0.0, 0.35, 8, rgb(0x2d3236), MAT.lit)
    // Tall slender steel shaft (6.2m so perspective projection reaches the north-east curb line in street.png)
    slp.prism(0, 0, 0.062, 0.044, 0.32, 6.20, 8, rgb(0x363b40), MAT.shiny)
    // Curved mast arm reaching +X (1.45m overhang at 6.30m height)
    slp.quadAuto([0.0, 6.05, -0.032], [0.75, 6.28, -0.028], [0.75, 6.34, 0.028], [0.0, 6.11, 0.032], rgb(0x3a4046), MAT.shiny)
    slp.quadAuto([0.75, 6.28, -0.028], [1.48, 6.24, -0.024], [1.48, 6.30, 0.024], [0.75, 6.34, 0.028], rgb(0x3a4046), MAT.shiny)
    // Cobra-head housing & warm 2100K sodium diffuser lens (MAT.lamp, aux=0 so shadeScene makes it emissive!)
    slp.bevelBox(1.22, 6.20, -0.14, 1.66, 6.32, 0.14, 0.025, rgb(0x2a2f34), rgb(0x3c4248), MAT.lit, MAT.lit)
    slp.box(1.24, 6.10, -0.13, 1.64, 6.21, 0.13, rgb(0xffa838), MAT.lamp, 0)
    this.streetLampModel = renderer.addModel(slp)
  }

  private ensureBuilt(town: Town, seedOverride: number): void {
    const ox = Math.floor((town.windowOrigin?.[0] ?? 0) / SIZE) * SIZE
    const oz = Math.floor((town.windowOrigin?.[1] ?? 0) / SIZE) * SIZE
    const key = `${town.seed}:${town.terrain}:${seedOverride}:${ox}:${oz}`
    if (this.cachedKey === key) return
    this.cachedKey = key
    const rng = new Rng((town.seed ^ (seedOverride * 0x45d9f3b) ^ 0x4f91c27b) >>> 0)

    this.streetLamps = STREET_LAMP_POSTS.map((post) => ({
      x: ox + post.x,
      y: 0.08,
      z: oz + post.z,
      yaw: post.yaw,
      r: 1,
      g: 1,
      b: 1,
      scale: 1,
      pitch: 0,
      roll: 0,
      threshold: 0.05,
    }))

    this.manholes = [
      [33.45, 43.85],
      [43.85, 43.95],
      [44.20, 29.60],
      [56.80, 43.75],
    ].map(([x, z], i) => ({
      x: ox + x!,
      y: 0.014,
      z: oz + z!,
      yaw: i * 0.62,
      r: 1,
      g: 1,
      b: 1,
      scale: 1,
      pitch: 0,
      roll: 0,
      threshold: 0.15,
    }))

    this.drains = [
      [24.65, 40.12, 0],
      [33.80, 40.12, 0],
      [31.35, 47.88, Math.PI],
      [59.00, 47.88, Math.PI],
      [48.10, 31.00, Math.PI / 2],
      [39.88, 63.00, -Math.PI / 2],
    ].map(([x, z, yaw]) => ({
      x: ox + x!,
      y: 0.014,
      z: oz + z!,
      yaw: yaw!,
      r: 1,
      g: 1,
      b: 1,
      scale: 1,
      pitch: 0,
      roll: 0,
      threshold: 0.1,
    }))

    this.potholes = [
      [25.60, 42.15, 0.95],
      [32.45, 45.20, 1.05],
      [27.40, 46.45, 0.88],
      [36.10, 41.65, 0.85],
      [21.40, 45.30, 1.00],
      [43.40, 36.20, 0.95],
      [52.60, 44.60, 1.05],
      [16.20, 42.90, 0.96],
      [64.50, 45.10, 1.02],
    ].map(([x, z, sc], i) => ({
      x: ox + x!,
      y: 0.014,
      z: oz + z!,
      yaw: i * 1.17 + rng.next() * 0.5,
      r: 1,
      g: 1,
      b: 1,
      scale: sc!,
      pitch: 0,
      roll: 0,
      threshold: 0.25 + (i % 4) * 0.35,
    }))

    this.paints = []
    for (let v = 6; v < SIZE - 6; v += 5.0) {
      if (v > 36.0 && v < 51.0) continue
      if (v < 38.0 || ox !== 0 || oz !== 0) {
        this.paints.push({
          x: ox + v + 1.1,
          y: 0.015,
          z: oz + 43.96,
          yaw: (rng.next() - 0.5) * 0.02,
          r: 1,
          g: 1,
          b: 1,
          scale: 0.92 + rng.next() * 0.18,
          pitch: 0,
          roll: 0,
          threshold: 0.2,
        })
      }
      this.paints.push({
        x: ox + 43.96,
        y: 0.015,
        z: oz + v + 1.1,
        yaw: Math.PI / 2 + (rng.next() - 0.5) * 0.02,
        r: 1,
        g: 1,
        b: 1,
        scale: 0.92 + rng.next() * 0.18,
        pitch: 0,
        roll: 0,
        threshold: 0.2,
      })
    }

    this.slabs = []
    this.curbs = []
    this.clods = []

    for (let x = 6; x < SIZE - 6; x += 1.35 + rng.next() * 0.65) {
      if (x > 37.4 && x < 50.6) continue
      const inDriveway = (x > 18.6 && x < 22.0) || (x > 49.6 && x < 53.0)
      const inWalkway = (x > 26.7 && x < 28.7) || (x > 57.7 && x < 59.7)
      if (inDriveway) continue

      for (const isNorth of [true, false]) {
        const zSidewalk = isNorth ? 38.64 : 49.36
        const zVergeInner = isNorth ? 39.30 : 48.70
        const zCurb = isNorth ? 39.88 : 48.12
        const zLawnEdge = isNorth ? 38.06 : 49.94

        if (!inWalkway && rng.next() < 0.72) {
          this.curbs.push({
            x: x + (rng.next() - 0.5) * 0.18,
            y: 0.094,
            z: zVergeInner,
            yaw: (rng.next() - 0.5) * 0.08,
            r: 1,
            g: 1,
            b: 1,
            scale: 0.85 + rng.next() * 0.30,
            pitch: (rng.next() - 0.5) * 0.04,
            roll: 0,
            threshold: rng.next() * 1.4,
          })
        }

        if (rng.next() < 0.55) {
          this.curbs.push({
            x: x + (rng.next() - 0.5) * 0.22,
            y: 0.062,
            z: zCurb,
            yaw: (rng.next() - 0.5) * 0.10,
            r: 1,
            g: 1,
            b: 1,
            scale: 0.78 + rng.next() * 0.28,
            pitch: (rng.next() - 0.5) * 0.05,
            roll: 0,
            threshold: rng.next() * 1.5,
          })
        }

        if (rng.next() < 0.45) {
          this.slabs.push({
            x: x + (rng.next() - 0.5) * 0.35,
            y: 0.100,
            z: zSidewalk + (rng.next() - 0.5) * 0.38,
            yaw: rng.next() * Math.PI * 2,
            r: 1,
            g: 1,
            b: 1,
            scale: 0.65 + rng.next() * 0.55,
            pitch: (rng.next() - 0.5) * 0.08,
            roll: (rng.next() - 0.5) * 0.08,
            threshold: rng.next() * 1.6,
          })
        }

        if (!inWalkway && rng.next() < 0.75) {
          this.clods.push({
            x: x + (rng.next() - 0.5) * 0.42,
            y: 0.100,
            z: zLawnEdge + (isNorth ? 0.06 + rng.next() * 0.22 : -0.06 - rng.next() * 0.22),
            yaw: rng.next() * Math.PI * 2,
            r: 1,
            g: 1,
            b: 1,
            scale: 0.75 + rng.next() * 0.65,
            pitch: 0,
            roll: 0,
            threshold: rng.next() * 1.6,
          })
        }
      }
    }

    // Subtle twig/leaf/stone litter along walkway & driveway borders
    for (const b of town.buildings) {
      if (b.kind !== "house") continue
      const [bx0, bz0, , bz1] = b.rect
      const walkEnd = frontageEnd(b) + 1.9
      for (let wz = bz1 + 0.55; wz < walkEnd; wz += 0.85 + rng.next() * 0.55) {
        for (const side of [-1, 1] as const) {
          if (rng.next() < 0.35) continue
          this.clods.push({
            x: bx0 + 5.7 + side * (0.64 + (rng.next() - 0.5) * 0.12),
            y: 0.130,
            z: wz + (rng.next() - 0.5) * 0.20,
            yaw: rng.next() * Math.PI * 2,
            r: 1,
            g: 1,
            b: 1,
            scale: 0.70 + rng.next() * 0.50,
            pitch: 0,
            roll: 0,
            threshold: rng.next() * 1.6,
          })
        }
      }
      for (let dz = bz0 + 0.9; dz < walkEnd; dz += 0.85 + rng.next() * 0.55) {
        for (const edgeX of [bx0 - 2.96, bx0 - 0.40]) {
          const gx = edgeX + (rng.next() - 0.5) * 0.22
          const gz = dz + (rng.next() - 0.5) * 0.22
          this.clods.push({
            x: gx,
            y: supportHeight(town, gx, gz),
            z: gz,
            yaw: rng.next() * Math.PI * 2,
            r: 1,
            g: 1,
            b: 1,
            scale: 0.75 + rng.next() * 0.55,
            pitch: 0,
            roll: 0,
            threshold: rng.next() * 1.6,
          })
        }
      }
    }
  }

  collectBatches(
    town: Town,
    view: readonly [number, number, number, number],
    settings: Pick<GroundSettings, "wearAmount" | "curbDirt" | "clutterSeed">,
  ): Batch[] {
    this.ensureBuilt(town, settings.clutterSeed)
    const [vx0, vy0, vx1, vy1] = view
    const wear = Math.max(0, settings.wearAmount)
    const dirt = Math.max(0, settings.curbDirt)
    const batches: Batch[] = []

    const packVisible = (list: WearInstance[], buf: Float32Array<ArrayBuffer>, model: number, gate: number) => {
      if (gate <= 0.01) return
      const cap = Math.floor(buf.length / INST_FLOATS)
      let count = 0
      for (let i = 0; i < list.length && count < cap; i++) {
        const it = list[i]!
        if (it.threshold > gate) continue
        if (it.x < vx0 - 1.2 || it.x > vx1 + 1.2 || it.z < vy0 - 1.2 || it.z > vy1 + 1.2) continue
        const o = count++ * INST_FLOATS
        buf[o] = it.x
        buf[o + 1] = it.y
        buf[o + 2] = it.z
        buf[o + 3] = it.yaw
        buf[o + 4] = it.r
        buf[o + 5] = it.g
        buf[o + 6] = it.b
        buf[o + 7] = it.scale
        buf[o + 8] = it.pitch
        buf[o + 9] = it.roll
        buf[o + 10] = 1
        buf[o + 11] = 0
      }
      if (count > 0) batches.push({ model, data: buf, count })
    }

    packVisible(this.streetLamps, this.streetLampData, this.streetLampModel, wear)
    packVisible(this.manholes, this.manholeData, this.manholeModel, wear)
    packVisible(this.drains, this.drainData, this.drainModel, wear)
    packVisible(this.potholes, this.potholeData, this.potholeModel, wear)
    packVisible(this.slabs, this.slabData, this.crackedSlabModel, wear)
    packVisible(this.curbs, this.curbData, this.curbBlockModel, wear)
    packVisible(this.paints, this.paintData, this.paintDashModel, wear)
    packVisible(this.clods, this.clodData, this.edgeClodModel, dirt)

    return batches
  }
}

