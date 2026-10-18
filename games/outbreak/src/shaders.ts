import {
  makeLookPostShader,
  makeLookSceneShader,
  makeSceneShader,
  spriteShader,
  postShader,
  type LookVariantMode,
  type PostFinishOptions,
  type SceneHooks,
} from "@arcade/kit/gpu/shaders"
import { foliageWindDeclarationsWgsl } from "@arcade/kit/gpu/foliage"
import { BUILDING_RECTS } from "../shared/map"
import { flashlightVolumeShader } from "./flashlight-beam"
import { outbreakFogOfWarDeclarationsWgsl, visibilityFieldShader } from "./fog-of-war"
import { groundSurfaceHookWgsl, outbreakSurfaceMaterialDeclarationsWgsl, outbreakSurfaceMaterialWgsl } from "./ground"
import { outbreakLightingDeclarationsWgsl } from "./lighting"
import { outbreakBeanFragmentStartWgsl, outbreakHeroWgsl } from "./look/shader"
import { outbreakUnseenPostHookWgsl, outbreakUnseenPostWgsl } from "./unseen"
import { interiorDeclarationsWgsl, interiorFragmentStartWgsl, interiorMaterialWgsl, outbreakInteriorRefs } from "./interiors/wgsl"

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
  customDeclarations: outbreakUnseenPostWgsl,
  customPostHook: outbreakUnseenPostHookWgsl,
}

