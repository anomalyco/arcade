import type { StylePresentationModule } from "./types"

export const oneBitStyle: StylePresentationModule = {
  id: "one-bit",
  index: 1,
  name: "Game Boy 1-Bit",
  shortName: "1-Bit / GB",
  tagline: "DMG-01 4-shade olive & 1-bit Obra Dinn ordered Bayer dithering at 112p",
  defaultPeople: "blocky",
  defaults: {
    pixelSize: 112,
    palette: 0,
    outlineWidth: 1.2,
    dither: 0.95,
    halftoneSize: 4.0,
    rampSteps: 4,
    fxPunch: 1.25,
    pixelSnap: true,
  },
  palettes: ["DMG-01 Olive (4-shade)", "Obra Dinn Bone (1-Bit)", "Pocket Silver (4-shade)", "Virtual Red (1-Bit)"],
  scaling: {
    verdict: "partial",
    summary: "Works well in focused rooms; across a 96m town, dense foliage and subtle loot items merge into dither noise.",
    whatItTakes:
      "Material-ID dither pattern separation (distinct hatch/dither matrices per surface class) and dedicated 1-bit icon callouts for interactive loot.",
  },
  wgsl: /* wgsl */ `
fn evalOneBitPalette(level: f32, pal: i32) -> vec3f {
  let q = clamp(i32(round(level * 3.0)), 0, 3);
  if (pal == 1) {
    // Pure 1-bit Obra Dinn Macintosh Bone & Ink
    return select(vec3f(0.08, 0.07, 0.09), vec3f(0.91, 0.85, 0.73), level >= 0.5);
  }
  if (pal == 3) {
    // Pure 1-bit Virtual Boy Crimson & Black
    return select(vec3f(0.05, 0.01, 0.02), vec3f(0.96, 0.14, 0.18), level >= 0.48);
  }
  if (pal == 2) {
    // Game Boy Pocket B&W 4-shade
    let p = array<vec3f, 4>(
      vec3f(0.09, 0.10, 0.10),
      vec3f(0.33, 0.35, 0.34),
      vec3f(0.64, 0.67, 0.64),
      vec3f(0.88, 0.90, 0.86)
    );
    return p[q];
  }
  // Classic DMG-01 Olive Green 4-shade (#0f380f, #306230, #8bac0f, #9bbc0f)
  let dmg = array<vec3f, 4>(
    vec3f(0.059, 0.220, 0.059),
    vec3f(0.188, 0.384, 0.188),
    vec3f(0.545, 0.675, 0.059),
    vec3f(0.608, 0.737, 0.059)
  );
  return dmg[q];
}

fn evalStyle_1(uv: vec2f) -> vec3f {
  let aspect = SU.viewport.x * SU.viewport.w;
  let resY = clamp(round(SU.params0.y), 48.0, 240.0);
  let resX = max(48.0, round(resY * aspect));
  let grid = vec2f(resX, resY);
  let pixCoord = floor(uv * grid);
  let qUv = (pixCoord + 0.5) / grid;
  let stepUv = 1.0 / grid;

  let col = sSampleSceneSrgb(qUv);
  let aux = sSampleAux(qUv);
  let edges = sSampleEdges(qUv, stepUv * max(0.85, SU.params0.w * 0.9));

  // Contrast-stretched luminance so warm interior lamps and floor planks separate cleanly
  var luma = clamp((sLuma(col) - 0.08) * 1.48, 0.0, 1.0);

  // Distinct tonal separation for survivor and zombies
  if (abs(aux.g - 0.25) < 0.1) {
    luma = clamp(luma * 1.25 + 0.18, 0.0, 1.0);
  } else if (abs(aux.g - 0.50) < 0.1) {
    luma = clamp(luma * 1.15 + 0.12 + aux.b * 0.55, 0.0, 1.0);
  }

  // Dark silhouette & crease outlines
  let outlineW = SU.params0.w;
  let edgeStrength = max(edges.z, max(edges.x * 0.9, edges.y * 0.55));
  if (outlineW > 0.05 && edgeStrength > 0.52) {
    luma = luma * (1.0 - clamp(outlineW * 0.85, 0.0, 1.0));
  } else if (edges.y > 0.52 && luma > 0.25) {
    // Crisp bright top-edge highlight on furniture/walls
    luma = min(1.0, luma + 0.22);
  }

  // Crisp 1-bit gunshot beam, muzzle flash & zombie hit burst on top of outlines
  let shotInt = SU.shotMeta.x * SU.params1.w;
  if (shotInt > 0.02) {
    let seg = sSegmentDist(qUv, SU.shotScreen.xy, SU.shotScreen.zw, aspect);
    if (seg.x < stepUv.y * 0.95 && seg.y > 0.02 && seg.y < 0.98) {
      luma = 1.0;
    }
    let dMuzzle = length((qUv - SU.shotScreen.xy) * vec2f(aspect, 1.0));
    if (dMuzzle < stepUv.y * 2.5) {
      luma = 1.0;
    }
    let dHit = length((qUv - SU.shotScreen.zw) * vec2f(aspect, 1.0));
    if (SU.shotMeta.y > 0.05 && dHit < stepUv.y * 2.8) {
      luma = select(0.0, 1.0, dHit < stepUv.y * 1.6);
    }
  }

  let palIdx = i32(round(SU.params0.z));
  let isTwoTone = palIdx == 1 || palIdx == 3 || round(SU.params1.z) <= 2.0;
  let bayer = sBayer8(pixCoord) * SU.params1.x;
  let levels = select(max(2.0, min(4.0, round(SU.params1.z))), 2.0, isTwoTone);
  let quant = floor(clamp(luma + bayer * (0.95 / levels), 0.0, 0.999) * levels) / (levels - 1.0);

  return evalOneBitPalette(quant, palIdx);
}
`,
}
