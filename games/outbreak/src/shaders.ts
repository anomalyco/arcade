import { makeLookPostShader, makeLookSceneShader, makeSceneShader, spriteShader, postShader, type PostFinishOptions, type SceneHooks } from "@arcade/kit/gpu/shaders"
import { surfaceMaterial, surfaceMaterialDeclarations } from "@arcade/kit/gpu/surface-materials"
import { foliageWindDeclarationsWgsl } from "@arcade/kit/gpu/foliage"
import { BUILDING_RECTS } from "../shared/map"
import { outbreakLightingDeclarationsWgsl } from "./lighting"

export const outbreakPostFinish: PostFinishOptions = {
  chromatic: 0,
  bloom: .048,
  grain: .002,
  vignette: .84,
  diagnostics: true,
  shadowLift: 0,
  huePreserve: .42,
}

export const outbreakSceneHooks: SceneHooks = {
  ao: "0.42",
  bounce: "vec3f(0.0)",
  lightLeak: "0.004 * vis",
  lightAttenuation: `let dn = max(d3, 0.85);
    let tight = max(0.5, OL.u0.w);
    if (L.cone.w > 0.5 && L.pos.w < 4.5 && L.extra.w > -0.5) {
      let rx = clamp(1.0 - max(0.0, abs(dv.x) - 0.78) / 0.52, 0.0, 1.0);
      let ry = clamp(1.0 - max(0.0, abs(dv.y - 0.38) - 0.62) / 0.85, 0.0, 1.0);
      win = rx * rx * ry * ry * (0.78 + 0.22 * smoothstep(0.0, 0.14, abs(dv.x)));
    }
    var att = power * win * (0.02 + 2.15 / (1.0 + dn * dn * 0.68 * tight));
    if (L.extra.w > -0.5 && L.pos.w > 4.2 && L.cone.w < -0.5 && hl > 2.0) {
      let xFall = max(0.0, 1.0 - dv.x * dv.x * 0.22);
      att *= 0.82 + 0.65 * smoothstep(0.0, 2.8, dv.y) * xFall * xFall;
    }
    if (att <= 0.0035) { continue; }`,
  wallDirectScale: "mix(0.16, 0.30, smoothstep(0.0, 1.5, o.world.y))",
  ambient: "ambientAt(n) * mix(0.03, 0.82, select(1.0, select(fd.g * 0.65, 0.03, abs(n.y) < 0.5), inRoom && o.world.y < 2.8)) + select(vec3f(0.0), vec3f(0.004, 0.003, 0.0018), inRoom && o.world.y < 2.8)",
  diagnostics: "F.map.z",
  smoothShadows: true,
  shadowTaps: 5,
  lightMask: "if (L.cone.w < -0.5 && world.y > 2.75) { continue; }\n    if (i == 1u && L.cone.w > 0.5 && L.pos.w > 6.0 && abs(n.y) < 0.5 && OL.u5.w > 0.5) { continue; }",
  material: " ",
  postLightMaterial: `${surfaceMaterial}
    let inRoom = interior(o.world.xz + n.xz * 0.28);`,
  fragmentStart: "surfaceFootprint = max(length(dpdx(o.world)), length(dpdy(o.world))); surfaceTime = F.cam.w;",
  vertex: /* wgsl */ `
  if (v.matAux.x > 21.5 && v.matAux.x < 22.5) {
    let fw = applyFoliageVertexWind(o.world, o.normal, v.matAux.y, F.cam.w, F.cam.xyz, defaultFoliageWindConfig());
    o.world = fw[0];
    o.normal = fw[1];
  }`,
  declarations: /* wgsl */ `
@group(0) @binding(9) var exploredTex: texture_2d<f32>;
${outbreakLightingDeclarationsWgsl}
${surfaceMaterialDeclarations}
${foliageWindDeclarationsWgsl}
fn houseRect(id: i32) -> vec4f {
  switch id {
    ${BUILDING_RECTS.map((b,i)=>`${i===3?"default":`case ${i}`}: {return vec4f(${b.map(v=>v.toFixed(2)).join(",")});}`).join("\n")}
  }
}
fn interior(p:vec2f) -> bool {
  let b = select(
    select(vec4f(53.22, 54.22, 71.78, 67.78), vec4f(53.22, 23.22, 72.78, 37.78), p.y < 45.0),
    select(vec4f(21.0, 54.0, 36.0, 65.5), vec4f(22.0, 24.0, 37.0, 35.5), p.y < 45.0),
    p.x < 45.0
  );
  let south = p.x > b.x + 0.22 && p.x < b.z - 0.22 && p.y > b.y + 5.70 && p.y < b.w - 0.22;
  let north = p.x > b.x + 2.22 && p.x < b.x + 9.28 && p.y > b.y + 0.22 && p.y < b.y + 5.72;
  return select(all(p > b.xy) && all(p < b.zw), south || north, p.x < 45.0);
}
fn roofCut(p:vec3f, id:i32, frag:vec4f) -> bool {
  let b=houseRect(id);
  if (F.eye.z <= 1.0001) {
    if (F.eye.x < b.x - 0.1 || F.eye.x > b.z + 0.1 || F.eye.y < b.y - 0.1 || F.eye.y > b.w + 0.1) { return false; }
    if (id < 2) {
      let eyeIn = F.eye.y > b.y + 5.4 || (F.eye.x > b.x + 1.9 && F.eye.x < b.x + 9.6);
      if (!eyeIn) { return false; }
      let south = p.x > b.x + 0.35 && p.x < b.z - 0.35 && p.z > b.y + 5.65 && p.z < b.w + 1.65;
      let north = p.x > b.x + 2.25 && p.x < b.x + 9.25 && p.z > b.y + 0.35 && p.z < b.y + 5.85;
      return south || north;
    }
    return p.x>b.x+0.35&&p.x<b.z-0.35&&p.z>b.y+0.35&&p.z<b.w+1.65;
  }
  if (!(all(F.eye.xy>b.xy-0.1)&&all(F.eye.xy<b.zw+0.1)&&all(p.xz>b.xy-0.55)&&all(p.xz<b.zw+1.65))) {
    return false;
  }
  let alpha = clamp(F.eye.z - 1.0, 0.0, 1.0);
  let worldR = length(p.xz - F.eye.xy) / (5.8 * alpha + 0.001);
  if (worldR > 1.0) { return false; }
  let fade = smoothstep(1.0, 0.48, worldR) * alpha;
  if (fade >= 0.995) { return true; }
  return bayer4x4(frag) < fade;
}
fn eyeVisible(p: vec2f) -> f32 {
  let delta = p - lights[0].pos.xz;
  let d2 = dot(delta, delta);
  let r = lights[0].pos.w;
  if (d2 >= r * r) { return 0.0; }
  let distance = sqrt(d2);
  let facing = dot(delta / max(distance, 0.001), vec2f(cos(F.effects.x), sin(F.effects.x)));
  let cone = smoothstep(F.effects.y, F.effects.y + 0.035, facing);
  let near = 1.0 - smoothstep(F.effects.z - 0.2, F.effects.z, distance);
  let mask = max(cone, near);
  if (mask <= 0.0) { return 0.0; }
  let range = 1.0 - smoothstep(r - 1.0, r, distance);
  let a = (atan2(delta.y, delta.x) + TAU) % TAU;
  let f = a / TAU * f32(RAYS) - 0.5;
  let ray0 = u32(i32(floor(f)) + i32(RAYS)) % RAYS;
  let ray1 = (ray0 + 1u) % RAYS;
  let los0 = 1.0 - smoothstep(polar[ray0 * 2u].x + 0.025, polar[ray0 * 2u].x + 0.10, distance);
  let los1 = 1.0 - smoothstep(polar[ray1 * 2u].x + 0.025, polar[ray1 * 2u].x + 0.10, distance);
  return mix(los0, los1, fract(f)) * mask * range;
}`,
  directional: "mix(vec3f(0.46, 0.68, 1.08), vec3f(1.0, 0.79, 0.53), F.monitorBounds.w) * select(select(fd.g * 1.75, 0.08, abs(n.y) < 0.5), 1.0, !inRoom || o.world.y > 2.8) * F.ambient.w * select(max(0.0, dot(n, F.monitorBounds.xyz)), max(0.0, (dot(n, F.monitorBounds.xyz) + 0.52) / 1.52), mat == 22)",
  cutaway: `
      if (i32(round(o.mat)) == 21 && roofCut(o.world, i32(round(o.aux)), o.pos)) { discard; }
      if (o.world.y > 2.8 && interior(o.world.xz)) {
        for(var i=0;i<4;i++) { if(roofCut(o.world,i,o.pos)){discard;} }
      }
      if (F.eye.z > 1.0001 && o.world.y > 0.88 && (mat == 4 || mat == 9 || mat == 2 || mat == 6)) {
        let alpha = clamp(F.eye.z - 1.0, 0.0, 1.0);
        let wr = length(o.world.xz - F.eye.xy) / (3.4 * alpha + 0.001);
        if (wr < 1.0 && bayer4x4(o.pos) < smoothstep(1.0, 0.45, wr) * alpha * 0.92) { discard; }
      }
    `,
  // High/roof triangles are always routed through fs; low opaque triangles cannot hit these discards.
  solidCutaway: "",
  surface: /* wgsl */ `
  let nightLamps = clamp(1.0 - F.monitorBounds.w * 1.4, 0.0, 1.0);
  if (mat == 6) {
    // Clear window glass without milky white wash so rich warm amber interior & dark drapes read crisply.
    let outsideView = !interior(F.eye.xy);
    col = select(vec3f(0.012, 0.022, 0.045), vec3f(0.18, 0.075, 0.015) * nightLamps, outsideView);
  } else if (mat == 21) {
    // Cool steel-blue directional moonlight on shingle courses & porch gable; eaves stay shadowed.
    let eave = smoothstep(2.85, 3.55, o.world.y);
    let courseStep = smoothstep(0.65, 0.96, fract(o.world.z / 0.24));
    let tabGrain = 0.72 + 0.56 * surfaceNoise(o.world.xz * 6.2);
    let moonRim = OL.u2.z * select(1.45, 0.65, OL.u5.w > 0.5);
    col = col * mix(0.84, 1.32, eave) * tabGrain + vec3f(0.014, 0.026, 0.058) * F.ambient.w * moonRim * (0.58 * eave + 0.42 * courseStep) * max(0.0, n.y);
  } else {
    let inRoom = interior(o.world.xz + n.xz * 0.28);
    if (mat == 20) {
      let kind = i32(round(o.aux));
      if (kind == 0) {
        // Overgrown dark-clump variation across lawns & yards with cool desaturated night moonlight + warm window/porch bounce.
        let turfPatch = surfaceNoise(o.world.xz * 0.46 + vec2f(1.9, 4.7));
        col *= mix(0.48, 1.06, smoothstep(0.26, 0.76, turfPatch));
        let turfLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
        col = mix(vec3f(turfLum) * vec3f(0.92, 0.96, 1.18), col, 0.28);
        if (o.world.z > 35.4 && o.world.z < 38.2 && o.world.x > 21.5 && o.world.x < 37.5 && OL.u5.w < 0.5) {
          let lawnGlow = (exp(-pow((o.world.x - 24.5) * 0.42, 2.0)) + exp(-pow((o.world.x - 34.2) * 0.42, 2.0)) + exp(-pow((o.world.x - 27.7) * 0.35, 2.0)) * 1.1) * exp(-pow((o.world.z - 36.8) * 0.55, 2.0));
          col += vec3f(0.011, 0.010, 0.011) * lawnGlow * nightLamps;
        }
      } else if (kind == 1) {
        // Textured cracked asphalt: dark gutters & wheel ruts, jagged fracture lines, coarse aggregate, and wet moonlit road sheen.
        let p = o.world.xz;
        let roadU = clamp((p.y - 40.0) / 8.0, 0.0, 1.0);
        let crown = 1.0 - abs(roadU * 2.0 - 1.0);
        let gutter = smoothstep(0.0, 0.18, roadU) * smoothstep(0.0, 0.18, 1.0 - roadU);
        let ruts = max(0.0, 1.0 - pow((roadU - 0.28) * 6.5, 2.0)) + max(0.0, 1.0 - pow((roadU - 0.72) * 6.5, 2.0));
        let roadMacro = surfaceNoise(p * 0.28 + vec2f(3.7, 8.1));
        let w1 = surfaceNoise(p * 1.45 + vec2f(1.7, 5.3));
        let w2 = surfaceNoise(p * 2.95 + vec2f(8.2, 2.9));
        let warp = w1 * 0.65 + w2 * 0.35;
        let fx = abs(fract(p.x * 0.34 + warp * 0.52) - 0.5);
        let fy = abs(fract(p.y * 0.42 - warp * 0.48 + roadMacro * 0.35) - 0.5);
        let mask = smoothstep(0.38, 0.64, roadMacro);
        let cracks = clamp(((1.0 - smoothstep(0.004, 0.016, fx)) + (1.0 - smoothstep(0.005, 0.018, fy)) * 0.85) * mask, 0.0, 1.0);
        let grit = (w2 - 0.5) * 0.36;
        let dxRoad = (p.x - 32.0) * 0.062;
        let centerFocus = max(0.0, 1.0 - dxRoad * dxRoad);
        col *= (0.58 + 0.32 * gutter - 0.10 * ruts + 0.20 * (roadMacro - 0.5) + grit) * (1.0 - 0.48 * cracks);
        let wetRoad = (0.38 + 0.62 * crown) * (0.42 + 0.58 * centerFocus) * (0.58 + 0.85 * w1) * (1.0 - 0.55 * cracks);
        col += vec3f(0.030, 0.038, 0.060) * F.ambient.w * OL.u2.y * wetRoad;
      } else if (kind == 2 || kind == 6) {
        let inVerge = (o.world.z > 39.30 && o.world.z < 39.80) || (o.world.z > 48.20 && o.world.z < 48.70);
        if (!inVerge) {
          let gritWalk = 0.76 + 0.48 * surfaceNoise(o.world.xz * 7.5);
          let extScale = select(1.0, 0.45, OL.u5.w > 0.5);
          let frontBand = smoothstep(42.0, 37.5, o.world.z) * smoothstep(18.0, 23.0, o.world.x) * smoothstep(41.0, 36.0, o.world.x);
          col = col * 0.92 * gritWalk + vec3f(0.022, 0.022, 0.025) * F.ambient.w * gritWalk * (0.75 + 0.65 * frontBand * extScale);
          // Wet porch walkway & sidewalk reflection streak under the porch sconces (x ~ 27.7, z ~ 35.4..40.4)
          let dxWalk = o.world.x - 27.7;
          if (abs(dxWalk) < 5.8 && o.world.z > 35.3 && o.world.z < 40.4) {
            let walkCore = exp(-(dxWalk * dxWalk) / 1.15) * smoothstep(40.4, 35.5, o.world.z);
            let sideSpread = exp(-(dxWalk * dxWalk) / 11.0) * smoothstep(37.6, 38.4, o.world.z) * smoothstep(40.2, 38.8, o.world.z);
            col += vec3f(0.105, 0.078, 0.048) * (walkCore * 1.18 + sideSpread * 0.88) * gritWalk * OL.u2.y * nightLamps * extScale;
          }
        }
      }
    } else if (mat == 4 && !inRoom) {
      col *= mix(1.0,.52,smoothstep(2.15,2.78,o.world.y));
      // Subdue overly bright white window trim & clapboard outside the porch sconce core
      if (o.world.z > 35.15) {
        let nearPorch = exp(-pow((o.world.x - 27.7) / 1.65, 2.0));
        col *= mix(0.68, 1.02, nearPorch);
      }
    }
    if (!inRoom) {
      // Peripheral darkness vignette: outer lawns, sidewalks, and trees recede into night shadow
      let vigDark = clamp(OL.u2.w, 0.0, 1.2);
      let dCenter = length((o.world.xz - vec2f(29.5, select(39.0, 30.5, OL.u5.w > 0.5))) * vec2f(0.062, 0.075));
      let periphShade = mix(1.0, clamp(1.18 - dCenter * 0.52, 0.34, 1.0), vigDark);
      // When inside a building cutaway, dim the exterior yard & sidewalk so interior light pools lead the eye
      let extCutDim = select(1.0, mix(0.46, 0.74, exp(-pow((o.world.x - 27.7) * 0.32, 2.0)) * smoothstep(42.0, 35.2, o.world.z)), OL.u5.w > 0.5);
      col *= periphShade * extCutDim;
    } else if (o.world.y < 2.74) {
      col += evalInteriorWallWash(o.world, n, o.color) * nightLamps;
      // Subdue cream-white kitchen refrigerator & runner border in the shadowed NW kitchen corner
      if (o.world.x > 30.8 && o.world.x < 35.0 && o.world.z > 29.6 && o.world.z < 31.3) {
        if (o.world.y > 0.85 || (o.world.y > 0.131 && o.world.y < 0.148)) {
          col *= 0.24;
        }
      }
    }
    // Darken cutaway wall-top molding (y = 2.75..2.82) so interior walls don't have a bright beige outline
    if (o.world.y > 2.74 && o.world.y < 2.83 && n.y > 0.75) {
      col *= 0.16;
    }
    if (mat == 22) {
      // Above the Grassland + Botanics subsurface chlorophyll translucency & 4th-power grazing Fresnel rim.
      let tipWeight = clamp(abs(o.aux), 0.0, 1.0);
      let keyDir = normalize(F.monitorBounds.xyz);
      let forwardScatter = pow(clamp(dot(-V, keyDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
      let backNormal = max(0.0, dot(-n, keyDir));
      let transLobe = (forwardScatter * 0.55 + backNormal * 0.45) * F.ambient.w * 0.24 * tipWeight;
      let chloroTint = mix(vec3f(0.10, 0.24, 0.05), vec3f(0.28, 0.44, 0.14), sqrt(tipWeight));
      let fresnelRim = pow(1.0 - max(dot(n, V), 0.0), 4.0) * 0.14 * tipWeight * F.ambient.w;
      col += o.color * (chloroTint * transLobe + vec3f(0.32, 0.52, 0.22) * fresnelRim);
      if (o.world.y < 0.48) {
        let lawnPatch = surfaceNoise(o.world.xz * 0.46 + vec2f(1.9, 4.7));
        col *= mix(0.40, 0.95, smoothstep(0.26, 0.76, lawnPatch));
      }
    }
    if (mat != 12) {
      let visible = eyeVisible(o.world.xz + n.xz * 0.06);
      let explored = textureSampleLevel(exploredTex, floorSamp, (o.world.xz + n.xz * 0.24) * F.map.xy, 0.0).r;
      if (mat == 2) {
        col *= .88;
        if (inRoom && o.world.y < 2.8) { col *= max(explored, visible); }
      } else {
        let luminance=dot(col,vec3f(.2126,.7152,.0722));
        let peripheral=mix(vec3f(luminance)*vec3f(.83,.94,1.05),col,.72);
        if (inRoom && o.world.y < 2.8) {
          let room=mix(vec3f(luminance)*vec3f(.90,.96,1.0),col,.88+.12*visible);
          let reveal = max(explored, visible * 0.92);
          col=mix(o.color*.008, room * mix(F.effects.w, 1.0, .82), reveal);
        } else {
          col=mix(peripheral*(.86+.14*explored),col,.86+.14*visible);
        }
      }
    } else {
      // Actor readability (survivor & zombies): cool directional moonlight rim + top shoulder catch so silhouettes read in the dark
      let actorRim = pow(1.0 - max(dot(n, V), 0.0), 2.6) * OL.u2.z;
      let topCatch = max(0.0, n.y) * 0.45 * OL.u2.z;
      col += vec3f(0.032, 0.048, 0.082) * F.ambient.w * (actorRim + topCatch);
    }
    col += evalFlashlightBeam(o.world, n, V, o.color, inRoom, mat);
  }
`,
}

/** Slot zero casts from eye height, has no radiance, and is reserved for visibility. */
export const shaders = {
  sprite: spriteShader(),
  post: postShader(false, false, outbreakPostFinish),
  scene: makeSceneShader(outbreakSceneHooks),
  lookScene: makeLookSceneShader(outbreakSceneHooks),
  lookPost: makeLookPostShader(outbreakPostFinish),
}