export const outbreakSceneHooks: SceneHooks = {
  ao: "0.42",
  mapUv: "(p - OL.win.xy) * F.map.xy",
  bounce: "outbreakBounce(o.world.xz + n.xz * 0.3, 0.58 * clamp(1.38 - F.monitorBounds.w * 1.38, 0.0, 1.0) * OL.u1.z * select(1.0, OL.colour.w, outbreakInRoom) * select(1.0, 0.0, o.world.y > 2.78))",
  lightLeak: "0.006 * vis",
  lightAttenuation: `var att = 0.0;
    if (L.cone.w > 1.5) {
      att = flashAttenuation(ldir, d3, power);
      if (att <= 0.02) { continue; }
    } else if (L.cone.w > 1.125) {
      // Sconce pair (one light, bulbs extra.w either side along the wall): a tight wash on their own wall (walls take
      // direct light at about a third of floors, so give that back) and a soft pool on the floor below. Only surfaces
      // behind the bulbs (the wall they hang on) get the wash, so cabinets standing out from the wall don't flare.
      if (OL.rampOn.y > 0.5) { win = outbreakRamp(1u, sqrt(dPlan2) / r); }
      let onWall = abs(n.y) < 0.5 && dot(dv, L.cone.xy) < 0.0;
      let side = abs(L.cone.yx) * L.extra.w;
      let e1 = dot(dv - side, dv - side) + dy * dy;
      let e2 = dot(dv + side, dv + side) + dy * dy;
      var bulbs = 0.5 / (0.15 + e1 * 0.7) + 0.5 / (0.15 + e2 * 0.7);
      if (onWall) { bulbs += 0.225 / (0.02 + e1 * 5.0) + 0.225 / (0.02 + e2 * 5.0); }
      att = power * win * (0.04 + bulbs) * select(1.0, 3.0, onWall);
      if (att <= 0.0035) { continue; }
    } else {
      let dn = max(d3, 0.85);
      let tight = max(0.5, OL.u0.w);
      if (OL.rampOn.y > 0.5) { win = outbreakRamp(1u, sqrt(dPlan2) / r); }
      if (L.cone.w > 0.5 && L.cone.w < 1.125 && L.pos.w < 4.5 && L.extra.w > -0.5) {
        att = power * win * evalWindowAreaAttenuation(dv, dn, tight);
      } else {
        att = power * win * (0.025 + 2.25 / (1.0 + dn * dn * 0.62 * tight));
        if (L.extra.w > -0.5 && L.pos.w > 4.2 && L.cone.w < -0.5 && hl > 2.0) {
          let xFall = max(0.0, 1.0 - dv.x * dv.x * 0.16);
          att *= 0.88 + 0.78 * smoothstep(0.0, 3.4, dv.y) * xFall * xFall;
        }
      }
      if (att <= 0.0035) { continue; }
    }`,
  lightAccumulate: "if (L.cone.w > 1.5) { outbreakFlashIrr = att * diffuse * vis; }",
  // Soft Bean (outbreakWrap = its wrap + 1) takes its own light wrap; everything else keeps the shared one.
  diffuseTerm: "let wrapK = select(wrap, outbreakWrap - 1.0, outbreakWrap > 0.5); let diffuse = max((ndl + wrapK) / (1.0 + wrapK), 0.0);",
  wallDirectScale: "mix(0.18, 0.34, smoothstep(0.0, 1.5, o.world.y))",
  ambient: "outbreakSkyAmbient(n, F.ambient.rgb) * mix(0.03, 0.88, select(1.0, select(fd.g * 0.28, 0.03, abs(n.y) < 0.5), inRoom && o.world.y < 2.8)) + select(vec3f(0.0), select(vec3f(0.004, 0.0024, 0.0010), vec3f(0.0004, 0.0007, 0.0014), OL.round.x > 0.5 || OL.round.z > 0.5), inRoom && o.world.y < 2.8)",
  diagnostics: "F.map.z",
  smoothShadows: true,
  shadowTaps: 5,
  // Sconces (cone.w 1.25, interiors/sconces.ts): cut just behind their wall, above the wall tops, and to their room along the wall.
  // Table lamps (cone.w -3, table-lamps.ts): cut to the room rect in cone.xyz / extra.x and below the wall tops.
  lightMask: `if (L.cone.w < -2.5) {
      if (world.y > 2.75 || world.x < L.cone.x - 0.03 || world.x > L.cone.z + 0.03 || world.z < L.cone.y - 0.03 || world.z > L.extra.x + 0.03) { continue; }
    } else if (L.cone.w > 1.125 && L.cone.w < 1.5) {
      let along = dot(dv, abs(L.cone.yx));
      if (world.y > 2.75 || dot(dv, L.cone.xy) < -L.extra.x || along < L.extra.y + 1.0 || along > -1.25 - L.cone.z) { continue; }
    } else if ((L.cone.w < -0.5 && (world.y > 2.75 || (world.z < 35.42 && OL.u5.w < 0.5))) || (L.cone.w > 0.5 && dot(dv, L.cone.xy) <= 0.0)) { continue; }`,
  material: " ",
  postLightMaterial: `${outbreakSurfaceMaterialWgsl}
    ${interiorMaterialWgsl(outbreakInteriorRefs, true)}
    let inRoom = interior(o.world.xz + select(vec2f(0.0), n.xz * 0.28, mat == 4));
    outbreakInRoom = inRoom;
    let isPropTone = mat == 0 || mat == 10 || mat == 24;
    let vTone = select(1.0, clamp(0.72 + (o.world.y - 0.04) * 1.4, 0.72, 1.0), !isPropTone && o.world.y > 0.04 && o.world.y < 0.24 && abs(n.y) < 0.45)
      * select(1.0, 1.15, !isPropTone && n.y > 0.35 && n.y < 0.88 && o.world.y > 0.35 && o.world.y < 2.45)
      * select(1.0, 0.68, n.y < -0.5 && o.world.y > 2.2);
    albedo *= vTone;
    outbreakAlbedo = albedo;
    outbreakPracticalIrr = max(0.0, dot(lit.diff, vec3f(0.2126, 0.7152, 0.0722)) - dot(OL.u5.rgb, vec3f(0.2126, 0.7152, 0.0722)) * outbreakFlashIrr) * GAIN;`,
  fragmentStart: `let dWorldX = dpdx(o.world); let dWorldY = dpdy(o.world); surfaceFootprint = sqrt(max(dot(dWorldX, dWorldX), dot(dWorldY, dWorldY))); surfaceTime = F.cam.w; ${outbreakBeanFragmentStartWgsl} ${interiorFragmentStartWgsl}`,
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
/** Streamed window building slot i (0..7) has the L-plan bungalow footprint (u17.w bits 0..7). */
fn slotLPlan(i: i32) -> bool { return ((u32(OL.u17.w) >> u32(i)) & 1u) == 1u; }
/** Whether the rect last returned by houseRect is an L-plan bungalow (cut and lit by wing, not by rect). */
var<private> houseIsL: bool;
fn houseRect(id: i32) -> vec4f {
  houseIsL = false;
  if (OL.win.z > 0.5) {
    if (id >= 0 && id <= 7) {
      let b0 = OL.bldRects[id];
      if (all(F.eye.xy > b0.xy - 0.15) && all(F.eye.xy < b0.zw + 0.15)) { houseIsL = slotLPlan(id); return b0; }
    }
    let nBld = i32(OL.win.w);
    for (var i = 0; i < 8; i++) {
      if (i >= nBld) { break; }
      let bi = OL.bldRects[i];
      if (all(F.eye.xy > bi.xy - 0.15) && all(F.eye.xy < bi.zw + 0.15)) { houseIsL = slotLPlan(i); return bi; }
    }
    if (id > 7) { return vec4f(-99999.0, -99999.0, -99998.0, -99998.0); }
    houseIsL = slotLPlan(clamp(id, 0, 7));
    return OL.bldRects[clamp(id, 0, 7)];
  }
  houseIsL = id == 0 || id == 1;
  switch id {
    ${BUILDING_RECTS.map((b,i)=>`${i===3?"default":`case ${i}`}: {return vec4f(${b.map(v=>v.toFixed(2)).join(",")});}`).join("\n")}
  }
}
fn interior(p:vec2f) -> bool {
  if (OL.win.z > 0.5) {
    let nBld = i32(OL.win.w);
    for (var i = 0; i < 8; i++) {
      if (i >= nBld) { break; }
      let b = OL.bldRects[i];
      if (slotLPlan(i)) {
        if (p.x > b.x + 0.22 && p.x < b.z - 0.22 && p.y > b.y + 5.70 && p.y < b.w - 0.22) { return true; }
        if (p.x > b.x + 2.22 && p.x < b.x + 9.28 && p.y > b.y + 0.22 && p.y < b.y + 5.72) { return true; }
        if (p.x > b.x + 9.25 && p.x < b.z - 0.22 && p.y > b.y + 1.72 && p.y < b.y + 5.72) { return true; }
      } else if (p.x > b.x + 0.22 && p.x < b.z - 0.22 && p.y > b.y + 0.22 && p.y < b.w - 0.22) { return true; }
    }
    return false;
  }
  let b = select(
    select(vec4f(53.22, 54.22, 71.78, 67.78), vec4f(53.22, 23.22, 72.78, 37.78), p.y < 45.0),
    select(vec4f(21.0, 54.0, 36.0, 65.5), vec4f(22.0, 24.0, 37.0, 35.5), p.y < 45.0),
    p.x < 45.0
  );
  let south = p.x > b.x + 0.22 && p.x < b.z - 0.22 && p.y > b.y + 5.70 && p.y < b.w - 0.22;
  let north = p.x > b.x + 2.22 && p.x < b.x + 9.28 && p.y > b.y + 0.22 && p.y < b.y + 5.72;
  let wing = p.x > b.x + 9.25 && p.x < b.z - 0.22 && p.y > b.y + 1.72 && p.y < b.y + 5.72;
  return select(all(p > b.xy) && all(p < b.zw), south || north || wing, p.x < 45.0);
}
fn roofCut(p:vec3f, id:i32, frag:vec4f) -> bool {
  let b=houseRect(id);
  if (F.eye.z <= 1.0001) {
    if (F.eye.x < b.x - 0.1 || F.eye.x > b.z + 0.1 || F.eye.y < b.y - 0.1 || F.eye.y > b.w + 0.1) { return false; }
    if (houseIsL) {
      // The L-shaped bungalow: south block, north-west hall and north-east wing (map.ts buildingFootprint).
      let eyeIn = F.eye.y > b.y + 5.4 || (F.eye.x > b.x + 1.9 && F.eye.x < b.x + 9.6) || (F.eye.x > b.x + 9.4 && F.eye.y > b.y + 1.4);
      if (!eyeIn) { return false; }
      let south = p.x > b.x + 0.35 && p.x < b.z - 0.35 && p.z > b.y + 5.65 && p.z < b.w + 1.65;
      let north = p.x > b.x + 2.25 && p.x < b.x + 9.25 && p.z > b.y + 0.35 && p.z < b.y + 5.85;
      let wing = p.x > b.x + 9.25 && p.x < b.z - 0.35 && p.z > b.y + 1.85 && p.z < b.y + 5.85;
      return south || north || wing;
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
${outbreakFogOfWarDeclarationsWgsl}
${interiorDeclarationsWgsl(outbreakInteriorRefs)}
${outbreakHeroWgsl}`,
  directional: "mix(select(mix(vec3f(0.46, 0.68, 1.08), vec3f(0.95, 0.72, 0.46), clamp(OL.u0.z, 0.0, 1.0)), select(vec3f(0.42, 0.68, 1.18), select(vec3f(0.54, 0.84, 1.48), vec3f(0.42, 0.50, 0.62), OL.round.x > 4.5 || OL.round.z > 4.5), OL.round.x > 3.5 || OL.round.z > 3.5), OL.round.x > 0.5 || OL.round.z > 0.5), select(vec3f(1.02, 0.79, 0.52), vec3f(1.52, 1.24, 0.88), OL.round.x > 3.5 || OL.round.z > 3.5), F.monitorBounds.w) * select(select(fd.g * 0.42, 0.03, abs(n.y) < 0.5), 1.0, !inRoom || o.world.y > 2.8) * evalCanopyCookie(o.world, inRoom) * F.ambient.w * select(max(0.0, dot(n, F.monitorBounds.xyz)), max(0.0, (dot(n, F.monitorBounds.xyz) + 0.52) / 1.52), mat == 22)",
  cutaway: `
      if (OL.u17.z > 0.001 && OL.u17.z < 0.999 && bayer4x4(o.pos) > OL.u17.z) { discard; }
      if ((i32(round(o.mat)) == 21 || o.world.y > 2.801) && roofCut(o.world, i32(round(o.aux)), o.pos)) { discard; }
      if (o.world.y > 2.8 && interior(o.world.xz)) {
        let nCut = select(4, i32(OL.win.w), OL.win.z > 0.5);
        for(var i=0;i<nCut;i++) { if(roofCut(o.world,i,o.pos)){discard;} }
      }
      if (F.eye.z > 1.0001 && o.world.y > 0.88 && (mat == 4 || mat == 9 || mat == 2 || mat == 6)) {
        let alpha = clamp(F.eye.z - 1.0, 0.0, 1.0);
        let wr = length(o.world.xz - F.eye.xy) / (3.4 * alpha + 0.001);
        if (wr < 1.0 && bayer4x4(o.pos) < smoothstep(1.0, 0.45, wr) * alpha * 0.92) { discard; }
      }
    `,
  // High/roof triangles are always routed through fs; low opaque triangles cannot hit these discards.
  solidCutaway: "",
  surface: buildOutbreakSurfaceWgsl(true),
  lookSurface: buildOutbreakSurfaceWgsl(false),
  lookBaseColor: "select(o.color, outbreakAlbedo, mat == 25)",
}

function buildOutbreakSurfaceWgsl(includeLampAirAndActorShadow: boolean): string {
  return /* wgsl */ `
  outbreakFlashMask = 0.0;
  outbreakUnseenAlpha = 0.0;
  let nightLamps = clamp(1.38 - F.monitorBounds.w * 1.38, 0.0, 1.0);
  if (mat == 6) {
    // Clear window glass without milky white wash so rich warm amber interior & dark drapes read crisply.
    let outsideView = OL.u5.w < 0.5;
    col = select(vec3f(0.012, 0.022, 0.045), vec3f(0.28, 0.145, 0.036) * nightLamps, outsideView);
  } else if (mat == 21) {
    // Weathered 3-tab slate-taupe roof shingles catching twilight sky, ridge rim, and granule lip sheen; eaves stay grounded.
    let isOverhaul = OL.round.x > 0.5 || OL.round.z > 0.5;
    let isV5Roof = (OL.round.x > 3.5 && OL.round.x < 4.5) || (OL.round.z > 3.5 && OL.round.z < 4.5);
    let isV6Roof = OL.round.x > 4.5 || OL.round.z > 4.5;
    let isV5OrV6Roof = isV5Roof || isV6Roof;
    let sun = clamp(F.monitorBounds.w, 0.0, 1.0);
    let duskGlow = select(0.0, smoothstep(0.42, 0.22, F.monitorBounds.y) * (1.0 - smoothstep(0.25, 0.75, sun)), isV5OrV6Roof);
    let eave = smoothstep(2.82, 3.62, o.world.y);
    let ridgeRim = smoothstep(4.18, 4.46, o.world.y) * max(0.0, n.y);
    let courseStep = smoothstep(0.62, 0.96, fract(o.world.z / 0.24));
    let w = clamp(OL.u0.z, 0.0, 1.0);
    let roofTint = select(
      mix(vec3f(0.018, 0.032, 0.068), vec3f(0.118, 0.145, 0.188), w),
      mix(
        select(vec3f(0.014, 0.026, 0.056), select(vec3f(0.030, 0.056, 0.124), vec3f(0.020, 0.025, 0.034), isV6Roof), isV5OrV6Roof),
        select(vec3f(0.062, 0.072, 0.088), vec3f(0.115, 0.125, 0.142), isV5OrV6Roof),
        sun,
      ),
      isOverhaul,
    );
    let extRoofScale = select(1.0, 0.46, OL.u5.w > 0.5) * select(1.0, mix(select(0.62, select(0.78, 0.64, isV6Roof), isV5OrV6Roof), select(0.84, 1.24, isV5OrV6Roof), sun), isOverhaul);
    let roofGlint = (0.58 * eave + 0.36 * courseStep + 0.95 * ridgeRim + 2.15 * surfaceAlpha * (0.45 + 0.55 * eave)) * F.ambient.w * OL.u2.z * max(0.0, n.y) * select(1.0, select(0.48, select(0.84, 0.62, isV6Roof), isV5OrV6Roof), isOverhaul);
    col = (col * mix(select(1.08, select(0.80, select(0.94, 0.82, isV6Roof), isV5OrV6Roof), isOverhaul), select(1.66, select(1.20, select(1.54, 1.28, isV6Roof), isV5OrV6Roof), isOverhaul), eave) + roofTint * roofGlint) * extRoofScale;
    let westRoof = smoothstep(36.2, 21.8, o.world.x) * (0.32 + 0.68 * eave);
    let sunsetCopper = (col * 1.8 + vec3f(0.18, 0.062, 0.014)) * vec3f(1.48, 0.52, 0.12) * (0.75 + 0.25 * courseStep);
    let twilightIndigo = col * vec3f(0.75, 0.95, 1.65) + vec3f(0.014, 0.026, 0.078) * eave;
    col = mix(col, mix(twilightIndigo, sunsetCopper, westRoof), duskGlow * 0.92);
    var roofSight = 1.0;
    if (OL.unseen.mode >= 0.5 && OL.unseen.strength > 0.001) {
      let rSight = fieldSight3(o.world, n);
      roofSight = rSight.x;
      let rExp = max(textureSampleLevel(exploredTex, floorSamp, (o.world.xz - OL.win.xy) * F.map.xy, 0.0).r, rSight.y);
      let rDim = select(0.55, select(0.42, clamp(0.48 - 0.14 * clamp(OL.shroud.z, 0.0, 2.0), 0.22, 0.72), isV6Roof), isOverhaul);
      col = applyOutbreakUnseenScene(col, col * rDim, o.world, n, false, mat, select(rSight.x, 1.0, isV5Roof), rExp, rSight.z);
      let rShroudScale = select(1.0, clamp(0.88 * OL.shroud.x, 0.0, 1.8), isV6Roof);
      outbreakFlashMask = -outbreakUnseenAlpha * rShroudScale;
    }
    if (isV5Roof) {
      outbreakFlashMask = max(outbreakFlashMask, max(sun * 0.85, max(duskGlow * 0.88, 0.36)));
    } else if (isV6Roof) {
      let roofDayMask = max(sun * roofSight * 0.85, duskGlow * roofSight * 0.88);
      outbreakFlashMask = select(outbreakFlashMask, roofDayMask, roofDayMask > 0.12);
    }
  } else {
    let inRoom = outbreakInRoom;
    let w = clamp(OL.u0.z, 0.0, 1.0);
    let satStyle = i32(round(OL.round.x));
    let modStyle = i32(round(OL.round.y));
    let gradeStyle = i32(round(OL.round.z));
    let isV5 = satStyle == 4 || gradeStyle == 4;
    let isV6 = satStyle == 5 || gradeStyle == 5;
    let isV5OrV6 = isV5 || isV6;
    let shroudDark = clamp(OL.shroud.x, 0.0, 2.0);
    let unlitDesat = clamp(OL.shroud.y, 0.0, 1.5);
    let sightDark = clamp(OL.shroud.z, 0.0, 2.0);
    let sunVal = clamp(F.monitorBounds.w, 0.0, 1.0);
    let duskGlow = select(0.0, smoothstep(0.42, 0.22, F.monitorBounds.y) * (1.0 - smoothstep(0.25, 0.75, sunVal)), isV5OrV6);
    ${groundSurfaceHookWgsl}
    if (mat == 4 && !inRoom) {
      // Deep-but-not-crushed eave overhang shadow beneath main roof soffit, porch gable shadow, and foundation shrub occlusion.
      let eaveShadow = smoothstep(2.05, 2.74, o.world.y);
      let lowShadow = (1.0 - smoothstep(0.24, 0.86, o.world.y)) * 0.22;
      let underPorchGable = step(2.05, o.world.y) * step(abs(o.world.x - (select(21.0, 22.0, o.world.z < 45.0) + 5.7)), 1.62) * step(34.5, o.world.z);
      col *= mix(1.0, 0.48, clamp(eaveShadow + lowShadow + underPorchGable * 0.35, 0.0, 1.0));
      let wallLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
      col = mix(col, vec3f(wallLum) * vec3f(1.28, 0.96, 0.58), w * select(0.74, 0.10, satStyle > 0)) * select(0.96, select(0.92, mix(0.96, 1.18, sunVal), isV5OrV6), satStyle > 0);
      if (satStyle > 0) {
        let wallKnee = select(0.14, mix(0.16, 0.42, sunVal), isV5OrV6);
        col = col / (1.0 + max(vec3f(0.0), col - vec3f(wallKnee)) * select(2.2, mix(1.8, 0.85, sunVal), isV5OrV6));
      }
    } else if ((mat == 0 || mat == 3 || mat == 10) && o.world.y > 0.03 && o.world.y < 2.68) {
      // Blog Game Tip #9: Local-space power-4 triplanar grain & wear on props, doors, and parked car
      if ((mat == 0 || mat == 10) && o.world.y > 0.14 && o.world.y < 2.65) {
        let grainMod = evalTriplanarPropMod(o.world, n);
        col *= select(grainMod, 1.0 + (grainMod - 1.0) * select(1.15, 1.65, modStyle == 3), modStyle > 0);
      }
      if (modStyle > 0) {
        // Model shading candidates: vertical floor-contact grounding, low-plastic satin bevel catch, and silhouette rim relief
        let propGround = mix(select(0.66, 0.56, modStyle == 3), 1.0, smoothstep(0.03, 0.44, o.world.y));
        col *= propGround;
        let Vp = normalize(F.cam.xyz - o.world);
        let contourP = clamp(length(n.xz), 0.0, 1.0);
        let specAa = 1.0 / (1.0 + surfaceFootprint * 24.0);
        if (modStyle == 1 || modStyle == 2 || modStyle == 4) {
          let hTop = normalize(Vp + vec3f(0.15, 0.96, 0.22));
          let satinExp = select(10.0, 22.0, mat == 3) * (0.45 + 0.55 * specAa);
          let satinAmp = select(0.032, 0.14, mat == 3) * select(1.0, select(1.35, 1.22, modStyle == 4), modStyle >= 2) * specAa;
          let satinSpec = pow(max(0.0, dot(n, hTop)), satinExp) * satinAmp;
          let bevelCatch = smoothstep(0.22, 0.86, n.y) * contourP * smoothstep(0.18, 1.35, o.world.y) * select(0.14, select(0.30, 0.22, modStyle == 4), modStyle >= 2) * (0.35 + 0.65 * specAa);
          col = col * (1.0 + bevelCatch) + (outbreakAlbedo * 0.72 + vec3f(0.02)) * satinSpec * max(F.ambient.w, 0.45);
        }
        if (modStyle == 2 || modStyle == 4) {
          let rimF = 1.0 - max(dot(n, Vp), 0.0);
          let silRim = (rimF * rimF) * (0.4 + 0.6 * contourP) * smoothstep(0.18, 1.35, o.world.y) * (0.35 + 0.65 * specAa);
          let rimTone = mix(vec3f(0.042, 0.058, 0.092), vec3f(0.090, 0.064, 0.034), clamp(outbreakPracticalIrr * 2.2, 0.0, 1.0));
          col += (outbreakAlbedo * 0.45 + rimTone) * silRim * select(0.65, 0.48, modStyle == 4);
        }
        let carSun = clamp(dot(n, vec3f(-0.82, 0.55, -0.36)) * 0.6 + 0.4, 0.0, 1.0) * smoothstep(0.25, 1.15, o.world.y) * select(0.0, duskGlow, !inRoom && mat == 3);
        col += (outbreakAlbedo * 0.95 + vec3f(0.14, 0.055, 0.012)) * vec3f(1.35, 0.48, 0.10) * carSun * 0.78;
      }
    }
    if (!inRoom) {
      if (mat != 12) {
        let dayVig = select(0.0, select(0.68, select(0.12, 0.22 * clamp(0.5 + 0.5 * shroudDark, 0.0, 1.6), isV6), isV5OrV6) * sunVal, gradeStyle > 0);
        let vigScale = select(1.0, select(0.68, 0.92 * clamp(0.4 + 0.6 * shroudDark, 0.0, 1.6), isV6), isV5OrV6);
        let vigDark = max(clamp(OL.u2.w * vigScale, 0.0, 1.2), dayVig);
        let centerRef = select(vec2f(29.5, select(39.0, 30.5, OL.u5.w > 0.5)), F.eye.xy, OL.win.z > 0.5);
        let dCenter = length((o.world.xz - centerRef) * vec2f(0.052, 0.064));
        let v6PeriphFloor = clamp(0.34 - 0.10 * (shroudDark - 1.0), 0.16, 0.56);
        let periphFloor = select(0.46, select(0.28, select(0.56, v6PeriphFloor, isV6), isV5OrV6), gradeStyle > 0);
        let periphSlope = select(0.42, select(0.48, select(0.36, 0.44, isV6), isV5OrV6), gradeStyle > 0);
        let periphShade = mix(1.0, clamp(1.16 - dCenter * periphSlope, periphFloor, 1.0), vigDark);
        let extCutDim = select(1.0, select(0.54, 0.82, o.world.x > 37.2 || o.world.z > 35.8), OL.u5.w > 0.5);
        col *= periphShade * extCutDim;
        let westSweep = smoothstep(35.0, 20.5, o.world.x - (o.world.z - 38.0) * 0.32);
        let duskTint = mix(vec3f(0.76, 0.92, 1.48), vec3f(1.36, 0.78, 0.42), westSweep);
        let duskAdd = mix(vec3f(0.004, 0.008, 0.024), vec3f(0.022, 0.008, 0.002), westSweep) * select(1.0, 0.45, mat == 20 && o.world.z > 39.8 && o.world.z < 48.2);
        col = mix(col, col * duskTint + duskAdd, select(0.0, duskGlow * 0.72, mat != 2));
      }
    } else if (mat != 12) {
      let roomLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
      // Remove the 51% interior sepia pre-wash when satStyle > 0 (keep only optional slight warmth on satStyle == 3)
      let roomWash = select(w * 0.58, select(0.0, w * 0.16, satStyle == 3), satStyle > 0);
      let roomDim = select(mix(0.84, 0.66, w), select(mix(0.94, 0.86, w), 1.04, isV5OrV6), satStyle > 0);
      col = mix(col, vec3f(roomLum) * vec3f(1.24, 0.92, 0.48), roomWash) * roomDim;
      // Warm amber kitchen sink window pane glow (3D muntins are MAT.timber = 0, panes are MAT.lamp = 2)
      if (mat == 2 && o.world.x > 32.64 && o.world.x < 34.06 && o.world.z > 29.65 && o.world.z < 30.18 && o.world.y > 1.05 && o.world.y < 2.22) {
        col = vec3f(0.58, 0.24, 0.045) * (0.78 + 0.22 * surfaceNoise(o.world.xy * 6.0)) * nightLamps;
      }
    }
    if (mat == 22) {
      let V = normalize(F.cam.xyz - o.world);
      let isOverhaulFol = satStyle > 0 || gradeStyle > 0;
      let sunFactor = clamp(F.monitorBounds.w * 1.2 + 0.10, 0.10, 1.0);
      // Compress near-field window/porch point-light hotspots on foundation shrub crowns so leaves stay rich olive-gold instead of bleaching white
      let folKnee = select(0.10, mix(0.12, 0.36, sunVal), isV5OrV6);
      col = col / (1.0 + max(vec3f(0.0), col - vec3f(folKnee)) * select(3.2, mix(2.6, 0.9, sunVal), isV5OrV6));
      // Subsurface leaf translucency & grazing rim shifted toward muted autumn olive-ochre
      let tipWeight = foliageTipWeight(o.aux);
      let transK = foliageTranslucency(o.aux, OL.veg) / 0.3;
      let keyDir = F.monitorBounds.xyz;
      let fs0 = clamp(dot(-V, keyDir) * 0.5 + 0.5, 0.0, 1.0);
      let forwardScatter = fs0 * fs0 * fs0;
      let backNormal = max(0.0, dot(-n, keyDir));
      let transLobe = (forwardScatter * 0.55 + backNormal * 0.45) * F.ambient.w * 0.28 * tipWeight * transK * select(1.0, sunFactor, isOverhaulFol);
      // Flashlight transmission: leaves and blades inside the beam glow warm olive (thin-lamina scatter, any facing).
      if (OL.u4.z > 0.001 && o.world.y < 2.4) {
        let fRel = o.world.xz - OL.u3.xy;
        let fAlong = dot(fRel, OL.u3.zw);
        let fRange = max(2.8, OL.u4.y);
        if (fAlong > -0.05 && fAlong < fRange) {
          let fAcross = abs(dot(fRel, vec2f(-OL.u3.w, OL.u3.z)));
          let fCone = 0.12 + max(0.0, fAlong) * max(0.12, OL.u4.x);
          if (fAcross < fCone * 1.25) {
            let axT = clamp(1.0 - fAlong / fRange, 0.0, 1.0);
            let inBeam = smoothstep(-0.05, 0.3, fAlong) * (1.0 - smoothstep(fCone * 0.7, fCone * 1.25, fAcross)) * (axT * sqrt(axT)) * (1.0 - smoothstep(1.4, 2.4, o.world.y));
            let facing = max(0.0, dot(-n.xz, OL.u3.zw)) * 0.5 + 0.5;
            col += outbreakAlbedo * OL.u5.rgb * vec3f(1.05, 1.3, 0.5) * inBeam * facing * OL.u4.z * (0.10 + 0.22 * tipWeight) * transK;
          }
        }
      }
      let chloroTint = mix(vec3f(0.20, 0.24, 0.10), vec3f(0.42, 0.36, 0.18), sqrt(tipWeight));
      let fr0 = 1.0 - max(dot(n, V), 0.0);
      let fresnelRim = (fr0 * fr0 * fr0) * 0.20 * tipWeight * F.ambient.w * select(1.0, sunFactor, isOverhaulFol);
      col += outbreakAlbedo * (chloroTint * transLobe + vec3f(0.40, 0.36, 0.22) * fresnelRim);
      // Moonlit crown tops: upward-facing outer leaves keep a subtle cool sheen at night so canopies read as dark rounded silhouettes.
      let ny0 = max(n.y, 0.0);
      let crownSheen = (ny0 * ny0) * (0.35 + 0.65 * tipWeight) * smoothstep(0.5, 1.6, o.world.y);
      let v6SheenCol = vec3f(0.56, 0.62, 0.72) * 0.14;
      let sheenCol = select(vec3f(0.50, 0.62, 0.90) * 0.32, select(vec3f(0.18, 0.36, 0.82) * 0.035, select(vec3f(0.26, 0.48, 0.98) * 0.24, v6SheenCol, isV6), isV5OrV6), isOverhaulFol);
      col += outbreakAlbedo * sheenCol * OL.u0.y * crownSheen * clamp(1.0 - F.monitorBounds.w * 1.4, 0.0, 1.0);
      let westCrown = clamp(dot(n, vec3f(-0.83, 0.50, -0.37)) * 0.62 + 0.38, 0.0, 1.0) * smoothstep(0.42, 2.15, o.world.y) * (0.35 + 0.65 * tipWeight);
      col += (outbreakAlbedo * 1.45 + vec3f(0.12, 0.048, 0.010)) * vec3f(1.46, 0.50, 0.10) * westCrown * (0.45 + 0.55 * smoothstep(42.0, 20.0, o.world.x)) * duskGlow * 0.95;
      let folLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
      let v5FolScale = mix(select(0.52, 0.44, isV6), 0.94, sunFactor) * mix(1.0, 0.76 + 0.48 * smoothstep(0.3, 1.9, o.world.y) * max(0.15, n.y), sunVal);
      col = mix(col, vec3f(folLum) * vec3f(1.16, 1.02, 0.64), w * select(0.38, 0.0, satStyle > 0)) * select(1.0, select(mix(0.38, 0.52, sunFactor), v5FolScale, isV5OrV6), isOverhaulFol);
      if (o.world.y < 0.48) {
        let lawnPatch = surfaceNoise(o.world.xz * 0.46 + vec2f(1.9, 4.7));
        col *= mix(0.56, 1.06, smoothstep(0.26, 0.76, lawnPatch));
      }
    }
    col = mix(col, applySceneLightBounceAndHaze(o.world, n, col, inRoom, mat), nightLamps);
    ${includeLampAirAndActorShadow ? "if (mat != 12) { col *= evalActorGroundShadow(o.world, n, inRoom); }" : ""}
    // Darken cutaway wall-top molding (y = 2.73..2.83) so interior walls have a crisp dark charcoal cap
    if (o.world.y > 2.72 && o.world.y < 2.83 && n.y > 0.72) {
      col *= 0.08;
    }
    let beamAdd = evalFlashlight(o.world, n);
    let flashIrr = outbreakFlashMask;
    let lightRule = outbreakLightRule();
    let baseSunLit = clamp((F.monitorBounds.w - 0.14) / 0.52, 0.0, 1.0) * select(1.0, 0.55, inRoom);
    let fdSun = floorData(o.world.xz);
    let sunFacing = select(clamp(dot(n, F.monitorBounds.xyz) * 0.55 + 0.45, 0.22, 1.0), 1.0, mat == 22 || mat == 12);
    let sunShadow = select(clamp((fdSun.g - 0.36) / 0.52, 0.0, 1.0) * (1.0 - fdSun.r * 0.52) * sunFacing, clamp(fdSun.g * 1.35, 0.0, 0.72), inRoom);
    let v6SunLit = baseSunLit * mix(1.0, 0.14 + 0.86 * sunShadow, clamp(unlitDesat, 0.0, 1.2));
    let sunLit = select(0.0, max(select(baseSunLit, v6SunLit, isV6), duskGlow * select(0.84, 0.45, inRoom)), satStyle > 0);
    var litMask = select(outbreakColorMask(flashIrr), 0.88, mat == 2);
    if ((satStyle == 3 || isV5OrV6) && mat != 2) {
      let eDeep = flashIrr * 1.15 + outbreakPracticalIrr * OL.u16.y * select(1.25, 1.42, isV5OrV6) + outbreakBounceIrr * max(OL.colour.z, 0.95) * lightRule;
      let deepMask = smoothstep(0.04, 0.88, 1.0 - fastExpNeg(eDeep / max(OL.u13.w * 0.80, 0.01)));
      litMask = select(deepMask, max(litMask, deepMask), isV5OrV6);
    }
    let effectiveLitMask = mix(max(litMask, sunLit), max(litMask, sunLit * select(0.5, 0.85, isV5OrV6)), lightRule);
    outbreakLitMask = max(litMask * lightRule, sunLit);
    outbreakSeen = 1.0;
    outbreakKnown = 1.0;
    if (mat != 12) {
      col = applyOutbreakFogOfWar(col, o.world, n, inRoom, mat, w);
    } else {
      let V = normalize(F.cam.xyz - o.world);
      // Actors in LOS: Limbo/Noir top-down contour rim + anatomical form shading so zombies stay clearly readable even in dark areas
      let isLiveActor = o.extra.z >= 0.92;
      let inBeam = outbreakColorMask(flashIrr);
      let darkLosScale = select(0.42, 1.0 - select(0.72, 0.30, isV5OrV6) * inBeam, isLiveActor);
      let v1 = 1.0 - max(dot(n, V), 0.0);
      let viewRim = v1 * v1;
      let c1 = clamp(length(n.xz), 0.0, 1.0);
      let contourRim = c1 * c1 * smoothstep(0.22, 1.62, o.world.y);
      let actorRim = max(viewRim, contourRim * 0.85) * max(OL.u2.z, 1.0);
      let topCatch = max(0.0, n.y) * 0.45 * max(OL.u2.z, 1.0) * smoothstep(0.65, 1.68, o.world.y);
      let heightGrad = smoothstep(0.08, 1.62, o.world.y);
      let formShade = (0.36 + 0.64 * clamp(n.y * 0.55 + 0.45, 0.0, 1.0)) * (0.42 + 0.58 * heightGrad);
      let v6RimCool = vec3f(0.088, 0.102, 0.128);
      let rimCol = select(
        mix(vec3f(0.072, 0.088, 0.112), vec3f(0.065, 0.052, 0.038), w),
        mix(select(vec3f(0.095, 0.145, 0.245), v6RimCool, isV6), vec3f(0.11, 0.078, 0.042), max(w, inBeam)),
        isV5OrV6,
      );
      let v6ReadCool = vec3f(0.20, 0.22, 0.25);
      let darkReadFloor = outbreakAlbedo * formShade * select(
        mix(vec3f(0.22, 0.25, 0.30), vec3f(0.18, 0.15, 0.12), w),
        mix(select(vec3f(0.26, 0.30, 0.38), v6ReadCool, isV6), vec3f(0.32, 0.26, 0.20), max(w, inBeam)),
        isV5OrV6,
      ) * darkLosScale;
      let bootAO = select(1.0, mix(0.60, 1.06, smoothstep(0.03, 0.50, o.world.y)), isV5OrV6);
      let actorAddScale = select(1.0, 0.22 + 0.78 * effectiveLitMask, isV6);
      let v5ActorAdd = select(vec3f(0.0), outbreakAlbedo * (vec3f(0.38, 0.30, 0.22) * formShade * nightLamps + max(0.0, n.y) * 0.22) * actorAddScale, isV5OrV6 && o.aux > 4.5);
      if (o.aux > 4.5 && o.aux < 5.5) {
        col = outbreakHeroSurface((max(col, darkReadFloor) + v5ActorAdd) * bootAO, outbreakAlbedo, n, V, max(w, select(0.0, 0.65 * nightLamps, isV5OrV6)), darkLosScale);
      } else if (o.aux > 5.5 && o.aux < 6.5) {
        col = outbreakBeanSurface(max(col, darkReadFloor), outbreakAlbedo, n, V, w, darkLosScale);
      } else {
        let zomForm = select(1.0, select(0.72 + 0.38 * formShade, 1.0, o.aux > 6.5), isV5OrV6);
        col = (max(col, darkReadFloor) + v5ActorAdd + rimCol * max(F.ambient.w, 0.75) * (actorRim + topCatch) * darkLosScale) * bootAO * zomForm;
      }
      col = applyOutbreakUnseenActor(col, o.world, n);
    }
    col += beamAdd * outbreakSeen * select(1.0, 0.16, isV5OrV6 && mat == 12);
    if (modStyle > 0 && (mat == 0 || mat == 3 || mat == 10 || mat == 12 || (isV5OrV6 && mat == 20 && nightLamps > 0.2))) {
      // Soft shoulder roll-off so near-lens flashlight glare does not bleach the survivor, props, or dark macadam asphalt
      let shKnee = select(0.52, 0.34, mat == 20);
      let shSlope = select(0.72, 1.15, mat == 20);
      col = col / (1.0 + max(vec3f(0.0), col - vec3f(shKnee)) * shSlope);
    }
    let knownSight = mix(outbreakSeen, max(outbreakSeen, outbreakKnown), select(lightRule, max(lightRule, sunLit), isV5));
    let isHeroAny = mat == 12 && ((o.aux > 4.5 && o.aux < 5.5) || o.aux > 6.5);
    if (satStyle > 0 && mat != 6) {
      let heroLitFloor = select(0.0, select(0.88, 0.28 * outbreakSeen, isV6), isV5OrV6 && isHeroAny);
      let litActive = clamp(max(effectiveLitMask * knownSight, heroLitFloor), 0.0, 1.0);
      let colLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
      let albLum = max(dot(outbreakAlbedo, vec3f(0.2126, 0.7152, 0.0722)), 1e-4);
      let truePigment = outbreakAlbedo * (colLum / albLum);
      let pigShare = select(select(0.42, 0.52, satStyle == 1), select(0.54, 0.68, mat == 12), isV5OrV6);
      col = mix(col, truePigment, litActive * pigShare);
      let cLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
      let chromaBoost = 1.0 + select(select(0.44, 0.56, satStyle == 3), 0.58, isV5OrV6) * litActive;
      col = max(vec3f(0.0), vec3f(cLum) + (col - vec3f(cLum)) * chromaBoost);
      // Enrich warm practical/beam pools at night so golden light pools hit target chroma (~0.28..0.30)
      let nightPool = clamp(litActive * lightRule * (1.0 - duskGlow * 0.65), 0.0, 1.0);
      let poolWarmShare = select(0.62, select(0.68, 0.22, mat == 12), isV5OrV6);
      col *= mix(vec3f(1.0), select(vec3f(1.18, 0.96, 0.68), vec3f(1.22, 0.95, 0.62), isV5OrV6), nightPool * poolWarmShare);
      if (satStyle == 2 || isV5OrV6) {
        let heroExempt = select(0.0, select(0.94, clamp(0.34 - 0.14 * (unlitDesat - 1.0), 0.10, 0.65) * outbreakSeen, isV6), isV5OrV6 && isHeroAny);
        let unlitNight = clamp((1.0 - max(litMask, duskGlow * 0.75)) * lightRule * (1.0 - heroExempt), 0.0, 1.0);
        let sLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
        let v6MoonCol = mix(vec3f(0.66, 0.90, 1.34), vec3f(0.93, 0.96, 1.03), clamp(unlitDesat, 0.0, 1.0));
        let moonSplitCol = select(vec3f(0.68, 0.88, 1.26), select(vec3f(0.66, 0.90, 1.34), v6MoonCol, isV6), isV5OrV6);
        let splitAmt = select(0.74, select(0.68, clamp(0.92 * unlitDesat, 0.0, 0.98), isV6), isV5OrV6);
        col = mix(col, mix(col, vec3f(sLum) * moonSplitCol, splitAmt), unlitNight);
        if (isV6 && sunVal > 0.05) {
          let dayUnlit = clamp((1.0 - sunShadow * outbreakSeen) * sunVal * (1.0 - litMask) * (1.0 - heroExempt), 0.0, 1.0);
          let dLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
          let dayDesatAmt = clamp(dayUnlit * (0.58 + 0.30 * (1.0 - outbreakSeen)) * unlitDesat, 0.0, 0.95);
          col = mix(col, vec3f(dLum) * vec3f(0.95, 0.97, 1.02), dayDesatAmt);
        }
      } else if (satStyle == 3) {
        let penumbraGlow = litMask * (1.0 - litMask) * 4.0 * lightRule * outbreakSeen;
        col += col * vec3f(0.42, 0.18, 0.03) * penumbraGlow;
      }
    }
    if (gradeStyle > 0 && mat != 6) {
      let gLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
      if (gradeStyle == 1 || isV5OrV6) {
        let dayFactor = clamp(F.monitorBounds.w, 0.0, 1.0);
        let toe = smoothstep(0.005, mix(select(0.08, 0.11, isV5OrV6), select(0.24, 0.19, isV5OrV6), dayFactor), gLum);
        let v6UnlitDark = clamp(0.26 - 0.07 * (shroudDark - 1.0), 0.10, 0.44);
        let v6UnlitBright = clamp(0.64 - 0.16 * (shroudDark - 1.0), 0.28, 0.94);
        let nightUnlitDark = select(0.36, select(mix(0.38, 0.84, duskGlow), mix(v6UnlitDark, 0.78, duskGlow), isV6), isV5OrV6);
        let nightUnlitBright = select(0.80, select(mix(0.94, 1.20, duskGlow), mix(v6UnlitBright, 1.14, duskGlow), isV6), isV5OrV6);
        let dayShadeScale = select(1.0, mix(clamp(0.66 - 0.14 * (shroudDark - 1.0), 0.35, 1.0), 1.0, sunShadow * (0.45 + 0.55 * outbreakSeen)), isV6);
        let darkScale = mix(mix(nightUnlitDark, select(0.94, 1.04, isV5OrV6), litMask), select(0.28, 0.68 * dayShadeScale, isV5OrV6), dayFactor);
        let brightScale = mix(mix(nightUnlitBright, select(1.12, 1.24, isV5OrV6), litMask), select(0.64, 1.34 * mix(0.78, 1.0, dayShadeScale), isV5OrV6), dayFactor);
        col *= mix(darkScale, brightScale, toe);
      } else if (gradeStyle == 2) {
        let mid = smoothstep(0.02, 0.24, gLum);
        col *= mix(vec3f(0.64, 0.74, 0.94), vec3f(1.10, 1.06, 0.98), mid);
      } else if (gradeStyle == 3) {
        let toe = smoothstep(0.0, 0.18, gLum);
        col *= mix(vec3f(0.48, 0.44, 0.54), vec3f(1.18, 1.04, 0.86), toe);
      }
    }
    // Colour comes from light: lit surfaces keep it wherever the scenery is known, not only in sight (light rule on);
    // the sight area adds a small lift, and the hero keeps a little so the survivor reads as today. Soft Bean keeps
    // its own share of its player colour (OL.bean.w) so teammates stay apart in the dark.
    let lit = effectiveLitMask * knownSight;
    let v6HeroKeep = clamp(0.32 - 0.14 * (unlitDesat - 1.0), 0.08, 0.60) * outbreakSeen;
    let lift = OL.colour.y * lightRule * outbreakSeen * select(1.0, clamp(1.0 - 0.65 * unlitDesat, 0.0, 1.0), isV6);
    let beanKeep = select(0.0, clamp(OL.bean.w, 0.0, 1.0), mat == 12 && o.aux > 5.5 && o.aux < 6.5);
    let heroKeep = select(beanKeep, select(0.25, select(0.94, v6HeroKeep, isV6), isV5OrV6), isHeroAny) * lightRule;
    let baseFlashMask = max(lit + lift * (1.0 - lit), heroKeep);
    let extUnseenScale = select(1.0, select(0.16, clamp(0.92 * shroudDark, 0.0, 1.8), isV6), !inRoom && isV5OrV6);
    let litCancel = select(lit, max(litMask * knownSight, sunShadow * outbreakSeen * sunVal), isV6);
    let unlitShroudFloor = select(
      0.0,
      (1.0 - smoothstep(0.02, 0.30, max(litMask, sunShadow * sunVal))) * mix(0.38, 1.18, lightRule) * clamp(shroudDark, 0.0, 2.0) * (1.0 - select(0.0, 0.65, isHeroAny)),
      isV6 && OL.unseen.mode >= 0.5 && OL.unseen.strength > 0.001,
    );
    let rawUnseen = max(outbreakUnseenAlpha * extUnseenScale * select(1.0, clamp(0.35 + 0.65 * sightDark, 0.0, 2.0), isV6), unlitShroudFloor);
    let effUnseenAlpha = rawUnseen * select(1.0, 1.0 - smoothstep(0.04, 0.28, litCancel), satStyle > 0);
    outbreakFlashMask = select(baseFlashMask, baseFlashMask - effUnseenAlpha, effUnseenAlpha > 0.0);
  }
  if (mat == 6) { outbreakFlashMask = 0.55; }
  ${includeLampAirAndActorShadow ? "if (mat != 6) { col += evalLampAir(o.world, OL.u5.w > 0.5); }" : ""}
  if (i32(round(F.map.z)) == 8) {
    let fieldDiag = fieldSight(o.world, n);
    col = vec3f(fieldDiag.x, fieldDiag.y * 0.35, select(0.0, 0.25, mat == 12));
  }
`
}

/** Slot zero casts from eye height, has no radiance, and is reserved for visibility. */
export const shaders = {
  sprite: spriteShader(),
  post: postShader(false, false, outbreakPostFinish),
  scene: makeSceneShader(outbreakSceneHooks),
  lookScene: makeLookSceneShader(outbreakSceneHooks),
  lookPost: makeLookPostShader(outbreakPostFinish),
  lookSceneVariant: (variant: LookVariantMode) => makeLookSceneShader(outbreakSceneHooks, variant),
  lookPostVariant: (variant: LookVariantMode) => makeLookPostShader(outbreakPostFinish, variant),
  visField: visibilityFieldShader,
  volume: flashlightVolumeShader,
  // Tyre smoke and dust take the sky ambient, so at night they stay dim until headlights or the flashlight hit them.
  tyreSmoke: { base: "(F.ambient.rgb * 2.6 + vec3f(0.035))", dust: "((F.ambient.rgb * 2.6 + vec3f(0.035)) * vec3f(1.0, 0.84, 0.64))" },
}
