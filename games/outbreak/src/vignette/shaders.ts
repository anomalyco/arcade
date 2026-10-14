import { foliageWindDeclarationsWgsl } from "@arcade/kit/gpu/foliage"
import {
  makeLookPostShader,
  makeLookSceneShader,
  makeSceneShader,
  postShader,
  spriteShader,
  type SceneHooks,
} from "@arcade/kit/gpu/shaders"
import { surfaceMaterialCoreWgsl } from "@arcade/kit/gpu/surface-materials"
import { BUILDING_RECTS } from "../../shared/map"
import { outbreakPostFinish } from "../shaders"

export const vignetteSceneHooks: SceneHooks = {
  ao: "0.42",
  lightLeak: "0.006 * vis",
  lightAttenuation: `let dn = max(d3, 0.55);
    var att = power * win * (0.08 + 3.4 / (1.0 + dn * dn * 0.45));
    if (att <= 0.004) { continue; }`,
  wallDirectScale: "mix(0.28, 0.46, smoothstep(0.0, 1.5, o.world.y))",
  ambient:
    "ambientAt(n) * select(1.0, Vig.params2.z, useVignetteActive(o.pos)) * mix(0.13 * select(1.0, Vig.params1.x, useVignetteActive(o.pos)), 1.0, select(floorData(o.world.xz).g, 1.0, o.world.y > 2.8)) + select(vec3f(0.0), mix(vec3f(0.022, 0.015, 0.008), vec3f(0.032, 0.020, 0.009), clamp(select(0.0, Vig.params1.y, useVignetteActive(o.pos)), -1.0, 1.0) * 0.5 + 0.5) * select(1.0, Vig.params1.x, useVignetteActive(o.pos)), interior(o.world.xz) && o.world.y < 2.8)",
  diagnostics: "F.map.z",
  smoothShadows: true,
  shadowTaps: 5,
  lightMask: "if (L.cone.w < -0.5 && world.y > 2.75) { continue; } if (L.extra.w < -0.5 && !useVignetteWorld(world)) { continue; }",
  fragmentStart: "surfaceFootprint = max(length(dpdx(o.world)), length(dpdy(o.world))); surfaceTime = F.cam.w;",
  vertex: /* wgsl */ `
  if (v.matAux.x > 21.5 && v.matAux.x < 22.5) {
    let fw = applyFoliageVertexWind(o.world, o.normal, v.matAux.y, F.cam.w, F.cam.xyz, defaultFoliageWindConfig(), noFoliageActors());
    o.world = fw[0];
    o.normal = fw[1];
  }`,
  declarations: /* wgsl */ `
@group(0) @binding(9) var exploredTex: texture_2d<f32>;
${surfaceMaterialCoreWgsl}
${foliageWindDeclarationsWgsl}

struct SurfaceTexUniforms {
  global: vec4f,
  styles: vec4f,
  recipeTex: array<vec4f, 6>,
  recipeExtra: array<vec4f, 3>,
}

@group(0) @binding(12) var<uniform> surfaceTexUniforms: SurfaceTexUniforms;

fn surfaceTexEnabledAt(worldX: f32) -> bool {
  let mode = surfaceTexUniforms.global.x;
  if (mode > 1.5) {
    return worldX >= surfaceTexUniforms.styles.w;
  }
  return mode > 0.5;
}

struct VignetteUniforms {
  // 0: wood_floor, 1: cobblestone, 2: plaster, 3: asphalt, 4: concrete, 5: grass, 6: siding, 7: shingles
  recipes: array<MaterialRecipe, 8>,
  // x: compareMode (0=active, 1=shipped, 2=split), y: compareSplit (0..1), z: cutawayMode, w: diffuseWrap (0..1)
  params0: vec4f,
  // x: ambientFill, y: skyTemp, z: moonTemp, w: overgrowth (0..1)
  params1: vec4f,
  // x: playerX, y: playerZ, z: skyScaleRatio, w: moonScaleRatio
  params2: vec4f,
  // x: flashOriginX, y: flashOriginZ, z: flashDirX, w: flashDirZ
  params3: vec4f,
  // x: tanHalfAngle, y: flashRange, z: flashHaze, w: flashSlot (<0 if off)
  params4: vec4f,
}
@group(0) @binding(13) var<uniform> Vig: VignetteUniforms;
var<private> surfaceTexRatio: vec3f;

fn useVignetteActive(fragPos: vec4f) -> bool {
  let mode = i32(round(Vig.params0.x));
  if (mode == 1) { return false; }
  if (mode == 2) { return (fragPos.x / max(1.0, F.screen.x)) >= Vig.params0.y; }
  return true;
}

fn useVignetteWorld(world: vec3f) -> bool {
  let mode = i32(round(Vig.params0.x));
  if (mode == 1) { return false; }
  if (mode == 2) {
    let clip = F.viewProj * vec4f(world, 1.0);
    let u = (clip.x / max(clip.w, 1e-4)) * 0.5 + 0.5;
    return u >= Vig.params0.y;
  }
  return true;
}

fn pickRecipe(defId: i32, vigSlot: i32, useVig: bool) -> MaterialRecipe {
  if (useVig) { return Vig.recipes[vigSlot]; }
  return defaultMaterialRecipe(defId);
}

fn scaleBaseTint(vertexLinear: vec3f, recipeRgb: vec3f, defaultRgb: vec3f) -> vec3f {
  let rLin = pow(max(recipeRgb, vec3f(0.02)), vec3f(2.2));
  let dLin = pow(max(defaultRgb, vec3f(0.02)), vec3f(2.2));
  return clamp(vertexLinear * (rLin / max(dLin, vec3f(0.001))), vec3f(0.002), vec3f(1.8));
}

fn evalClapboardSiding(world: vec3f, baseTint: vec3f, r: MaterialRecipe) -> SurfaceSample {
  let scale = max(0.25, r.u1.x);
  let lapH = (0.18 * (r.u1.y / 1.56)) / scale;
  let boardLen = (2.2 / scale) * (1.0 + (r.u1.z - 0.38) * 0.3);
  let row = floor(world.y / lapH);
  let plank = floor((world.x + world.z + row * 0.43) / max(0.4, boardLen));
  var col = baseTint;
  col *= 0.95 + (hash2(vec2f(row, plank)) - 0.5) * 0.18 * r.u2.x;
  col *= mix(1.0 - clamp(r.u2.y * 6.5, 0.08, 0.55), 1.0, seam(world.y / lapH, max(0.008, r.u2.y * 0.55), 1.0 / lapH));
  col *= 0.97 + grain(vec2f(world.x + world.z, world.y * 3.5), 11.0 * max(0.25, r.u1.w)) * 0.16;
  let splash = (1.0 - smoothstep(0.13, 0.58, world.y)) * r.u2.z * 0.28;
  let macroPatch = (surfaceNoise(vec2f(world.x + world.z, world.y) * 0.55) - 0.5) * r.u2.w * 0.16;
  col *= clamp(1.0 - splash + macroPatch, 0.45, 1.25);
  return SurfaceSample(col, roughnessToGloss(r.u0.w, 0.03), r.u0.w, 1.0 - splash);
}

fn evalRoofShingles(world: vec3f, baseTint: vec3f, r: MaterialRecipe) -> SurfaceSample {
  let scale = max(0.25, r.u1.x);
  let courseZ = 0.24 / scale;
  let tabX = (0.36 * (r.u1.y / 1.56)) / scale;
  let warp = (surfaceNoise(world.xz * 1.6) - 0.5) * 0.18 * max(0.0, r.u1.z - 0.42);
  let row = floor((world.z + warp) / courseZ);
  let q = vec2f((world.x + warp * 0.5) / tabX + fract(row * 0.5), (world.z + warp) / courseZ);
  let tabHash = hash2(floor(q)) - 0.5;
  var col = baseTint * (0.97 + tabHash * 0.55 * r.u2.x * (1.0 - smoothstep(0.12, 0.5, surfaceFootprint * (1.0 / courseZ))));
  let jw = max(0.006, r.u2.y * 0.52);
  col *= mix(0.52, 1.0, seam(q.x, jw, 1.0 / tabX) * seam(q.y, jw * 1.8, 1.0 / courseZ));
  col *= 1.0 + grain(world.xz, 18.0 * max(0.25, r.u1.w)) * 0.15;
  let moss = smoothstep(0.58 - r.u2.z * 0.15, 0.80, surfaceNoise(world.xz * 0.65 + vec2f(3.1, 1.7))) * r.u2.w;
  col = mix(col, vec3f(0.18, 0.25, 0.14), moss * 0.38);
  return SurfaceSample(col, roughnessToGloss(r.u0.w, 0.04), r.u0.w, 1.0);
}

fn houseRect(id: i32) -> vec4f {
  switch id {
    ${BUILDING_RECTS.map((b, i) => `${i === 3 ? "default" : `case ${i}`}: {return vec4f(${b.map(v => v.toFixed(2)).join(",")});}`).join("\n")}
  }
}
fn interior(p: vec2f) -> bool {
  if (p.x < 21.25 || p.x > 72.75 || p.y < 23.25 || p.y > 67.75 || (p.x > 36.75 && p.x < 53.25) || (p.y > 37.75 && p.y < 54.25)) { return false; }
  for (var i = 0; i < 4; i++) { let b = houseRect(i); if (all(p > b.xy + 0.25) && all(p < b.zw - 0.25)) { return true; } }
  return false;
}
fn roofCut(p: vec3f, id: i32) -> bool {
  let b = houseRect(id);
  return all(F.eye.xy > b.xy - 0.1) && all(F.eye.xy < b.zw + 0.1) && p.x > b.x + 0.35 && p.x < b.z - 0.35 && p.z > b.y + 0.35 && p.z < b.w + 1.65;
}
fn eyeVisible(p: vec2f) -> f32 {
  let eyeOrigin = select(F.eye.xy, Vig.params2.xy, length(Vig.params2.xy) > 0.1);
  let delta = p - eyeOrigin;
  let distance = length(delta);
  let a = (atan2(delta.y, delta.x) + TAU) % TAU;
  let f = a / TAU * f32(RAYS) - 0.5;
  let ray0 = u32(i32(floor(f)) + i32(RAYS)) % RAYS;
  let ray1 = (ray0 + 1u) % RAYS;
  let los0 = 1.0 - smoothstep(polar[ray0 * 2u].x + 0.025, polar[ray0 * 2u].x + 0.10, distance);
  let los1 = 1.0 - smoothstep(polar[ray1 * 2u].x + 0.025, polar[ray1 * 2u].x + 0.10, distance);
  let los = mix(los0, los1, fract(f));
  let facing = dot(delta / max(distance, 0.001), vec2f(cos(F.effects.x), sin(F.effects.x)));
  let cone = smoothstep(F.effects.y, F.effects.y + 0.035, facing);
  let near = 1.0 - smoothstep(F.effects.z - 0.2, F.effects.z, distance);
  let range = 1.0 - smoothstep(lights[0].pos.w - 1.0, lights[0].pos.w, distance);
  return los * max(cone, near) * range;
}
`,
    material: /* wgsl */ `
    let activeVignette = useVignetteActive(o.pos);
    let texOn = surfaceTexEnabledAt(o.world.x);
    let wallUv = select(vec2f(o.world.x, o.world.y), vec2f(o.world.z, o.world.y), abs(n.x) > abs(n.z));
    if (mat == 20) {
      let kind = i32(round(o.aux));
      let p = o.world.xz;
      if (kind == 0) {
        let r = pickRecipe(4, 5, activeVignette);
        let tinted = select(albedo, scaleBaseTint(albedo, r.u0.xyz, vec3f(0.34, 0.39, 0.26)), activeVignette);
        let s = evalGrassSoil(p, tinted, false, r);
        albedo = s.albedo;
        gloss = s.gloss;
        if (texOn) {
          let tex = sampleMaterialFast(8, p, 0.58 * max(0.25, r.u1.x));
          albedo = modulateFast(albedo, tex, vec3f(0.1918, 0.1757, 0.0541), 0.88);
          let normAtten = (1.0 - smoothstep(0.08, 0.48, surfaceFootprint)) * 0.28;
          let tilt = (tex.a - 0.91) * 3.2;
          n = normalize(n + vec3f(tilt, 0.0, -tilt * 0.85) * normAtten);
        }
      } else if (kind == 1) {
        let r = pickRecipe(3, 3, activeVignette);
        let tinted = select(albedo, scaleBaseTint(albedo, r.u0.xyz, vec3f(0.24, 0.26, 0.28)), activeVignette);
        let s = evalAsphaltConcrete(p, tinted, false, r);
        albedo = s.albedo;
        gloss = s.gloss;
        if (texOn) {
          let tex = sampleMaterialFast(7, p, 0.55 * max(0.25, r.u1.x));
          albedo = modulateFast(albedo, tex, vec3f(0.0931, 0.0927, 0.0950), 0.92);
        }
        if (activeVignette && Vig.params1.w > 0.02) {
          let edgeCreep = (1.0 - smoothstep(0.0, 1.25, min(abs(p.y - 40.0), abs(p.y - 48.0)))) * surfaceNoise(p * 1.8 + vec2f(4.2, 1.9));
          let moss = smoothstep(0.42, 0.72, edgeCreep) * Vig.params1.w;
          albedo = mix(albedo, vec3f(0.14, 0.21, 0.09), moss * 0.65);
        }
      } else if (kind == 2) {
        let r = pickRecipe(3, 4, activeVignette);
        let tinted = select(albedo, scaleBaseTint(albedo, r.u0.xyz, vec3f(0.60, 0.61, 0.64)), activeVignette);
        let s = evalAsphaltConcrete(p, tinted, true, r);
        albedo = s.albedo;
        gloss = s.gloss;
        if (texOn) {
          let tex = sampleMaterialFast(6, p, 0.58 * max(0.25, r.u1.x));
          albedo = modulateFast(albedo, tex, vec3f(0.4007, 0.3581, 0.3189), 0.85);
        }
        if (activeVignette && Vig.params1.w > 0.02) {
          let jointMoss = (1.0 - s.cavity) * smoothstep(0.30, 0.68, surfaceNoise(p * 1.5 + vec2f(7.1, 2.3))) * Vig.params1.w;
          albedo = mix(albedo, vec3f(0.16, 0.24, 0.10), clamp(jointMoss * 1.35, 0.0, 0.78));
        }
      } else if (kind == 3) {
        let ruts = exp(-pow((fract((p.x - 19.0) * 0.377) - 0.26) * 5.2, 2.0)) + exp(-pow((fract((p.x - 19.0) * 0.377) - 0.74) * 5.2, 2.0));
        let pebbles = grain(p, 18.0) * 0.85 + grain(p + vec2f(3.7, 1.9), 9.5) * 0.48;
        let edgeFade = smoothstep(0.0, 0.24, min(fract((p.x - 19.0) * 0.377), 1.0 - fract((p.x - 19.0) * 0.377)));
        albedo *= (0.78 + pebbles + (surfaceNoise(p * 2.6) - 0.5) * 0.36 - 0.16 * clamp(ruts, 0.0, 1.0)) * (0.76 + 0.24 * edgeFade);
        if (texOn) {
          let tex = sampleMaterialFast(15, p, 0.85);
          albedo = modulateFast(albedo, tex, vec3f(0.2950, 0.2326, 0.1649), 0.65);
        }
        gloss = vec2f(0.0);
      } else if (kind == 4) {
        let r = pickRecipe(0, 0, activeVignette);
        let tinted = select(albedo, scaleBaseTint(albedo, r.u0.xyz, vec3f(0.55, 0.43, 0.31)), activeVignette);
        let s = evalWoodPlanks(p, tinted, r);
        albedo = s.albedo;
        gloss = s.gloss;
        if (texOn) {
          let tex = sampleMaterialFast(0, p, 0.65 * max(0.25, r.u1.x));
          albedo = modulateFast(albedo, tex, vec3f(0.4035, 0.1731, 0.0646), 0.82);
        }
      } else if (kind == 6) {
        let r = pickRecipe(1, 1, activeVignette);
        let s = evalCobblestone(p, albedo, r);
        albedo = s.albedo;
        gloss = s.gloss;
        if (texOn) {
          let tex = sampleMaterialFast(15, p, 0.68);
          albedo = modulateFast(albedo, tex, vec3f(0.2950, 0.2326, 0.1649), 0.78);
        }
      } else {
        let r = pickRecipe(4, 5, activeVignette);
        let s = evalGrassSoil(p, albedo, true, r);
        albedo = s.albedo;
        gloss = s.gloss;
      }
    }
    // Textured area rugs in living room, bedroom, and kitchen runner
    if (mat == 0 && o.world.y > 0.131 && o.world.y < 0.156 && o.world.x < 37.5 && texOn) {
      let p = o.world.xz;
      let b = vec4f(22.0, 24.0, 37.0, 35.5);
      if (p.x >= b.x + 1.53 && p.x <= b.x + 4.67 && p.y >= b.w - 4.37 && p.y <= b.w - 0.83) {
        let uv = clamp((p - vec2f(b.x + 1.55, b.w - 4.35)) / vec2f(3.10, 3.50), vec2f(0.015), vec2f(0.985));
        let edgeBevel = smoothstep(0.0, 0.035, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
        let tex = textureSampleLevel(materialTexArray, materialSampler, uv, 12, materialMipLod(0.32));
        albedo = clamp(tex.rgb * 0.90 * mix(0.72, 1.0, edgeBevel), vec3f(0.02), vec3f(0.95));
        gloss = vec2f(0.0);
      } else if (p.x >= b.x + 5.00 && p.x <= b.x + 6.90 && p.y >= b.y + 1.33 && p.y <= b.y + 4.27) {
        let uv = clamp((p - vec2f(b.x + 5.02, b.y + 1.35)) / vec2f(1.86, 2.90), vec2f(0.015), vec2f(0.985));
        let edgeBevel = smoothstep(0.0, 0.035, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
        let tex = textureSampleLevel(materialTexArray, materialSampler, uv, 13, materialMipLod(0.45));
        albedo = clamp(tex.rgb * 0.90 * mix(0.72, 1.0, edgeBevel), vec3f(0.02), vec3f(0.95));
        gloss = vec2f(0.0);
      }
    }
    if (mat == 4 && o.aux > 19.5) {
      if (o.aux > 20.5) {
        let r = pickRecipe(2, 2, activeVignette);
        let s = evalPlasterWall(o.world, n, albedo, r);
        albedo = s.albedo;
        gloss = s.gloss;
        if (texOn) {
          let tex = sampleMaterialFast(2, wallUv, 0.78);
          albedo = modulateFast(albedo, tex, vec3f(0.7567, 0.6302, 0.4162), 0.72);
        }
      } else if (activeVignette) {
        let r = Vig.recipes[6];
        let tinted = scaleBaseTint(albedo, r.u0.xyz, vec3f(0.70, 0.68, 0.62));
        let s = evalClapboardSiding(o.world, tinted, r);
        albedo = s.albedo;
        gloss = s.gloss;
        if (texOn) {
          let tex = sampleMaterialFast(3, wallUv, 0.72 * max(0.25, r.u1.x));
          albedo = modulateFast(albedo, tex, vec3f(0.6159, 0.5723, 0.5086), 0.80);
        }
      } else {
        let row = floor(o.world.y / 0.18);
        let plank = floor((o.world.x + o.world.z + row * 0.43) / 2.2);
        albedo *= 0.95 + (hash2(vec2f(row, plank)) - 0.5) * 0.08;
        albedo *= mix(0.70, 1.0, seam(o.world.y / 0.18, 0.025, 5.55));
        albedo *= 0.97 + grain(vec2f(o.world.x + o.world.z, o.world.y * 3.5), 11.0) * 0.14;
        albedo *= mix(0.84, 1.0, smoothstep(0.13, 0.55, o.world.y));
      }
    }
    if (mat == 4 && interior(o.world.xz + n.xz * 0.3)) {
      let r = pickRecipe(2, 2, activeVignette);
      let baseWall = select(vec3f(0.44, 0.38, 0.31), scaleBaseTint(vec3f(0.44, 0.38, 0.31), r.u0.xyz, vec3f(0.44, 0.40, 0.33)), activeVignette);
      let s = evalPlasterWall(o.world, n, baseWall, r);
      albedo = s.albedo;
      gloss = s.gloss;
      if (texOn) {
        let tex = sampleMaterialFast(2, wallUv, 0.78 * max(0.25, r.u1.x));
        albedo = modulateFast(albedo, tex, vec3f(0.7567, 0.6302, 0.4162), 0.72);
      }
    }
    if (mat == 21) {
      if (activeVignette) {
        let r = Vig.recipes[7];
        let tinted = scaleBaseTint(albedo, r.u0.xyz, vec3f(0.24, 0.28, 0.35));
        let s = evalRoofShingles(o.world, tinted, r);
        albedo = s.albedo;
        gloss = s.gloss;
        if (texOn) {
          let tex = sampleMaterialFast(4, o.world.xz, 0.68 * max(0.25, r.u1.x));
          albedo = modulateFast(albedo, tex, vec3f(0.1056, 0.1172, 0.1297), 0.88);
        }
      } else {
        let row = floor(o.world.z / 0.24);
        let q = vec2f(o.world.x / 0.36 + fract(row * 0.5), o.world.z / 0.24);
        let tabHash = hash2(floor(q)) - 0.5;
        albedo *= 0.97 + tabHash * 0.30 * (1.0 - smoothstep(0.12, 0.5, surfaceFootprint * 4.16));
        albedo *= mix(0.55, 1.0, seam(q.x, 0.018, 2.77) * seam(q.y, 0.035, 4.16));
        albedo *= 1.0 + grain(o.world.xz, 18.0) * 0.14;
      }
    }
    if (mat == 23) {
      let p = vec2f(o.world.x + o.world.z, o.world.y);
      let row = floor(p.y / 0.085);
      let q = vec2f(p.x / 0.25 + fract(row * 0.5), p.y / 0.085);
      albedo = mix(vec3f(0.32, 0.30, 0.26), albedo * (0.8 + 0.35 * hash2(floor(q))), seam(q.x, 0.025, 4.0) * seam(q.y, 0.06, 11.76));
      if (texOn) {
        let tex = sampleMaterialFast(5, p, 0.85);
        albedo = modulateFast(albedo, tex, vec3f(0.3143, 0.1732, 0.1377), 0.80);
      }
    }
    if (mat == 22) {
      let s = evalFoliageCanopy(o.world, n, albedo, defaultMaterialRecipe(5));
      albedo = s.albedo;
      gloss = s.gloss;
      if (texOn) {
        let tex = sampleMaterialFast(9, o.world.xz + vec2f(o.world.y * 0.35), 0.95);
        albedo = modulateFast(albedo, tex, vec3f(0.145, 0.195, 0.082), 0.72);
      }
      if (activeVignette && Vig.params1.y < -0.35 && Vig.params0.w < 0.05) {
        // Noir foliage: deep ink-black silhouette core with crisp moonlit upper-leaf rim
        let fLum = dot(albedo, vec3f(0.2126, 0.7152, 0.0722));
        let leafMicro = surfaceNoise(o.world.xz * 7.8 + vec2f(o.world.y * 3.1, -o.world.y * 2.4));
        let tipRim = smoothstep(0.54, 0.88, leafMicro) * max(0.0, n.y) * smoothstep(0.6, 3.2, o.world.y);
        let coreShadow = smoothstep(0.18, 0.72, leafMicro);
        albedo = mix(vec3f(fLum) * vec3f(0.18, 0.23, 0.30), albedo * 0.22, 0.18) * mix(0.28, 0.95, coreShadow) + vec3f(0.048, 0.062, 0.085) * tipRim;
      }
    }
    if (mat == 24) {
      albedo *= 0.84 + surfaceNoise(vec2f(o.world.x + o.world.z, o.world.y * 0.18) * 28.0) * 0.24;
      if (texOn) {
        let tex = sampleMaterialFast(10, vec2f(o.world.x + o.world.z, o.world.y), 0.9);
        albedo = modulateFast(albedo, tex, vec3f(0.18, 0.13, 0.09), 0.70);
      }
      gloss = vec2f(0.0);
    }
    surfaceTexRatio = clamp(albedo / max(o.color, vec3f(0.02)), vec3f(0.55), vec3f(1.55));
`,
    directional:
      "mix(vec3f(0.46, 0.68, 1.08), vec3f(1.05, 0.76, 0.44), clamp(F.monitorBounds.w + select(0.0, Vig.params1.z * 0.65, useVignetteActive(o.pos)), 0.0, 1.0)) * select(fd.g * 0.35, 1.0, !interior(o.world.xz) || o.world.y > 2.8) * F.ambient.w * select(1.0, Vig.params2.w, useVignetteActive(o.pos)) * max(0.0, dot(n, F.monitorBounds.xyz))",
    cutaway: `
      if (i32(round(o.mat)) == 21 && roofCut(o.world, i32(round(o.aux)))) { discard; }
      if (o.world.y > 2.8 && interior(o.world.xz)) {
        for (var i = 0; i < 4; i++) { if (roofCut(o.world, i)) { discard; } }
      }
    `,
    solidCutaway: "",
    surface: /* wgsl */ `
  let visible = eyeVisible(o.world.xz + n.xz * 0.06);
  let explored = textureSampleLevel(exploredTex, floorSamp, o.world.xz * F.map.xy, 0.0).r;
  let activeVig = useVignetteActive(o.pos);
  let isNoir = activeVig && Vig.params1.y < -0.35 && Vig.params0.w < 0.05;
  if (mat == 2) {
    col *= 0.88;
    if (isNoir) {
      // South facade windows: left window is unlit cold glass; right window has a soft centered amber glow.
      if (o.world.z > 35.1 && o.world.y < 2.2) {
        if (o.world.x < 26.5) {
          col = vec3f(0.012, 0.018, 0.026);
        } else if (o.world.x > 31.5) {
          let wDist = length(vec2f((o.world.x - 34.25) * 0.9, (o.world.y - 1.50) * 1.3));
          let wFall = exp(-wDist * wDist * 2.4);
          col = select(vec3f(0.32, 0.25, 0.16) * wFall + vec3f(0.015, 0.02, 0.028), col * 0.04, Vig.params2.y < 35.0);
        }
      } else if (o.world.z < 35.0) {
        // Bedroom nightstand shade is cool silvery-blue; unlit SW sofa shade is dark.
        if (o.world.x < 27.0 && o.world.z < 28.0) {
          col = vec3f(0.55, 0.72, 0.95) * 0.85;
        } else if (o.world.x < 26.0 && o.world.z > 30.0) {
          col = vec3f(0.015, 0.016, 0.02);
        } else {
          col *= 0.55;
        }
      } else {
        // Porch sconce diffuser
        col *= 0.45;
      }
    }
  }
  if (mat == 4 && !interior(o.world.xz + n.xz * 0.3)) { col *= mix(1.0, 0.52, smoothstep(2.15, 2.78, o.world.y)); }
  if (mat == 20 && i32(round(o.aux)) == 1) {
    let crown = 1.0 - abs(clamp((o.world.z - 40.0) / 8.0, 0.0, 1.0) * 2.0 - 1.0) * 0.35;
    col += vec3f(0.018, 0.026, 0.052) * F.ambient.w * crown * (0.88 + 0.24 * surfaceNoise(o.world.xz * 0.35));
  }
  if (mat == 20 && i32(round(o.aux)) == 2) {
    col += vec3f(0.012, 0.018, 0.036) * F.ambient.w;
  }
  if (mat == 21) {
    let eave = smoothstep(2.88, 3.55, o.world.y);
    col = col * mix(0.62, 1.08, eave) + vec3f(0.005, 0.010, 0.022) * F.ambient.w * eave * max(0.0, n.y);
  }
  // Direction 2 (Painterly): rich gouache twilight, saturated lush greens, warm honey interiors, peach highlights vs periwinkle shadows
  if (activeVig && Vig.params0.w > 0.05) {
    let wAmt = Vig.params0.w;
    // Multi-scale cell brush strokes + organic FBM so flat surfaces read as hand-painted gouache dabs
    let warp = vec2f(surfaceNoise(o.world.xz * 2.8 + vec2f(1.3, 4.1)) - 0.5, surfaceNoise(o.world.xz * 2.8 + vec2f(7.9, 2.6)) - 0.5) * 0.35;
    let brushCell = floor((o.world.xz + warp) * 3.4);
    let cellTone = (hash2(brushCell) - 0.5) * 0.18;
    let fbm1 = surfaceFbm(o.world.xz * 1.35 + vec2f(o.world.y * 0.8, 2.3));
    let fbm2 = surfaceNoise(o.world.xz * 4.2 + vec2f(5.1, 1.7));
    let brush = clamp(0.76 + 0.48 * (fbm1 * 0.60 + fbm2 * 0.40) + cellTone, 0.58, 1.38);
    let isInteriorView = Vig.params2.y < 35.0;
    let extScale = select(1.0, 0.48, isInteriorView);
    let texMod = mix(vec3f(1.0), surfaceTexRatio, 0.55);
    if (mat == 2) {
      // Rich warm golden-amber window panes & glowing lamp shades
      col = vec3f(1.28, 0.74, 0.20) * (0.88 + 0.28 * fbm1);
    } else if (interior(o.world.xz) && o.world.y < 2.76) {
      let dBed = exp(-(pow((o.world.x - 24.8) * 0.40, 2.0) + pow((o.world.z - 25.6) * 0.40, 2.0)));
      let dSofa = exp(-(pow((o.world.x - 23.6) * 0.40, 2.0) + pow((o.world.z - 33.8) * 0.40, 2.0)));
      let dHall = exp(-(pow((o.world.x - 28.0) * 0.36, 2.0) + pow((o.world.z - 32.0) * 0.36, 2.0)));
      let dDin = exp(-(pow((o.world.x - 33.8) * 0.44, 2.0) + pow((o.world.z - 32.5) * 0.44, 2.0)));
      let dNorthTab = exp(-(pow((o.world.x - 31.8) * 0.55, 2.0) + pow((o.world.z - 27.6) * 0.55, 2.0)));
      let lampPools = clamp(dBed * 1.45 + dSofa * 1.18 + dHall * 0.75 + dDin * 0.90 + dNorthTab * 0.85, 0.0, 1.50);
      // Sage-green lower wainscot band on interior walls (y < 0.92), warm parchment-taupe upper plaster
      if (mat == 4 && abs(n.y) < 0.4) {
        let wainscot = 1.0 - smoothstep(0.82, 0.98, o.world.y);
        let inKitchenWall = smoothstep(29.8, 26.5, o.world.z) * smoothstep(28.0, 31.5, o.world.x);
        let upperPlaster = mix(vec3f(0.145, 0.126, 0.112), vec3f(0.095, 0.095, 0.105), inKitchenWall * 0.7);
        let wallShadow = mix(upperPlaster, vec3f(0.068, 0.092, 0.068), wainscot);
        let lampWall = vec3f(0.24, 0.132, 0.028) * lampPools;
        col = col * 0.14 + (wallShadow + lampWall) * texMod * brush * (0.72 + 0.28 * smoothstep(0.2, 2.4, o.world.y));
      } else if (mat == 20 || (o.world.y > 0.13 && o.world.y < 0.16)) {
        // Rich reddish-chestnut gouache floorboards with dark plank joints & shadowed kitchen tiles
        let row = floor(o.world.z / 0.22);
        let plank = floor((o.world.x + fract(row * 0.41) * 1.8) / 1.6);
        let boardVar = 0.68 + 0.60 * hash2(vec2f(row, plank));
        let seamLong = smoothstep(0.0, 0.09, abs(fract(o.world.z / 0.22) - 0.5));
        let seamButt = smoothstep(0.0, 0.05, abs(fract((o.world.x + fract(row * 0.41) * 1.8) / 1.6) - 0.5));
        let inKitchen = smoothstep(29.8, 26.2, o.world.z) * smoothstep(28.2, 31.5, o.world.x);
        let floorBase = mix(vec3f(0.076, 0.042, 0.024), vec3f(0.036, 0.032, 0.030), inKitchen * 0.88);
        let warmLift = vec3f(0.135, 0.068, 0.018) * lampPools;
        col = (floorBase * boardVar + warmLift) * texMod * brush * (0.54 + 0.46 * seamLong * seamButt);
      } else {
        // Furniture: muted sage-teal bed blankets & kitchen cabinets, warm walnut tables/chairs
        let isBedOrCounter = (o.world.x < 25.4 && o.world.y > 0.40 && o.world.y < 0.72) || (o.world.x > 31.0 && o.world.z < 29.8 && o.world.y < 0.92);
        let furnBase = select(o.color * vec3f(0.18, 0.11, 0.064), vec3f(0.052, 0.082, 0.072), isBedOrCounter);
        col = col * 0.14 + (furnBase + vec3f(0.115, 0.062, 0.016) * lampPools) * brush;
      }
      // Darken cutaway wall-top border to slate-periwinkle
      if (o.world.y > 2.73 && n.y > 0.75) {
        col = vec3f(0.040, 0.048, 0.088);
      }
    } else {
      // Exterior gouache twilight: periwinkle-lavender road & roof, lush sage-olive turf/trees, golden-peach porch/window pools
      let edgeVignette = clamp(1.0 - pow(abs(o.world.x - 29.5) / 21.0, 1.8) * 0.36, 0.54, 1.05);
      let winGlowL = exp(-pow((o.world.x - 24.5) * 0.38, 2.0)) * exp(-pow((o.world.z - 36.2) * 0.42, 2.0));
      let winGlowR = exp(-pow((o.world.x - 34.2) * 0.38, 2.0)) * exp(-pow((o.world.z - 36.2) * 0.42, 2.0));
      let porchGlow = exp(-pow((o.world.x - 27.7) * 0.26, 2.0)) * exp(-pow((o.world.z - 37.6) * 0.28, 2.0)) * select(1.0, 0.62, isInteriorView);
      let warmLawn = clamp(winGlowL * 0.85 + winGlowR * 0.85 + porchGlow * 1.25, 0.0, 1.25);
      if (mat == 20) {
        let kind = i32(round(o.aux));
        if (kind == 1) {
          // Street asphalt: rich periwinkle-indigo gouache wash with warm peach-gold porch spill
          let warmPool = exp(-pow((o.world.x - 28.0) * 0.15, 2.0)) * exp(-pow((o.world.z - 41.0) * 0.22, 2.0));
          let roadBase = mix(vec3f(0.082, 0.098, 0.185), vec3f(0.24, 0.172, 0.118), warmPool * 0.90);
          col = col * 0.08 + roadBase * texMod * brush * edgeVignette * extScale;
        } else if (kind == 2 || kind == 6) {
          // Sidewalk & front stone path: warm cream-stone with rich golden-peach porch spill
          let walkGlow = exp(-pow((o.world.x - 27.7) * 0.26, 2.0)) * smoothstep(43.2, 35.5, o.world.z) * select(1.0, 0.65, isInteriorView);
          let slabJoint = smoothstep(0.0, 0.06, min(abs(fract(o.world.x / 1.4) - 0.5), abs(fract(o.world.z / 1.2) - 0.5)));
          let walkBase = mix(vec3f(0.168, 0.160, 0.152), vec3f(0.46, 0.28, 0.10), walkGlow * 0.95);
          col = col * 0.12 + walkBase * texMod * brush * (0.82 + 0.18 * slabJoint) * edgeVignette * extScale;
        } else {
          // Lawn & verge: deep twilight olive under side trees, medium twilight sage on south lawn, lush warm sage-olive on front lawn
          let sideOpen = smoothstep(19.5, 23.2, o.world.x) * smoothstep(40.2, 36.2, o.world.x);
          let frontOpen = smoothstep(46.0, 41.0, o.world.z);
          let sideGrass = vec3f(0.038, 0.056, 0.052) * select(1.0, 1.55, isInteriorView);
          let southGrass = vec3f(0.078, 0.102, 0.088);
          let frontGrass = vec3f(0.102, 0.145, 0.066);
          let shadowGrass = mix(sideGrass, mix(southGrass, frontGrass, frontOpen), sideOpen);
          let grassBase = mix(shadowGrass, vec3f(0.32, 0.24, 0.068), warmLawn * 0.85);
          col = col * 0.06 + grassBase * texMod * brush * edgeVignette * extScale;
        }
      } else if (mat == 21) {
        // Roof shingles: hand-painted slate-periwinkle tiles with course & tab seams
        let row = floor(o.world.z / 0.28);
        let q = vec2f(o.world.x / 0.44 + fract(row * 0.5), o.world.z / 0.28);
        let tileVar = 0.78 + 0.44 * hash2(floor(q));
        let tileSeam = smoothstep(0.0, 0.08, abs(fract(q.x) - 0.5)) * smoothstep(0.0, 0.11, abs(fract(q.y) - 0.5));
        col = col * 0.08 + vec3f(0.052, 0.064, 0.118) * tileVar * (0.72 + 0.28 * tileSeam) * texMod * brush * edgeVignette * extScale;
      } else if (mat == 22) {
        // Tree & shrub foliage: deep twilight olive-sage in inner boughs, soft sage lobes on top, warm blossom dabs on foundation shrubs
        let crownLift = clamp(smoothstep(0.2, 3.8, o.world.y) * 0.34 + max(0.0, n.y) * 0.38, 0.0, 1.0);
        let leafTone = mix(vec3f(0.018, 0.034, 0.028), vec3f(0.055, 0.088, 0.048), crownLift) * select(1.0, 1.45, isInteriorView);
        let isFoundationBush = step(34.6, o.world.z) * step(o.world.z, 37.0) * step(22.0, o.world.x) * step(o.world.x, 36.8);
        let blossom = smoothstep(0.32, 0.58, hash2(floor(o.world.xz * 5.2))) * isFoundationBush;
        let shrubGlow = mix(vec3f(0.036, 0.058, 0.022), vec3f(0.20, 0.14, 0.042), blossom) * warmLawn;
        col = col * 0.05 + (leafTone + shrubGlow) * texMod * brush * edgeVignette * extScale;
      } else if (mat == 4) {
        // Exterior clapboard walls & porch columns: soft cream-lavender siding with subtle warm window/porch bounce
        let lap = 0.78 + 0.22 * smoothstep(0.0, 0.22, fract(o.world.y / 0.18));
        let wallWarm = mix(vec3f(0.128, 0.135, 0.175), vec3f(0.22, 0.165, 0.105), warmLawn * 0.62);
        col = col * 0.12 + o.color * wallWarm * lap * texMod * brush * extScale;
      } else {
        col = col * 0.16 + o.color * vec3f(0.12, 0.13, 0.175) * brush * extScale;
      }
    }
    col = mix(o.color, col, wAmt);
  }
  // Direction 4 (Cozy golden-hour): warm slanting window sun-shaft pools on living room & kitchen floor
  if (activeVig && Vig.params1.w > 0.25 && interior(o.world.xz) && o.world.y < 0.22) {
    let p = o.world.xz;
    let southWin1 = smoothstep(1.2, 0.1, abs(p.x - 24.6)) * smoothstep(35.3, 33.6, p.y) * smoothstep(31.2, 33.2, p.y);
    let southWin2 = smoothstep(1.3, 0.1, abs(p.x - 34.2)) * smoothstep(35.3, 33.6, p.y) * smoothstep(31.2, 33.2, p.y);
    let eastWin = smoothstep(1.4, 0.1, abs(p.y - 29.4)) * smoothstep(36.8, 34.8, p.x) * smoothstep(32.5, 34.6, p.x);
    let shaft = max(max(southWin1, southWin2), eastWin) * Vig.params1.w;
    col += o.color * vec3f(0.55, 0.34, 0.12) * shaft;
  }
  if (isNoir) {
    // Darken cutaway wall-top molding (y = 2.76..2.81) so interior walls don't have a bright white outline
    if (o.world.y > 2.74 && o.world.y < 2.83 && n.y > 0.75 && o.world.x > 21.8 && o.world.x < 37.2 && o.world.z > 23.8 && o.world.z < 35.8) {
      col *= 0.08;
    }
    // Roof shingles catching cold directional moonlight along course steps & gable chevron (street view)
    if (mat == 21 && Vig.params2.y > 35.0) {
      let courseStep = smoothstep(0.68, 0.96, fract(o.world.z / 0.23));
      let tabGrain = 0.65 + 0.70 * surfaceNoise(o.world.xz * 6.5);
      let eaveGlow = smoothstep(35.45, 35.88, o.world.z) * smoothstep(36.05, 35.85, o.world.z) * 0.28;
      let gableMask = smoothstep(25.8, 26.5, o.world.x) * smoothstep(29.6, 28.9, o.world.x);
      let gableChevron = smoothstep(36.6, 37.08, o.world.z) * step(2.38, o.world.y) * gableMask;
      col = col * (0.76 + 0.32 * tabGrain) + vec3f(0.009, 0.014, 0.021) * courseStep * tabGrain + vec3f(0.030, 0.040, 0.054) * max(eaveGlow, gableChevron * 0.95);
    }
    // Fine textured detail in darks: gravel ruts, asphalt aggregate, sidewalk grain, and grass/verge blade micro-contrast + front lawn window spill
    if (mat == 20 && !interior(o.world.xz)) {
      let p = o.world.xz;
      let kind = i32(round(o.aux));
      let fineGrit = surfaceNoise(p * 6.8) * 0.6 + surfaceNoise(p * 15.0) * 0.4;
      if (kind == 1) {
        let crackLine = 1.0 - smoothstep(0.0, 0.022, abs(surfaceNoise(p * 0.95 + vec2f(2.4, 5.1)) - 0.5));
        col = col * (0.62 + 0.76 * fineGrit) * (1.0 - crackLine * 0.48);
      } else if (kind == 2) {
        let frontWalk = smoothstep(42.0, 38.0, p.y) * smoothstep(16.0, 21.0, p.x) * smoothstep(42.0, 37.0, p.x);
        col = col * (0.72 + 0.56 * fineGrit) + vec3f(0.008, 0.010, 0.014) * frontWalk * fineGrit * select(1.0, 0.35, Vig.params2.y < 35.0);
      } else if (kind == 0) {
        let tuft = smoothstep(0.28, 0.78, fineGrit);
        let sideTreeShadow = smoothstep(17.5, 22.5, p.x) * smoothstep(40.5, 36.5, p.x);
        let frontLawn = smoothstep(40.0, 36.0, p.y) * smoothstep(35.0, 36.2, p.y) * sideTreeShadow;
        let frontLawnSpill = (exp(-pow((p.x - 24.5) * 0.38, 2.0)) + exp(-pow((p.x - 34.2) * 0.38, 2.0))) * exp(-pow((p.y - 37.2) * 0.45, 2.0));
        col = col * mix(0.48, 1.38, tuft) * mix(0.52, 1.0, sideTreeShadow) + (vec3f(0.018, 0.022, 0.026) * frontLawnSpill + vec3f(0.007, 0.009, 0.012) * frontLawn) * tuft * select(1.0, 0.35, Vig.params2.y < 35.0);
      }
    }
    // Weathered dark slate-grey porch trim, columns, and clapboard courses on south facade
    if ((mat == 4 || mat == 21) && o.world.z > 35.15 && !interior(o.world.xz)) {
      let trimLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
      let courseLap = mix(0.62, 1.12, smoothstep(0.0, 0.25, fract(o.world.y / 0.165)));
      if (trimLum > 0.024) {
        col = mix(vec3f(trimLum) * vec3f(0.19, 0.23, 0.28), col * 0.22, 0.18) * courseLap;
      }
    }
    // Desaturate bright rugs & bedding in Noir and balance interior rooms
    if (interior(o.world.xz) && o.world.y < 2.65) {
      let inLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
      let inDining = smoothstep(29.2, 31.2, o.world.x) * smoothstep(29.2, 30.8, o.world.z);
      col = mix(vec3f(inLum) * vec3f(0.92, 0.95, 1.02), col, mix(0.35, 0.56, inDining));
      // Subdue white fridge/counter/stove tops & runner mat border along the partition
      if (o.world.x > 30.8 && o.world.x < 35.8 && o.world.z > 29.55 && o.world.z < 31.30) {
        if (o.world.y > 0.85 || (o.world.y > 0.131 && o.world.y < 0.148)) {
          col *= 0.24;
        }
      }
      let plasterTex = 0.72 + 0.56 * surfaceFbm(vec2f(o.world.x + o.world.z, o.world.y) * 2.8);
      // Cool silvery-blue wall-wash on the north bedroom wall behind the nightstand lamp
      if (abs(n.y) < 0.35 && o.world.x > 22.2 && o.world.x < 27.6 && o.world.z < 26.2 && o.world.y > 0.45 && o.world.y < 2.65) {
        let bx = exp(-pow((o.world.x - 24.65) * 0.62, 2.0));
        let by = exp(-pow((o.world.y - 1.55) * 1.15, 2.0));
        col += vec3f(0.095, 0.135, 0.185) * bx * by * plasterTex;
      }
      // Warm amber wall-wash on the vertical south-east dining partition wall above the console table
      if (abs(n.y) < 0.35 && o.world.x > 29.2 && o.world.x < 36.2 && o.world.z > 29.40 && o.world.z < 30.25 && o.world.y > 0.55 && o.world.y < 2.55) {
        let wx = exp(-pow((o.world.x - 33.45) * 0.58, 2.0));
        let wy = exp(-pow((o.world.y - 1.48) * 1.15, 2.0));
        col += vec3f(0.25, 0.135, 0.045) * wx * wy * plasterTex;
      }
      // Textured dark wood-plank & plaster fill in the north-east room & central hallway threshold
      if (o.world.z < 29.6 && o.world.x > 28.5) {
        let neTex = 0.55 + 0.90 * surfaceFbm(o.world.xz * 2.4);
        col = col * 0.85 + vec3f(0.007, 0.009, 0.012) * neTex * (0.6 + 0.4 * max(0.0, n.y));
      }
      // Hallway & living-room floorboard bounce around the survivor
      if (o.world.y < 0.22 && o.world.x > 25.8 && o.world.x < 32.2 && o.world.z > 28.8 && o.world.z < 35.3) {
        let hallCarry = exp(-pow((o.world.x - 28.1) * 0.58, 2.0)) * exp(-pow((o.world.z - 31.6) * 0.42, 2.0));
        let plankVar = 0.65 + 0.70 * surfaceNoise(vec2f(o.world.x * 1.4, o.world.z * 9.5));
        let seamDark = smoothstep(0.0, 0.08, abs(fract(o.world.z / 0.18) - 0.5));
        col += vec3f(0.046, 0.050, 0.056) * hallCarry * plankVar * seamDark;
      }
    }
    // East window icy moonlight spill on window reveals & kitchen counter/floor
    if (o.world.x > 33.8 && o.world.x < 37.2 && o.world.z > 26.8 && o.world.z < 35.0) {
      let winX = smoothstep(33.8, 36.85, o.world.x);
      let winZ1 = exp(-pow((o.world.z - 28.8) * 0.78, 2.0));
      let winZ2 = exp(-pow((o.world.z - 32.8) * 0.78, 2.0));
      let moonShaft = winX * max(winZ1, winZ2) * smoothstep(2.45, 0.05, o.world.y);
      col += vec3f(0.075, 0.105, 0.155) * moonShaft;
    }
    // Wider wet porch & walkway reflection pool under the porch light
    if (mat == 20 && o.world.x > 25.0 && o.world.x < 30.4 && o.world.z > 35.4 && o.world.z < 40.2) {
      let cx = exp(-pow((o.world.x - 27.7) * 1.38, 2.0));
      let cz = smoothstep(40.2, 35.5, o.world.z);
      let pWet = 0.55 + 0.90 * surfaceFbm(o.world.xz * 4.5);
      col = col * mix(0.55, 0.98, cx) + vec3f(0.28, 0.27, 0.24) * cx * cz * pWet * select(1.0, 0.30, Vig.params2.y < 35.0);
    }
  }
  // Direction 3 (Noir): volumetric flashlight cone haze + soft outer aura + hot hand core & textured ground beam
  if (activeVig && Vig.params4.w > 0.5) {
    let fSlot = u32(round(Vig.params4.w));
    let fOrig = Vig.params3.xy;
    let fDir = Vig.params3.zw;
    let fSide = vec2f(-fDir.y, fDir.x);
    let rel = o.world.xz - fOrig;
    let along = dot(rel, fDir);
    let across = abs(dot(rel, fSide));
    let tanHalf = max(0.10, Vig.params4.x);
    let fRange = max(3.5, Vig.params4.y);
    let hazeAmt = Vig.params4.z;
    let fLightCol = lights[fSlot].color.rgb;
    let fPower = lights[fSlot].color.w;
    let inHouse = interior(o.world.xz);
    if (along > -0.15 && along < fRange) {
      let coneR = 0.09 + max(0.0, along) * tanHalf * select(1.0, 1.04, inHouse);
      let radialCore = exp(-pow(across / (coneR * select(0.52, 0.50, inHouse)), 2.0));
      let radialAura = exp(-pow(across / (coneR * 0.92), 1.5)) * (1.0 - smoothstep(coneR * 0.75, coneR * 1.38, across));
      let radialEdge = 1.0 - smoothstep(coneR * 0.58, coneR * 1.12, across);
      let axialIn = smoothstep(-0.06, 0.14, along);
      let axialOut = pow(clamp(1.0 - along / fRange, 0.0, 1.0), select(1.55, 1.42, inHouse));
      let vis = shadowAt(fSlot, fOrig, lights[fSlot].pos.y, 0.045, o.world.xz, min(o.world.y, 0.95));
      let grit = 0.55 + 0.90 * (surfaceNoise(o.world.xz * 4.5 + vec2f(1.7, 3.9)) * 0.6 + surfaceNoise(o.world.xz * 11.2) * 0.4);
      let mist = (radialCore * radialEdge * 0.72 + radialAura * 0.36) * axialIn * axialOut / (0.45 + max(0.0, along) * 0.24) * vis * (0.82 + 0.36 * surfaceNoise(o.world.xz * 2.1));
      col += fLightCol * fPower * mist * hazeAmt * select(0.22, 0.24, inHouse);
      if (o.world.y < 0.38) {
        let groundSpot = radialCore * radialEdge * axialIn * axialOut / (0.28 + max(0.0, along) * 0.16 + along * along * 0.022) * vis * grit;
        col += (o.color * select(1.55, 2.05, inHouse) + vec3f(0.062, 0.070, 0.078)) * fLightCol * fPower * groundSpot * select(1.22, 1.65, inHouse);
      }
    }
    // Small close hand/lantern ground spill right at the survivor's feet
    let pRel = o.world.xz - (Vig.params2.xy + vec2f(-0.22, -0.35));
    let pDist = length(pRel);
    if (pDist < 1.55 && o.world.y < 0.35) {
      let nearGlow = exp(-pDist * pDist * 2.2) * (1.0 - smoothstep(0.5, 1.55, pDist));
      col += (o.color * 1.35 + vec3f(0.055, 0.06, 0.065)) * fLightCol * fPower * nearGlow * select(0.36, 0.48, inHouse);
    }
  }
  if (mat != 12 && mat != 21 && mat != 2 && !(activeVig && Vig.params0.w > 0.05)) {
    let luminance = dot(col, vec3f(0.2126, 0.7152, 0.0722));
    let peripheral = mix(vec3f(luminance) * vec3f(0.83, 0.94, 1.05), col, 0.72);
    if (interior(o.world.xz) && o.world.y < 2.8) {
      let room = mix(vec3f(luminance) * vec3f(0.90, 0.96, 1.0), col, 0.88 + 0.12 * visible);
      col = mix(o.color * 0.008, room * mix(F.effects.w, 1.0, 0.82), explored);
    } else {
      col = mix(peripheral * (0.86 + 0.14 * explored), col, 0.86 + 0.14 * visible);
    }
  }
  // Crisp split-screen divider when compareMode == 2 (Split A/B vs Shipped)
  if (i32(round(Vig.params0.x)) == 2) {
    let splitPx = Vig.params0.y * F.screen.x;
    if (abs(o.pos.x - splitPx) < 1.25) {
      col = mix(col, vec3f(0.95, 0.78, 0.42), 0.85);
    }
  }
`,
}

/** Vignette WGSL shaders: uses the production Outbreak scene, lookScene, post, and lookPost pipelines. */
export const vignetteShaders = {
  sprite: spriteShader(),
  post: postShader(false, false, outbreakPostFinish),
  scene: makeSceneShader(vignetteSceneHooks),
  lookScene: makeLookSceneShader(vignetteSceneHooks),
  lookPost: makeLookPostShader(outbreakPostFinish),
}

