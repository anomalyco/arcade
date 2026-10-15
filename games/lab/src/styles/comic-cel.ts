import type { StylePresentationModule } from "./types"

export const comicCelStyle: StylePresentationModule = {
  id: "comic-cel",
  index: 2,
  name: "Comic Book Cel",
  shortName: "Comic Cel",
  tagline: "Hard toon light ramps, India-ink outlines, rotated Ben-Day halftone & starburst impact marks",
  defaultPeople: "blocky",
  defaults: {
    pixelSize: 160,
    palette: 0,
    outlineWidth: 1.6,
    dither: 0.75,
    halftoneSize: 6.0,
    rampSteps: 3,
    fxPunch: 1.25,
    pixelSnap: false,
  },
  palettes: ["Pulp Action (Amber/Indigo)", "Noir Graphic (Sin City Red)", "Silver Age (Four-Colour)", "Toxic Green Issue"],
  scaling: {
    verdict: "scales",
    summary: "Scales cleanly to full Outbreak at +0.28 ms GPU; bold ink silhouettes make top-down combat super readable.",
    whatItTakes:
      "Bind the normal/depth edge pass in the main post chain and drive comic starburst/onomatopoeia decals from CombatShotEvent and NoiseBus.",
  },
  wgsl: /* wgsl */ `
fn evalComicStarburst(p: vec2f, center: vec2f, aspect: f32, radius: f32, spikes: f32, seed: f32) -> vec2f {
  let dVec = (p - center) * vec2f(aspect, 1.0);
  let r = length(dVec);
  let ang = atan2(dVec.y, dVec.x) + seed;
  let wave = abs(fract(ang * spikes / 6.2831853) * 2.0 - 1.0);
  let sharp = pow(wave, 0.65);
  let outerR = radius * (0.52 + 0.58 * sharp);
  let fill = 1.0 - smoothstep(outerR - 0.004, outerR, r);
  let border = (1.0 - smoothstep(outerR, outerR + 0.007, r)) * (1.0 - fill);
  return vec2f(fill, border);
}

fn evalStyle_2(uv: vec2f) -> vec3f {
  let texel = SU.viewport.zw;
  let aspect = SU.viewport.x * SU.viewport.w;
  let palIdx = i32(round(SU.params0.z));

  // Flatten micro-texture with a tight 5-tap Kuwahara-style average so colour blocks read as flat comic ink
  let c0 = sSampleSceneSrgb(uv);
  let c1 = sSampleSceneSrgb(uv + texel * vec2f(1.5, 1.5));
  let c2 = sSampleSceneSrgb(uv + texel * vec2f(-1.5, 1.5));
  let c3 = sSampleSceneSrgb(uv + texel * vec2f(1.5, -1.5));
  let c4 = sSampleSceneSrgb(uv + texel * vec2f(-1.5, -1.5));
  var base = (c0 * 2.0 + c1 + c2 + c3 + c4) / 6.0;

  let aux = sSampleAux(uv);
  let luma = sLuma(base);
  let chroma = base / max(luma, 0.035);

  // Hard toon light ramp (2..6 steps)
  let steps = max(2.0, round(SU.params1.z));
  let toonLuma = floor(clamp(luma * 1.28, 0.0, 0.999) * steps) / (steps - 1.0);
  let satChroma = mix(vec3f(1.0), chroma, 1.38);
  var col = clamp(satChroma * (0.14 + 0.92 * toonLuma), vec3f(0.0), vec3f(1.0));

  // Graphic novel shadow tint & palette styling
  let shadowMask = 1.0 - smoothstep(0.15, 0.52, toonLuma);
  if (palIdx == 1) {
    // Sin City Noir: high-contrast black/white with selective crimson & gold
    let bw = vec3f(step(0.32, toonLuma) * 0.92);
    let isRed = abs(aux.g - 0.50) < 0.1 && aux.b > 0.1;
    col = select(bw, vec3f(0.92, 0.14, 0.14), isRed);
  } else if (palIdx == 2) {
    // Silver Age 4-colour warm paper & cyan shadows
    col = mix(col * vec3f(1.05, 1.0, 0.88), vec3f(0.14, 0.24, 0.46), shadowMask * 0.65);
  } else if (palIdx == 3) {
    col = mix(col * vec3f(0.92, 1.08, 0.85), vec3f(0.10, 0.22, 0.18), shadowMask * 0.72);
  } else {
    // Pulp Action: warm amber-orange lit floorboards vs deep indigo-violet comic shadows
    col = mix(col * vec3f(1.12, 0.96, 0.82), vec3f(0.16, 0.11, 0.34), shadowMask * 0.68);
  }

  // Distinct comic fills for survivor (blue/gold vest) and zombies (sickly comic green)
  if (abs(aux.g - 0.25) < 0.1 && palIdx != 1) {
    col = mix(col, vec3f(0.24, 0.56, 0.95), 0.35);
  } else if (abs(aux.g - 0.50) < 0.1 && palIdx != 1) {
    col = mix(col, vec3f(0.46, 0.82, 0.34), 0.42);
  }

  // Rotated CMYK Ben-Day halftone dots in midtones and shadow transitions
  let dotScale = max(2.5, SU.params1.y);
  let pix = uv * SU.viewport.xy;
  let rot = vec2f(pix.x * 0.866 - pix.y * 0.5, pix.x * 0.5 + pix.y * 0.866) / dotScale;
  let cell = fract(rot) - vec2f(0.5);
  let dotDist = length(cell);
  let midMask = smoothstep(0.05, 0.25, luma) * (1.0 - smoothstep(0.48, 0.78, luma));
  let dotRadius = 0.42 * sqrt(clamp(1.0 - luma * 1.15, 0.0, 1.0)) * SU.params1.x;
  let inDot = 1.0 - smoothstep(dotRadius - 0.06, dotRadius + 0.06, dotDist);
  col = mix(col, col * vec3f(0.28, 0.18, 0.38), inDot * midMask * 0.72);

  // Variable-weight black India-ink contour outlines from depth, normal & actor silhouettes
  let outlineW = SU.params0.w;
  if (outlineW > 0.05) {
    let edges = sSampleEdges(uv, texel * (0.9 + outlineW * 0.95));
    let ink = clamp(max(edges.z * 1.15, max(edges.x, edges.y * 0.78)), 0.0, 1.0);
    col = mix(col, vec3f(0.03, 0.02, 0.05), ink * clamp(outlineW * 0.85, 0.0, 1.0));
  }

  // Comic-book starburst impact marks & radial speed lines on active gunfire/hits
  let punch = SU.shotMeta.x * SU.params1.w;
  if (punch > 0.02) {
    let seg = sSegmentDist(uv, SU.shotScreen.xy, SU.shotScreen.zw, aspect);
    // Tapered yellow-orange comic action lines along shot trajectory
    if (seg.x < 0.008 && seg.y > 0.04 && seg.y < 0.94) {
      let lineCore = 1.0 - smoothstep(0.0, 0.0032, seg.x);
      let lineInk = (1.0 - smoothstep(0.0032, 0.0065, seg.x)) * (1.0 - lineCore);
      col = mix(col, vec3f(0.04, 0.03, 0.06), lineInk * 0.9);
      col = mix(col, vec3f(1.0, 0.92, 0.28), lineCore);
    }
    // Muzzle flash comic star
    let muzStar = evalComicStarburst(uv, SU.shotScreen.xy, aspect, 0.036 * min(1.3, punch), 9.0, 0.4);
    col = mix(col, vec3f(0.03, 0.02, 0.05), muzStar.y);
    col = mix(col, vec3f(1.0, 0.88, 0.22), muzStar.x);

    // Hit impact comic starburst ("BLAM!" silhouette star) on struck zombie
    if (SU.shotMeta.y > 0.05) {
      let hitStar = evalComicStarburst(uv, SU.shotScreen.zw, aspect, 0.054 * min(1.35, punch), 11.0, 1.2);
      let innerStar = evalComicStarburst(uv, SU.shotScreen.zw, aspect, 0.028 * min(1.35, punch), 11.0, 1.2);
      col = mix(col, vec3f(0.03, 0.02, 0.05), hitStar.y);
      col = mix(col, vec3f(1.0, 0.52, 0.14), hitStar.x);
      col = mix(col, vec3f(1.0, 0.96, 0.38), innerStar.x);
    }
  }

  return col;
}
`,
}
