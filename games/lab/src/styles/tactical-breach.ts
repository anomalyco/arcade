import type { StylePresentationModule } from "./types"

export const tacticalBreachStyle: StylePresentationModule = {
  id: "tactical-breach",
  index: 6,
  name: "Tactical Breach",
  shortName: "Tactical",
  tagline: "Into the Breach / Blueprint 1m floor grid, cyan/amber unit tile frames & shot trajectory telegraphs",
  defaultPeople: "blocky",
  defaults: {
    pixelSize: 160,
    palette: 0,
    outlineWidth: 1.2,
    dither: 0.65,
    halftoneSize: 6.0,
    rampSteps: 4,
    fxPunch: 1.2,
    pixelSnap: false,
  },
  palettes: ["Into the Breach (Slate/Amber)", "Cyanotype Blueprint CAD", "Advance Tactics (Warm)", "Night Ops Thermal"],
  scaling: {
    verdict: "scales",
    summary: "Scales cleanly to full Outbreak at +0.16 ms GPU; world-space 1m grid and tile frames use existing sim coordinates.",
    whatItTakes:
      "Pass active zombie/player positions in a small storage/uniform array (already available in light/caster buffers) for floor-tile highlights.",
  },
  wgsl: /* wgsl */ `
fn evalTacticalTileFrame(worldXZ: vec2f, centerXZ: vec2f) -> f32 {
  let cellWorld = floor(worldXZ) + vec2f(0.5);
  let targetCell = floor(centerXZ) + vec2f(0.5);
  if ( any(abs(cellWorld - targetCell) > vec2f(0.1)) ) {
    return 0.0;
  }
  let local = abs(fract(worldXZ) - vec2f(0.5));
  let edgeDist = max(local.x, local.y);
  let frame = smoothstep(0.38, 0.45, edgeDist) * (1.0 - smoothstep(0.47, 0.50, edgeDist));
  let fill = (1.0 - smoothstep(0.0, 0.46, edgeDist)) * 0.16;
  return frame + fill;
}

fn evalStyle_6(uv: vec2f) -> vec3f {
  let texel = SU.viewport.zw;
  let aspect = SU.viewport.x * SU.viewport.w;
  let palIdx = i32(round(SU.params0.z));

  var col = sSampleSceneSrgb(uv);
  let nd = sSampleNormalDepth(uv);
  let aux = sSampleAux(uv);
  let wPos = sReconstructWorld(uv, nd.a);
  let isFloor = nd.y > 0.72 && wPos.y < 0.45 && aux.g < 0.1;

  if (palIdx == 1) {
    // Cyanotype Prussian Blueprint CAD look
    let l = sLuma(col);
    col = mix(vec3f(0.04, 0.16, 0.34), vec3f(0.20, 0.46, 0.78), clamp(l * 1.35, 0.0, 1.0));
  } else if (palIdx == 2) {
    col = pow(col, vec3f(0.9)) * vec3f(1.06, 1.02, 0.94);
  } else if (palIdx == 3) {
    let l = sLuma(col);
    col = vec3f(0.05, 0.14, 0.12) + vec3f(0.18, 0.68, 0.52) * l;
  } else {
    // Into the Breach clean tactical diorama slate & warm interior lamps
    col = mix(col, col * vec3f(0.86, 0.92, 1.04), 0.35);
  }

  // Crisp 1-metre world-space tactical floor grid inside the room
  if (isFloor) {
    let g1 = abs(fract(wPos.xz) - vec2f(0.5));
    let lineDist = min(0.5 - g1.x, 0.5 - g1.y);
    let gridLine = 1.0 - smoothstep(0.012, 0.038, lineDist);
    let gridCol = select(vec3f(0.55, 0.72, 0.92), vec3f(0.75, 0.90, 1.0), palIdx == 1);
    let gridWeight = clamp(SU.params1.y / 10.0, 0.15, 1.0);
    col = mix(col, gridCol, gridLine * 0.28 * gridWeight);

    // Glowing cyan tile frame under the survivor (SessionView.player)
    let pTile = evalTacticalTileFrame(wPos.xz, SU.playerWorld.xy);
    if (pTile > 0.001) {
      col = mix(col, vec3f(0.18, 0.92, 1.0), clamp(pTile * 0.95, 0.0, 1.0));
    }

    // Glowing amber-red threat tile frames under each living zombie (SessionView.zombies)
    for (var i = 0; i < 4; i++) {
      let z = SU.zombiesWorld[i];
      if (z.z > 0.5) {
        let zTile = evalTacticalTileFrame(wPos.xz, z.xy);
        if (zTile > 0.001) {
          let threatCol = select(vec3f(1.0, 0.38, 0.16), vec3f(1.0, 0.82, 0.24), z.z > 1.5);
          col = mix(col, threatCol, clamp(zTile * 0.95, 0.0, 1.0));
        }
      }
    }
  }

  // Clean CAD / diorama contour lines
  let outlineW = SU.params0.w;
  if (outlineW > 0.05) {
    let edges = sSampleEdges(uv, texel * max(0.85, outlineW * 0.85));
    let e = max(edges.z, max(edges.x * 0.9, edges.y * 0.65));
    let lineCol = select(vec3f(0.05, 0.07, 0.11), vec3f(0.88, 0.96, 1.0), palIdx == 1);
    col = mix(col, lineCol, clamp(e * outlineW * 0.65, 0.0, 0.92));
  }

  // Glowing tactical trajectory telegraph line & target reticle from pistol to lead zombie
  let seg = sSegmentDist(uv, SU.shotScreen.xy, SU.shotScreen.zw, aspect);
  if (seg.x < 0.006 && seg.y > 0.02 && seg.y < 0.98) {
    let dash = step(0.35, fract(seg.y * 18.0 - SU.params2.x * 3.0));
    let core = 1.0 - smoothstep(0.0, 0.0022, seg.x);
    let glow = 1.0 - smoothstep(0.0022, 0.006, seg.x);
    let beamWeight = max(0.45, SU.shotMeta.x) * SU.params1.w;
    col += vec3f(1.0, 0.68, 0.20) * (core * max(dash, SU.shotMeta.x) + glow * 0.45) * beamWeight;
  }

  return clamp(col, vec3f(0.0), vec3f(1.0));
}
`,
}
