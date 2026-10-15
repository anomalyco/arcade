import type { StylePresentationModule } from "./types"

export const tinyPixelStyle: StylePresentationModule = {
  id: "tiny-pixel",
  index: 0,
  name: "Tiny Pixel",
  shortName: "Pixel",
  tagline: "96p nearest-neighbour pixel art, 16-colour palette, 4×4 Bayer dither & 1px sprite outlines",
  defaultPeople: "blocky",
  defaults: {
    pixelSize: 96,
    palette: 0,
    outlineWidth: 1.0,
    dither: 0.65,
    halftoneSize: 4.0,
    rampSteps: 4,
    fxPunch: 1.15,
    pixelSnap: true,
  },
  palettes: ["Outbreak Night 16", "PICO-8 16", "Endesga 16", "Sunset Dusk 16"],
  scaling: {
    verdict: "scales",
    summary: "Scales cleanly to full Outbreak; rendering the scene at 96–160p cuts fragment work by 85–95%.",
    whatItTakes:
      "Snap camera pan to 1/pixelSize world increments, route the main pass to a low-res target, and keep HUD/prompts at native resolution.",
  },
  wgsl: /* wgsl */ `
fn nearestTinyPalette(c: vec3f, pal: i32) -> vec3f {
  // Curated 16-colour palettes (Outbreak Night, PICO-8, Endesga-inspired, Sunset Dusk)
  let p0 = array<vec3f, 16>(
    vec3f(0.05, 0.06, 0.11), vec3f(0.10, 0.12, 0.20), vec3f(0.16, 0.19, 0.30), vec3f(0.24, 0.28, 0.41),
    vec3f(0.22, 0.15, 0.12), vec3f(0.36, 0.24, 0.17), vec3f(0.52, 0.35, 0.23), vec3f(0.69, 0.48, 0.30),
    vec3f(0.86, 0.65, 0.38), vec3f(0.98, 0.84, 0.52), vec3f(1.00, 0.96, 0.78), vec3f(0.24, 0.42, 0.32),
    vec3f(0.40, 0.62, 0.42), vec3f(0.32, 0.46, 0.64), vec3f(0.76, 0.24, 0.24), vec3f(0.96, 0.45, 0.22)
  );
  let p1 = array<vec3f, 16>(
    vec3f(0.00, 0.00, 0.00), vec3f(0.11, 0.17, 0.33), vec3f(0.49, 0.15, 0.33), vec3f(0.00, 0.53, 0.32),
    vec3f(0.67, 0.32, 0.21), vec3f(0.37, 0.34, 0.31), vec3f(0.76, 0.76, 0.78), vec3f(1.00, 0.95, 0.91),
    vec3f(1.00, 0.00, 0.30), vec3f(1.00, 0.64, 0.00), vec3f(1.00, 0.93, 0.15), vec3f(0.00, 0.89, 0.21),
    vec3f(0.16, 0.68, 1.00), vec3f(0.51, 0.46, 0.61), vec3f(1.00, 0.47, 0.66), vec3f(1.00, 0.80, 0.67)
  );
  let p2 = array<vec3f, 16>(
    vec3f(0.09, 0.08, 0.15), vec3f(0.15, 0.17, 0.27), vec3f(0.23, 0.27, 0.40), vec3f(0.35, 0.41, 0.53),
    vec3f(0.25, 0.16, 0.20), vec3f(0.45, 0.24, 0.22), vec3f(0.68, 0.38, 0.26), vec3f(0.89, 0.58, 0.32),
    vec3f(0.97, 0.80, 0.45), vec3f(0.99, 0.95, 0.76), vec3f(0.15, 0.36, 0.26), vec3f(0.24, 0.54, 0.30),
    vec3f(0.39, 0.72, 0.35), vec3f(0.72, 0.20, 0.25), vec3f(0.90, 0.33, 0.27), vec3f(0.55, 0.65, 0.76)
  );
  var best = p0[0];
  var bestD = 1e9;
  for (var i = 0; i < 16; i++) {
    let cand = select(select(p0[i], p1[i], pal == 1), p2[i], pal >= 2);
    let dVec = (c - cand) * vec3f(0.30, 0.59, 0.11) + (c - cand) * 0.45;
    let d = dot(dVec, dVec);
    if (d < bestD) {
      bestD = d;
      best = cand;
    }
  }
  return best;
}

fn evalStyle_0(uv: vec2f) -> vec3f {
  let aspect = SU.viewport.x * SU.viewport.w;
  let resY = clamp(round(SU.params0.y), 48.0, 240.0);
  let resX = max(48.0, round(resY * aspect));
  let grid = vec2f(resX, resY);
  let pixCoord = floor(uv * grid);
  let qUv = (pixCoord + 0.5) / grid;
  let stepUv = 1.0 / grid;

  var col = sSampleSceneSrgb(qUv);
  let aux = sSampleAux(qUv);
  let nd = sSampleNormalDepth(qUv);

  // Boost warm lamp pools & character readability before low-res palette snap
  let luma = sLuma(col);
  let steps = max(2.0, round(SU.params1.z));
  let bayer = sBayer4(pixCoord) * SU.params1.x * 0.18;
  let quantLuma = floor(clamp(luma + bayer, 0.0, 0.999) * steps) / (steps - 1.0);
  col = col * (0.35 + 0.65 * (quantLuma / max(luma, 0.04))) + bayer * 0.45;

  // Highlight survivor jacket & zombie green skin at tiny pixel resolution
  if (abs(aux.g - 0.25) < 0.1) {
    col = mix(col, vec3f(0.92, 0.72, 0.36), 0.32);
  } else if (abs(aux.g - 0.50) < 0.1) {
    col = mix(col, vec3f(0.45, 0.72, 0.42), 0.35);
    if (aux.b > 0.15) {
      col = mix(col, vec3f(1.0, 0.92, 0.78), clamp(aux.b * 0.85, 0.0, 1.0));
    }
  }

  // Pixelated gunshot tracer, muzzle flash & impact burst from SessionView.shots
  let shotInt = SU.shotMeta.x * SU.params1.w;
  if (shotInt > 0.02) {
    let seg = sSegmentDist(qUv, SU.shotScreen.xy, SU.shotScreen.zw, aspect);
    let pixRad = stepUv.y * 1.15;
    if (seg.x < pixRad && seg.y > 0.02 && seg.y < 0.98) {
      col = vec3f(1.0, 0.92, 0.48);
    }
    let dMuzzle = length((qUv - SU.shotScreen.xy) * vec2f(aspect, 1.0));
    if (dMuzzle < stepUv.y * 3.2) {
      col = select(vec3f(0.98, 0.64, 0.22), vec3f(1.0, 0.98, 0.82), dMuzzle < stepUv.y * 1.7);
    }
    let dHit = length((qUv - SU.shotScreen.zw) * vec2f(aspect, 1.0));
    if (dHit < stepUv.y * 3.6 && SU.shotMeta.y > 0.05) {
      col = select(vec3f(0.92, 0.26, 0.22), vec3f(1.0, 0.96, 0.78), dHit < stepUv.y * 1.8);
    }
  }

  let palIdx = i32(round(SU.params0.z));
  var outCol = nearestTinyPalette(clamp(col, vec3f(0.0), vec3f(1.0)), palIdx);

  // Crisp 1px dark pixel-art sprite & depth outlines
  let outlineW = SU.params0.w;
  if (outlineW > 0.05) {
    let edges = sSampleEdges(qUv, stepUv * 0.85);
    let isEdge = max(edges.z, edges.x * 0.85);
    if (isEdge > 0.58) {
      outCol = mix(outCol, vec3f(0.04, 0.04, 0.08), clamp(outlineW * 0.9, 0.0, 1.0));
    }
  }

  // Draw crisp pixel-art tracer & muzzle flash on top of outlines so gunfire pops cleanly
  if (shotInt > 0.02) {
    let seg = sSegmentDist(qUv, SU.shotScreen.xy, SU.shotScreen.zw, aspect);
    if (seg.x < stepUv.y * 0.85 && seg.y > 0.02 && seg.y < 0.98) {
      outCol = vec3f(1.0, 0.94, 0.52);
    }
    let dMuzzle = length((qUv - SU.shotScreen.xy) * vec2f(aspect, 1.0));
    if (dMuzzle < stepUv.y * 2.6) {
      outCol = select(vec3f(0.98, 0.64, 0.22), vec3f(1.0, 0.98, 0.82), dMuzzle < stepUv.y * 1.4);
    }
    let dHit = length((qUv - SU.shotScreen.zw) * vec2f(aspect, 1.0));
    if (dHit < stepUv.y * 2.8 && SU.shotMeta.y > 0.05) {
      outCol = select(vec3f(0.92, 0.26, 0.22), vec3f(1.0, 0.96, 0.78), dHit < stepUv.y * 1.4);
    }
  }

  return outCol;
}
`,
}
