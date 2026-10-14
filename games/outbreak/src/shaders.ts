import { makeLookPostShader, makeLookSceneShader, makeSceneShader, spriteShader, postShader, type PostFinishOptions, type SceneHooks } from "@arcade/kit/gpu/shaders"
import { surfaceMaterial, surfaceMaterialDeclarations } from "@arcade/kit/gpu/surface-materials"
import { foliageWindDeclarationsWgsl } from "@arcade/kit/gpu/foliage"
import { BUILDING_RECTS } from "../shared/map"
import { outbreakLightingDeclarationsWgsl } from "./lighting"

export const outbreakPostFinish: PostFinishOptions = {
  chromatic: 0.001,
  bloom: 0.068,
  halation: 0.055,
  grain: 0.014,
  vignette: 0.78,
  diagnostics: true,
  shadowLift: 0.52,
  shadowLiftColor: [0.0095, 0.0078, 0.0062],
  saturation: 0.88,
  shadowTint: [1.06, 0.97, 0.82],
  highlightTint: [1.14, 0.96, 0.72],
  huePreserve: 0.52,
}

export const outbreakSceneHooks: SceneHooks = {
  ao: "0.42",
  bounce: "vec3f(0.0)",
  lightLeak: "0.006 * vis",
  lightAttenuation: `let dn = max(d3, 0.85);
    let tight = max(0.5, OL.u0.w);
    if (L.cone.w > 0.5 && L.pos.w < 4.5 && L.extra.w > -0.5) {
      let rx = clamp(1.0 - max(0.0, abs(dv.x) - 0.85) / 0.58, 0.0, 1.0);
      let ry = clamp(1.0 - max(0.0, abs(dv.y - 0.42) - 0.72) / 0.98, 0.0, 1.0);
      win = rx * rx * ry * ry * (0.78 + 0.22 * smoothstep(0.0, 0.14, abs(dv.x)));
    }
    var att = power * win * (0.025 + 2.25 / (1.0 + dn * dn * 0.62 * tight));
    if (L.extra.w > -0.5 && L.pos.w > 4.2 && L.cone.w < -0.5 && hl > 2.0) {
      let xFall = max(0.0, 1.0 - dv.x * dv.x * 0.16);
      att *= 0.88 + 0.78 * smoothstep(0.0, 3.4, dv.y) * xFall * xFall;
    }
    if (att <= 0.0035) { continue; }`,
  wallDirectScale: "mix(0.18, 0.34, smoothstep(0.0, 1.5, o.world.y))",
  ambient: "outbreakSkyAmbient(n, F.ambient.rgb) * mix(0.03, 0.88, select(1.0, select(fd.g * 0.28, 0.03, abs(n.y) < 0.5), inRoom && o.world.y < 2.8)) + select(vec3f(0.0), vec3f(0.004, 0.0024, 0.0010), inRoom && o.world.y < 2.8)",
  diagnostics: "F.map.z",
  smoothShadows: true,
  shadowTaps: 5,
  lightMask: "if (L.cone.w < -0.5 && world.y > 2.75) { continue; }",
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
  directional: "mix(mix(vec3f(0.46, 0.68, 1.08), vec3f(0.95, 0.72, 0.46), clamp(OL.u0.z, 0.0, 1.0)), vec3f(1.0, 0.79, 0.53), F.monitorBounds.w) * select(select(fd.g * 0.42, 0.03, abs(n.y) < 0.5), 1.0, !inRoom || o.world.y > 2.8) * F.ambient.w * select(max(0.0, dot(n, F.monitorBounds.xyz)), max(0.0, (dot(n, F.monitorBounds.xyz) + 0.52) / 1.52), mat == 22)",
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
    // Weathered charcoal-slate roof shingles catching twilight sky & warm sodium/porch bounce; eaves stay grounded.
    let eave = smoothstep(2.85, 3.55, o.world.y);
    let courseStep = smoothstep(0.62, 0.96, fract(o.world.z / 0.24));
    let tabGrain = 0.72 + 0.56 * surfaceNoise(o.world.xz * 6.2);
    let w = clamp(OL.u0.z, 0.0, 1.0);
    let roofTint = mix(vec3f(0.014, 0.026, 0.058), vec3f(0.115, 0.100, 0.088), w);
    let extRoofScale = select(1.0, 0.44, OL.u5.w > 0.5);
    col = col * mix(1.02, 1.58, eave) * tabGrain * extRoofScale + roofTint * F.ambient.w * OL.u2.z * (0.58 * eave + 0.42 * courseStep) * max(0.0, n.y) * extRoofScale;
  } else {
    let inRoom = interior(o.world.xz + n.xz * 0.28);
    let w = clamp(OL.u0.z, 0.0, 1.0);
    if (mat == 20) {
      let kind = i32(round(o.aux));
      if (kind == 0) {
        // Muted 70s olive-ochre-moss lawn turf with clump variation & fallen autumn leaf flecks.
        let turfPatch = surfaceNoise(o.world.xz * 0.46 + vec2f(1.9, 4.7));
        col *= mix(0.56, 1.22, smoothstep(0.24, 0.76, turfPatch));
        let turfLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
        let oliveOchre = vec3f(turfLum) * mix(vec3f(0.92, 0.96, 1.14), vec3f(1.34, 0.94, 0.50), w);
        col = mix(col, oliveOchre, 0.74);
      } else if (kind == 1) {
        // Textured cracked asphalt: dark gutters & wheel ruts, alligator fracture lines, coarse aggregate, and warm-slate twilight sheen.
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
        let grit = (w2 - 0.5) * 0.38;
        let dxRoad = (p.x - 31.5) * 0.055;
        let centerFocus = max(0.0, 1.0 - dxRoad * dxRoad);
        col *= (0.88 + 0.34 * gutter - 0.08 * ruts + 0.20 * (roadMacro - 0.5) + grit) * (1.0 - 0.52 * cracks);
        let wetRoad = (0.55 + 0.45 * crown) * (0.52 + 0.48 * centerFocus) * (0.64 + 0.76 * w1) * (1.0 - 0.52 * cracks);
        let roadSheenCol = mix(vec3f(0.030, 0.038, 0.060), vec3f(0.112, 0.090, 0.072), w);
        col += roadSheenCol * F.ambient.w * OL.u2.y * wetRoad;
      } else if (kind == 2 || kind == 6) {
        let inVerge = (o.world.z > 39.30 && o.world.z < 39.80) || (o.world.z > 48.20 && o.world.z < 48.70);
        if (!inVerge) {
          let gritWalk = 0.74 + 0.52 * surfaceNoise(o.world.xz * 7.5);
          let walkLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
          let warmStone = vec3f(walkLum) * vec3f(1.24, 0.88, 0.50);
          col = mix(col * 0.56, warmStone * 0.50, w) * gritWalk;
          // Warm porch walkway reflection streak
          let dxWalk = o.world.x - 27.7;
          if (abs(dxWalk) < 4.5 && o.world.z > 35.3 && o.world.z < 40.4) {
            let walkCore = exp(-(dxWalk * dxWalk) / 1.15) * smoothstep(40.4, 35.5, o.world.z);
            let sideSpread = exp(-(dxWalk * dxWalk) / 7.5) * smoothstep(37.6, 38.4, o.world.z) * smoothstep(40.2, 38.8, o.world.z);
            let extScale = select(1.0, 0.68, OL.u5.w > 0.5);
            col += col * vec3f(1.15, 0.65, 0.22) * (walkCore * 0.95 + sideSpread * 0.45) * OL.u2.y * nightLamps * extScale;
          }
        }
      }
    } else if (mat == 4 && !inRoom) {
      col *= mix(1.0, 0.56, smoothstep(2.15, 2.78, o.world.y));
      let wallLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
      col = mix(col, vec3f(wallLum) * vec3f(1.26, 0.92, 0.54), w * 0.74) * 0.82;
    }
    if (!inRoom) {
      let vigDark = clamp(OL.u2.w, 0.0, 1.2);
      let dCenter = length((o.world.xz - vec2f(29.5, select(39.0, 30.5, OL.u5.w > 0.5))) * vec2f(0.052, 0.064));
      let periphShade = mix(1.0, clamp(1.18 - dCenter * 0.42, 0.46, 1.0), vigDark);
      let extCutDim = select(1.0, select(0.68, 0.92, o.world.x > 37.2 || o.world.z > 35.8), OL.u5.w > 0.5);
      col *= periphShade * extCutDim;
    } else {
      let roomLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
      col = mix(col, vec3f(roomLum) * vec3f(1.38, 0.82, 0.36), w * 0.68) * 0.54;
      // Warm amber kitchen sink window glow (north kitchen wall above sink at x=32.72..34.05, z=29.65..30.18, y=1.18..2.32)
      if (o.world.x > 32.72 && o.world.x < 34.05 && o.world.z > 29.65 && o.world.z < 30.18 && o.world.y > 1.18 && o.world.y < 2.32) {
        let paneX = abs(fract((o.world.x - 32.72) / 0.665) - 0.5);
        let paneY = abs(fract((o.world.y - 1.18) / 0.57) - 0.5);
        let muntin = smoothstep(0.04, 0.09, min(paneX, paneY));
        col = mix(vec3f(0.08, 0.045, 0.02), vec3f(0.58, 0.24, 0.045) * (0.78 + 0.22 * surfaceNoise(o.world.xy * 6.0)), muntin * nightLamps);
      } else if (o.world.x > 30.9 && o.world.x < 36.8 && o.world.z > 29.65 && o.world.z < 30.55 && o.world.y > 0.85) {
        // Subdue cream refrigerator & flanking upper kitchen cabinets into warm walnut-tan
        col *= vec3f(0.52, 0.40, 0.28);
      }
    }
    if (mat == 22) {
      // Subsurface leaf translucency & grazing rim shifted toward muted autumn olive-ochre
      let tipWeight = clamp(abs(o.aux), 0.0, 1.0);
      let keyDir = normalize(F.monitorBounds.xyz);
      let forwardScatter = pow(clamp(dot(-V, keyDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
      let backNormal = max(0.0, dot(-n, keyDir));
      let transLobe = (forwardScatter * 0.55 + backNormal * 0.45) * F.ambient.w * 0.28 * tipWeight;
      let chloroTint = mix(vec3f(0.20, 0.24, 0.10), vec3f(0.42, 0.36, 0.18), sqrt(tipWeight));
      let fresnelRim = pow(1.0 - max(dot(n, V), 0.0), 3.2) * 0.22 * tipWeight * F.ambient.w;
      col += o.color * (chloroTint * transLobe + vec3f(0.44, 0.38, 0.26) * fresnelRim);
      let folLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
      col = mix(col, vec3f(folLum) * vec3f(1.16, 0.98, 0.78), w * 0.64);
      if (o.world.y < 0.48) {
        let lawnPatch = surfaceNoise(o.world.xz * 0.46 + vec2f(1.9, 4.7));
        col *= mix(0.48, 1.02, smoothstep(0.26, 0.76, lawnPatch));
      }
    }
    col = mix(col, applySceneLightBounceAndHaze(o.world, n, col, o.color, inRoom, mat), nightLamps);
    // Darken cutaway wall-top molding (y = 2.73..2.83) so interior walls have a crisp dark charcoal cap
    if (o.world.y > 2.72 && o.world.y < 2.83 && n.y > 0.72) {
      col *= 0.08;
    }
    if (mat != 12) {
      let visible = eyeVisible(o.world.xz + n.xz * 0.06);
      let explored = textureSampleLevel(exploredTex, floorSamp, (o.world.xz + n.xz * 0.24) * F.map.xy, 0.0).r;
      if (mat == 2) {
        col *= .88;
        if (inRoom && o.world.y < 2.8) { col *= max(explored, visible); }
      } else {
        let luminance=dot(col,vec3f(.2126,.7152,.0722));
        let periphTint = mix(vec3f(.83,.94,1.05), vec3f(1.04,.96,.84), w);
        let peripheral=mix(vec3f(luminance)*periphTint,col,.76);
        if (inRoom && o.world.y < 2.8) {
          let room=mix(vec3f(luminance)*periphTint,col,.88+.12*visible);
          let reveal = max(explored, visible * 0.92);
          col=mix(o.color*.012, room * mix(F.effects.w, 1.0, .86), reveal);
        } else {
          col=mix(peripheral*(.88+.12*explored),col,.88+.12*visible);
        }
      }
    } else {
      let actorRim = pow(1.0 - max(dot(n, V), 0.0), 2.6) * OL.u2.z;
      let topCatch = max(0.0, n.y) * 0.45 * OL.u2.z;
      let rimCol = mix(vec3f(0.032, 0.048, 0.082), vec3f(0.058, 0.046, 0.032), w);
      col += rimCol * F.ambient.w * (actorRim + topCatch);
    }
    col += evalFlashlightBeam(o.world, n, o.color, inRoom, mat);
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
