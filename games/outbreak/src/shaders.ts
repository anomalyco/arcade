import { makeLookPostShader, makeLookSceneShader, makeSceneShader, spriteShader, postShader, type PostFinishOptions, type SceneHooks } from "@arcade/kit/gpu/shaders"
import { foliageWindDeclarationsWgsl } from "@arcade/kit/gpu/foliage"
import { BUILDING_RECTS } from "../shared/map"
import { outbreakFogOfWarDeclarationsWgsl, visibilityFieldShader } from "./fog-of-war"
import { groundSurfaceHookWgsl, outbreakSurfaceMaterialDeclarationsWgsl, outbreakSurfaceMaterialWgsl } from "./ground"
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
  bounce: "bounceAt(o.world.xz + n.xz * 0.3) * (0.58 * clamp(1.38 - F.monitorBounds.w * 1.38, 0.0, 1.0) * OL.u1.z)",
  lightLeak: "0.006 * vis",
  lightAttenuation: `let dn = max(d3, 0.85);
    let tight = max(0.5, OL.u0.w);
    var att = power * win * (0.025 + 2.25 / (1.0 + dn * dn * 0.62 * tight));
    if (L.cone.w > 1.5) {
      att = flashAttenuation(ldir, d3, power);
    } else if (L.cone.w > 0.5 && L.pos.w < 4.5 && L.extra.w > -0.5) {
      att = power * win * evalWindowAreaAttenuation(dv, dn, tight);
    } else if (L.extra.w > -0.5 && L.pos.w > 4.2 && L.cone.w < -0.5 && hl > 2.0) {
      let xFall = max(0.0, 1.0 - dv.x * dv.x * 0.16);
      att *= 0.88 + 0.78 * smoothstep(0.0, 3.4, dv.y) * xFall * xFall;
    }
    if (att <= 0.0035) { continue; }`,
  lightAccumulate: "if (L.cone.w > 1.5) { outbreakFlashIrr = att * diffuse * vis; }",
  wallDirectScale: "mix(0.18, 0.34, smoothstep(0.0, 1.5, o.world.y))",
  ambient: "outbreakSkyAmbient(n, F.ambient.rgb) * mix(0.03, 0.88, select(1.0, select(fd.g * 0.28, 0.03, abs(n.y) < 0.5), inRoom && o.world.y < 2.8)) + select(vec3f(0.0), vec3f(0.004, 0.0024, 0.0010), inRoom && o.world.y < 2.8)",
  diagnostics: "F.map.z",
  smoothShadows: true,
  shadowTaps: 5,
  lightMask: "if ((L.cone.w < -0.5 && (world.y > 2.75 || (world.z < 35.42 && OL.u5.w < 0.5))) || (L.cone.w > 0.5 && dot(dv, L.cone.xy) <= 0.0)) { continue; }",
  material: " ",
  postLightMaterial: `${outbreakSurfaceMaterialWgsl}
    let inRoom = interior(o.world.xz + n.xz * 0.28);
    let vTone = select(1.0, clamp(0.72 + (o.world.y - 0.04) * 1.4, 0.72, 1.0), o.world.y > 0.04 && o.world.y < 0.24 && abs(n.y) < 0.45)
      * select(1.0, 1.15, n.y > 0.35 && n.y < 0.88 && o.world.y > 0.35 && o.world.y < 2.45)
      * select(1.0, 0.68, n.y < -0.5 && o.world.y > 2.2);
    albedo *= vTone;
    outbreakAlbedo = albedo;
    outbreakPracticalIrr = max(0.0, dot(lit.diff, vec3f(0.2126, 0.7152, 0.0722)) - dot(OL.u5.rgb, vec3f(0.2126, 0.7152, 0.0722)) * outbreakFlashIrr) * GAIN;`,
  fragmentStart: "surfaceFootprint = max(length(dpdx(o.world)), length(dpdy(o.world))); surfaceTime = F.cam.w;",
  vertex: /* wgsl */ `
  if (v.matAux.x > 21.5 && v.matAux.x < 22.5) {
    let fw = applyFoliageVertexWind(o.world, o.normal, v.matAux.y, F.cam.w, F.cam.xyz, OL.veg, OL.vegActors);
    o.world = fw[0];
    o.normal = fw[1];
  }`,
  declarations: /* wgsl */ `
@group(0) @binding(9) var exploredTex: texture_2d<f32>;
@group(0) @binding(14) var visField: texture_2d<f32>;
${foliageWindDeclarationsWgsl}
${outbreakLightingDeclarationsWgsl}
${outbreakSurfaceMaterialDeclarationsWgsl}
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
${outbreakFogOfWarDeclarationsWgsl}`,
  directional: "mix(mix(vec3f(0.46, 0.68, 1.08), vec3f(0.95, 0.72, 0.46), clamp(OL.u0.z, 0.0, 1.0)), vec3f(1.0, 0.79, 0.53), F.monitorBounds.w) * select(select(fd.g * 0.42, 0.03, abs(n.y) < 0.5), 1.0, !inRoom || o.world.y > 2.8) * evalCanopyCookie(o.world, inRoom) * F.ambient.w * select(max(0.0, dot(n, F.monitorBounds.xyz)), max(0.0, (dot(n, F.monitorBounds.xyz) + 0.52) / 1.52), mat == 22)",
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
  outbreakFlashMask = 0.0;
  let nightLamps = clamp(1.38 - F.monitorBounds.w * 1.38, 0.0, 1.0);
  if (mat == 6) {
    // Clear window glass without milky white wash so rich warm amber interior & dark drapes read crisply.
    let outsideView = !interior(F.eye.xy);
    col = select(vec3f(0.012, 0.022, 0.045), vec3f(0.28, 0.145, 0.036) * nightLamps, outsideView);
  } else if (mat == 21) {
    // Weathered 3-tab slate-taupe roof shingles catching twilight sky, ridge rim, and granule lip sheen; eaves stay grounded.
    let eave = smoothstep(2.82, 3.62, o.world.y);
    let ridgeRim = smoothstep(4.18, 4.46, o.world.y) * max(0.0, n.y);
    let courseStep = smoothstep(0.62, 0.96, fract(o.world.z / 0.24));
    let w = clamp(OL.u0.z, 0.0, 1.0);
    let roofTint = mix(vec3f(0.018, 0.032, 0.068), vec3f(0.118, 0.145, 0.188), w);
    let extRoofScale = select(1.0, 0.46, OL.u5.w > 0.5);
    let roofGlint = (0.58 * eave + 0.36 * courseStep + 0.95 * ridgeRim + 2.15 * surfaceAlpha * (0.45 + 0.55 * eave)) * F.ambient.w * OL.u2.z * max(0.0, n.y);
    col = (col * mix(1.08, 1.66, eave) + roofTint * roofGlint) * extRoofScale;
  } else {
    let inRoom = interior(o.world.xz + n.xz * 0.28);
    let w = clamp(OL.u0.z, 0.0, 1.0);
    ${groundSurfaceHookWgsl}
    if (mat == 4 && !inRoom) {
      // Deep-but-not-crushed eave overhang shadow beneath main roof soffit, porch gable shadow, and foundation shrub occlusion.
      let eaveShadow = smoothstep(2.05, 2.74, o.world.y);
      let lowShadow = (1.0 - smoothstep(0.24, 0.86, o.world.y)) * 0.22;
      let underPorchGable = step(2.05, o.world.y) * step(abs(o.world.x - (select(21.0, 22.0, o.world.z < 45.0) + 5.7)), 1.62) * step(34.5, o.world.z);
      col *= mix(1.0, 0.52, clamp(eaveShadow + lowShadow + underPorchGable * 0.35, 0.0, 1.0));
      let wallLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
      col = mix(col, vec3f(wallLum) * vec3f(1.28, 0.96, 0.58), w * 0.74) * 0.96;
    } else if (mat == 0 && o.world.y > 0.14 && o.world.y < 2.65) {
      // Blog Game Tip #9: Local-space power-4 triplanar grain & wear on props, doors, and parked car
      col *= evalTriplanarPropMod(o.world, n);
    }
    if (!inRoom) {
      if (mat != 12) {
        let vigDark = clamp(OL.u2.w, 0.0, 1.2);
        let dCenter = length((o.world.xz - vec2f(29.5, select(39.0, 30.5, OL.u5.w > 0.5))) * vec2f(0.052, 0.064));
        let periphShade = mix(1.0, clamp(1.18 - dCenter * 0.42, 0.46, 1.0), vigDark);
        let extCutDim = select(1.0, select(0.68, 0.92, o.world.x > 37.2 || o.world.z > 35.8), OL.u5.w > 0.5);
        col *= periphShade * extCutDim;
      }
    } else if (mat != 12) {
      let roomLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
      col = mix(col, vec3f(roomLum) * vec3f(1.24, 0.92, 0.48), w * 0.58) * mix(0.84, 0.66, w);
      // Warm amber kitchen sink window pane glow (3D muntins are MAT.timber = 0, panes are MAT.lamp = 2)
      if (mat == 2 && o.world.x > 32.64 && o.world.x < 34.06 && o.world.z > 29.65 && o.world.z < 30.18 && o.world.y > 1.05 && o.world.y < 2.22) {
        col = vec3f(0.58, 0.24, 0.045) * (0.78 + 0.22 * surfaceNoise(o.world.xy * 6.0)) * nightLamps;
      }
    }
    if (mat == 22) {
      // Compress near-field window/porch point-light hotspots on foundation shrub crowns so leaves stay rich olive-gold instead of bleaching white
      col = col / (1.0 + max(vec3f(0.0), col - vec3f(0.10)) * 3.2);
      // Subsurface leaf translucency & grazing rim shifted toward muted autumn olive-ochre
      let tipWeight = foliageTipWeight(o.aux);
      let transK = foliageTranslucency(o.aux, OL.veg) / 0.3;
      let keyDir = normalize(F.monitorBounds.xyz);
      let forwardScatter = pow(clamp(dot(-V, keyDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
      let backNormal = max(0.0, dot(-n, keyDir));
      let transLobe = (forwardScatter * 0.55 + backNormal * 0.45) * F.ambient.w * 0.28 * tipWeight * transK;
      // Flashlight transmission: leaves and blades inside the beam glow warm olive (thin-lamina scatter, any facing).
      if (OL.u4.z > 0.001) {
        let fRel = o.world.xz - OL.u3.xy;
        let fAlong = dot(fRel, OL.u3.zw);
        let fAcross = abs(dot(fRel, vec2f(-OL.u3.w, OL.u3.z)));
        let fCone = 0.12 + max(0.0, fAlong) * max(0.12, OL.u4.x);
        let fRange = max(2.8, OL.u4.y);
        let inBeam = smoothstep(-0.05, 0.3, fAlong) * (1.0 - smoothstep(fCone * 0.7, fCone * 1.25, fAcross)) * pow(clamp(1.0 - fAlong / fRange, 0.0, 1.0), 1.3) * (1.0 - smoothstep(1.4, 2.4, o.world.y));
        let facing = max(0.0, dot(-n.xz, OL.u3.zw)) * 0.5 + 0.5;
        col += o.color * OL.u5.rgb * vec3f(1.05, 1.3, 0.5) * inBeam * facing * OL.u4.z * (0.10 + 0.22 * tipWeight) * transK;
      }
      let chloroTint = mix(vec3f(0.20, 0.24, 0.10), vec3f(0.42, 0.36, 0.18), sqrt(tipWeight));
      let fresnelRim = pow(1.0 - max(dot(n, V), 0.0), 3.2) * 0.20 * tipWeight * F.ambient.w;
      col += o.color * (chloroTint * transLobe + vec3f(0.40, 0.36, 0.22) * fresnelRim);
      // Moonlit crown tops: upward-facing outer leaves keep a cool sheen at night so canopies read as rounded masses.
      let crownSheen = pow(max(n.y, 0.0), 2.0) * (0.35 + 0.65 * tipWeight) * smoothstep(0.5, 1.6, o.world.y);
      col += o.color * vec3f(0.50, 0.62, 0.90) * OL.u0.y * 0.32 * crownSheen * clamp(1.0 - F.monitorBounds.w * 1.4, 0.0, 1.0);
      let folLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
      col = mix(col, vec3f(folLum) * vec3f(1.16, 1.02, 0.64), w * 0.38);
      if (o.world.y < 0.48) {
        let lawnPatch = surfaceNoise(o.world.xz * 0.46 + vec2f(1.9, 4.7));
        col *= mix(0.56, 1.06, smoothstep(0.26, 0.76, lawnPatch));
      }
    }
    col = mix(col, applySceneLightBounceAndHaze(o.world, n, col, o.color, inRoom, mat), nightLamps);
    if (mat != 12) { col *= evalActorGroundShadow(o.world, n, inRoom); }
    // Darken cutaway wall-top molding (y = 2.73..2.83) so interior walls have a crisp dark charcoal cap
    if (o.world.y > 2.72 && o.world.y < 2.83 && n.y > 0.72) {
      col *= 0.08;
    }
    let beamAdd = evalFlashlight(o.world, n);
    let flashIrr = outbreakFlashMask;
    outbreakSeen = 1.0;
    if (mat != 12) {
      col = applyOutbreakFogOfWar(col, o.world, n, o.color, inRoom, mat, w);
    } else {
      // Actors in LOS: Limbo/Noir top-down contour rim + anatomical form shading so zombies stay clearly readable even in dark areas
      let isLiveActor = o.extra.z >= 0.92;
      let inBeam = outbreakColorMask(flashIrr);
      let darkLosScale = select(0.42, 1.0 - 0.72 * inBeam, isLiveActor);
      let v1 = 1.0 - max(dot(n, V), 0.0);
      let viewRim = v1 * v1;
      let c1 = clamp(length(n.xz), 0.0, 1.0);
      let contourRim = c1 * c1 * smoothstep(0.22, 1.62, o.world.y);
      let actorRim = max(viewRim, contourRim * 0.85) * max(OL.u2.z, 1.0);
      let topCatch = max(0.0, n.y) * 0.45 * max(OL.u2.z, 1.0) * smoothstep(0.65, 1.68, o.world.y);
      let heightGrad = smoothstep(0.08, 1.62, o.world.y);
      let formShade = (0.36 + 0.64 * clamp(n.y * 0.55 + 0.45, 0.0, 1.0)) * (0.42 + 0.58 * heightGrad);
      let rimCol = mix(vec3f(0.072, 0.088, 0.112), vec3f(0.065, 0.052, 0.038), w);
      let darkReadFloor = o.color * formShade * mix(vec3f(0.22, 0.25, 0.30), vec3f(0.18, 0.15, 0.12), w) * darkLosScale;
      col = max(col, darkReadFloor) + rimCol * max(F.ambient.w, 0.75) * (actorRim + topCatch) * darkLosScale;
    }
    col += beamAdd * outbreakSeen;
    outbreakFlashMask = select(outbreakColorMask(flashIrr), 0.8, mat == 2) * outbreakSeen;
  }
  if (mat == 6) { outbreakFlashMask = 0.55; }
  if (mat != 6) { col += evalLampAir(o.world, OL.u5.w > 0.5); }
  if (i32(round(F.map.z)) == 8) {
    let fieldDiag = fieldSight(o.world, n);
    col = vec3f(fieldDiag.x, fieldDiag.y * 0.35, select(0.0, 0.25, mat == 12));
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
  visField: visibilityFieldShader,
}
