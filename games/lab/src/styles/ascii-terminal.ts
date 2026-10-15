import type { StylePresentationModule } from "./types"

export const asciiTerminalStyle: StylePresentationModule = {
  id: "ascii-terminal",
  index: 8,
  name: "ASCII Terminal",
  shortName: "ASCII CRT",
  tagline: "GPU 5×7 glyph rasterizer mapping walls (#), floorboards (.:-), lamps (+*), survivor (@) & zombies (Z)",
  defaultPeople: "pawn",
  defaults: {
    pixelSize: 54,
    palette: 0,
    outlineWidth: 1.2,
    dither: 0.75,
    halftoneSize: 6.0,
    rampSteps: 6,
    fxPunch: 1.3,
    pixelSnap: true,
  },
  palettes: ["Phosphor Green + Amber", "Amber CRT Monochrome", "IBM 5151 Green", "Classic Rogue VT100"],
  scaling: {
    verdict: "fails",
    summary: "Charming in a single room, but fails at full Outbreak scale: character cells are too coarse for 42m camera zoom and diagonal doors/props.",
    whatItTakes:
      "Would require semantic tile-map projection rather than 3D perspective post-rasterization, plus separate native-res HUD.",
  },
  wgsl: /* wgsl */ `
// Bit-packed 5x7 bitmap glyphs (35 bits across two u32s: lo = rows 0..3, hi = rows 4..6)
// Glyph indices:
// 0: ' '   1: '.'   2: ':'   3: '-'   4: '='   5: '+'   6: '*'   7: '#'   8: '@' (survivor)   9: 'Z' (zombie)
fn sampleAsciiGlyph(glyph: i32, gx: i32, gy: i32) -> f32 {
  if (gx < 0 || gx >= 5 || gy < 0 || gy >= 7) { return 0.0; }
  var rowBits = 0u;
  switch (glyph) {
    case 1: { // '.'
      if (gy == 5) { rowBits = 4u; }
    }
    case 2: { // ':'
      if (gy == 2 || gy == 5) { rowBits = 4u; }
    }
    case 3: { // '-'
      if (gy == 3) { rowBits = 14u; }
    }
    case 4: { // '='
      if (gy == 2 || gy == 4) { rowBits = 31u; }
    }
    case 5: { // '+'
      if (gy == 3) { rowBits = 31u; }
      else if (gy >= 1 && gy <= 5) { rowBits = 4u; }
    }
    case 6: { // '*'
      if (gy == 1 || gy == 5) { rowBits = 21u; }
      else if (gy == 2 || gy == 4) { rowBits = 14u; }
      else if (gy == 3) { rowBits = 31u; }
    }
    case 7: { // '#'
      if (gy == 1 || gy == 5) { rowBits = 10u; }
      else if (gy == 2 || gy == 4) { rowBits = 31u; }
      else if (gy == 3) { rowBits = 10u; }
    }
    case 8: { // '@' (Survivor)
      if (gy == 0 || gy == 6) { rowBits = 14u; }
      else if (gy == 1) { rowBits = 17u; }
      else if (gy == 2 || gy == 3) { rowBits = 29u; }
      else if (gy == 4) { rowBits = 25u; }
      else if (gy == 5) { rowBits = 16u; }
    }
    case 9: { // 'Z' (Zombie)
      if (gy == 0 || gy == 6) { rowBits = 31u; }
      else if (gy == 1) { rowBits = 2u; }
      else if (gy == 2) { rowBits = 4u; }
      else if (gy == 3) { rowBits = 14u; }
      else if (gy == 4) { rowBits = 8u; }
      else if (gy == 5) { rowBits = 16u; }
    }
    default: {
      rowBits = 0u;
    }
  }
  let bit = (rowBits >> u32(4 - gx)) & 1u;
  return f32(bit);
}

fn evalStyle_8(uv: vec2f) -> vec3f {
  let aspect = SU.viewport.x * SU.viewport.w;
  let palIdx = i32(round(SU.params0.z));

  let rows = clamp(round(SU.params0.y), 36.0, 140.0);
  let cols = max(48.0, round(rows * aspect * 1.35));
  let grid = vec2f(cols, rows);
  let cellCoord = floor(uv * grid);
  let localUv = fract(uv * grid);
  let cellCenterUv = (cellCoord + 0.5) / grid;
  let stepUv = 1.0 / grid;

  let sceneCol = sSampleSceneSrgb(cellCenterUv);
  let aux = sSampleAux(cellCenterUv);
  let edges = sSampleEdges(cellCenterUv, stepUv * 0.85);
  let luma = clamp(sLuma(sceneCol) * 1.45, 0.0, 1.0);

  let isSurvivor = abs(aux.g - 0.25) < 0.12 || length((cellCenterUv - SU.playerScreen.xy) * vec2f(aspect, 1.0)) < stepUv.y * 1.25;
  let isZombie = abs(aux.g - 0.50) < 0.12;
  let isWallEdge = edges.x > 0.42 || edges.y > 0.52;

  // Check active gunshot beam & impact in cell space
  let punch = SU.shotMeta.x * SU.params1.w;
  let seg = sSegmentDist(cellCenterUv, SU.shotScreen.xy, SU.shotScreen.zw, aspect);
  let onShotBeam = punch > 0.02 && seg.x < stepUv.y * 0.95 && seg.y > 0.04 && seg.y < 0.94;
  let dHit = length((cellCenterUv - SU.shotScreen.zw) * vec2f(aspect, 1.0));
  let onHitBurst = punch > 0.02 && SU.shotMeta.y > 0.05 && dHit < stepUv.y * 2.4;

  var glyph = 0;
  if (isSurvivor) {
    glyph = 8; // '@'
  } else if (onHitBurst) {
    glyph = 6; // '*'
  } else if (isZombie) {
    glyph = 9; // 'Z'
  } else if (onShotBeam) {
    glyph = 3; // '-'
  } else if (isWallEdge) {
    glyph = select(4, 7, edges.x > 0.55); // '#' or '='
  } else if (luma > 0.72) {
    glyph = 6; // '*'
  } else if (luma > 0.52) {
    glyph = 5; // '+'
  } else if (luma > 0.34) {
    glyph = 3; // '-'
  } else if (luma > 0.18) {
    glyph = 2; // ':'
  } else if (luma > 0.06) {
    glyph = 1; // '.'
  }

  let gx = i32(floor(localUv.x * 6.0)) - 1;
  let gy = i32(floor(localUv.y * 8.0)) - 1;
  let bit = sampleAsciiGlyph(glyph, gx, gy);

  // Terminal phosphor palette
  var bgCol = vec3f(0.018, 0.038, 0.024);
  var fgCol = vec3f(0.22, 0.96, 0.42);
  let warmLamp = clamp((sceneCol.r - sceneCol.b) * 1.8, 0.0, 1.0);
  if (palIdx == 0) {
    fgCol = mix(vec3f(0.24, 0.94, 0.44), vec3f(1.0, 0.78, 0.22), warmLamp * 0.85);
    if (isSurvivor) { fgCol = vec3f(0.65, 1.0, 0.72); }
    if (isZombie) { fgCol = select(vec3f(0.55, 0.95, 0.35), vec3f(1.0, 0.28, 0.22), aux.b > 0.1); }
    if (onShotBeam) { fgCol = vec3f(1.0, 0.86, 0.28); }
    if (onHitBurst) { fgCol = vec3f(1.0, 0.26, 0.20); }
  } else if (palIdx == 1) {
    bgCol = vec3f(0.035, 0.020, 0.008);
    fgCol = vec3f(1.0, 0.68, 0.16);
  } else if (palIdx == 2) {
    bgCol = vec3f(0.012, 0.032, 0.016);
    fgCol = vec3f(0.18, 0.98, 0.38);
  } else {
    bgCol = vec3f(0.025, 0.028, 0.038);
    fgCol = select(vec3f(0.82, 0.88, 0.96), vec3f(1.0, 0.36, 0.32), isZombie || onHitBurst);
  }

  let intensity = select(clamp(0.35 + luma * 0.95, 0.25, 1.15), 1.25, isSurvivor || isZombie || onShotBeam || onHitBurst);
  let cellGlow = bgCol + fgCol * (0.06 * luma);
  var col = mix(cellGlow, fgCol * intensity, bit);

  // Subtle CRT scanline & vignette
  let pixY = uv.y * SU.viewport.y;
  let scan = 1.0 - 0.16 * SU.params1.x * (0.5 + 0.5 * cos(pixY * 3.14159));
  return clamp(col * scan, vec3f(0.0), vec3f(1.0));
}
`,
}
