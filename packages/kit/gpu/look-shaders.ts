import { lookStructWgsl } from "./look"
import { makeSceneShader, postCommonWgsl, type SceneHooks } from "./shaders"

export type PostFinishOptions = {
  chromatic: number
  bloom: number
  grain: number
  vignette: number
  diagnostics?: boolean
  shadowLift?: number
  huePreserve?: number
  halation?: number
  saturation?: number
  shadowLiftColor?: readonly [number, number, number]
  shadowTint?: readonly [number, number, number]
  highlightTint?: readonly [number, number, number]
}

/**
 * Opt-in Look-enabled scene shader generator.
 * Binds `LookUniforms` at `@group(0) @binding(7)` (unused when motion blur is off).
 * Default `makeSceneShader` remains untouched for bit-exact identity under "Current".
 */
export const makeLookSceneShader = (hooks: SceneHooks = {}): string => {
  const postMat = `    if (lookUseAfter) {
      let flashSuppress = clamp(lookFlashIrradiance * LK.u15.w, 0.0, 1.0);
      let palMix = LK.u3.w * (1.0 - flashSuppress);
      if (palMix > 0.001) {
        if (mat == 4) { albedo = mix(albedo, pow(max(LK.u12.xyz, vec3f(0.02)), vec3f(2.2)), palMix * 0.45); }
        else if (mat == 20) {
          let k = i32(round(o.aux));
          if (k == 4) { albedo = mix(albedo, pow(max(LK.u13.xyz, vec3f(0.02)), vec3f(2.2)), palMix * 0.45); }
          else if (k == 6 || k == 2) { albedo = mix(albedo, pow(max(LK.u14.xyz, vec3f(0.02)), vec3f(2.2)), palMix * 0.40); }
          else if (k == 1) {
            let roadTarget = select(pow(max(LK.u14.xyz * 0.65, vec3f(0.02)), vec3f(2.2)), vec3f(0.115, 0.142, 0.255), i32(round(LK.u14.w)) == 2);
            albedo = mix(albedo, roadTarget, palMix * 0.52);
          }
          else if (k == 0 || k == 5) { albedo = mix(albedo, pow(max(LK.u15.xyz, vec3f(0.02)), vec3f(2.2)), palMix * 0.48); }
        } else if (mat == 22) {
          albedo = mix(albedo, pow(max(LK.u15.xyz, vec3f(0.02)), vec3f(2.2)), palMix * 0.48);
        }
      }
      let folShift = LK.u11.z * (1.0 - flashSuppress);
      if ((mat == 22 || (mat == 20 && (i32(round(o.aux)) == 0 || i32(round(o.aux)) == 5))) && (abs(folShift) > 0.001 || flashSuppress > 0.01)) {
        let warmFol = albedo * vec3f(1.38, 1.08, 0.52);
        let coolFol = vec3f(dot(albedo, vec3f(0.3, 0.5, 0.2))) * vec3f(0.70, 0.86, 0.96);
        albedo = select(mix(albedo, coolFol, clamp(-folShift, 0.0, 1.0)), mix(albedo, warmFol, clamp(folShift, 0.0, 1.0)), folShift >= 0.0);
        if (flashSuppress > 0.01) {
          albedo = mix(albedo, albedo * vec3f(0.95, 1.38, 0.72), flashSuppress * 0.65);
        }
      }
      let wet = LK.u6.y;
      if (wet > 0.001 && n.y > 0.7 && (mat == 1 || mat == 20)) {
        let puddle = smoothstep(0.34, 0.68, noise2(o.world.xz * 0.65 + vec2f(2.1, 4.7)));
        let wMask = wet * (0.4 + 0.6 * puddle);
        albedo *= 1.0 - 0.28 * wMask;
        gloss = mix(gloss, vec2f(110.0, 1.1), wMask);
      }
      lookAlbedo = albedo;
    }\n`
  const base = makeSceneShader({
    ...hooks,
    declarations: `${hooks.declarations ?? ""}\n${lookStructWgsl}\n@group(0) @binding(7) var<uniform> LK: LookUniforms;\nvar<private> lookUseAfter: bool;\nvar<private> lookAlbedo: vec3f;\nvar<private> lookFlashIrradiance: f32;\n`,
    fragmentStart: `${hooks.fragmentStart ?? ""}\n  let lookScreenX = o.pos.x / max(1.0, F.screen.x);\n  let lookCompare = i32(round(LK.u12.w));\n  lookUseAfter = select(lookCompare == 1, lookScreenX >= LK.u13.w, lookCompare == 2) && LK.u11.w > 0.5;\n  lookAlbedo = o.color;\n  lookFlashIrradiance = 0.0;\n  if (lookUseAfter) { surfaceFootprint = max(surfaceFootprint, LK.u10.w * 0.012); }\n`,
    material: `${hooks.material ?? ""}\n    ${hooks.postLightMaterial ? "" : postMat}`,
    postLightMaterial: hooks.postLightMaterial ? `${hooks.postLightMaterial}\n${postMat}` : undefined,
    surface: `${hooks.surface ?? ""}\n  if (lookUseAfter) {
    // Rim / silhouette light on characters, trees, props & wall edges
    let ndv = clamp(dot(n, V), 0.0, 1.0);
    let rimW = select(0.75, 1.85, mat == 12 || mat == 22 || mat == 0);
    let contourTerm = select(0.0, pow(clamp(length(n.xz), 0.0, 1.0), 1.45) * smoothstep(0.20, 1.62, o.world.y) * 1.15, mat == 12);
    let rim = max(pow(1.0 - ndv, 2.4), contourTerm) * LK.u5.w * rimW;
    let rimTint = mix(vec3f(0.68, 0.80, 1.0) * LK.u4.yzw, vec3f(1.0, 0.80, 0.52), clamp(LK.u1.w * 0.5 + 0.25, 0.0, 1.0));
    col += rimTint * rim * 0.075;

    // Extra contact / cavity shading
    if (LK.u6.x > 0.001 && mat != 2 && mat != 3 && mat != 11) {
      let fOcc = floorData(o.world.xz).r * (1.0 - smoothstep(0.0, 1.1, o.world.y));
      col *= 1.0 - clamp(fOcc * LK.u6.x * 0.62, 0.0, 0.78);
    }

    // Closed-form 3D settled height fog & localized east-window moonlight shaft
    let fogDens = LK.u6.z;
    let shaftStr = LK.u7.w;
    if (fogDens > 0.001 || shaftStr > 0.001) {
      let hFall = max(0.35, LK.u6.w);
      let rayVec = o.world - F.cam.xyz;
      let rayDist = max(length(rayVec), 0.001);
      let kVert = (rayVec.y / rayDist) / hFall;
      let dPlanFocus = length(o.world.xz - F.eye.xy);
      let s0 = min(rayDist, max(0.0, rayDist - max(0.0, dPlanFocus - 12.0) * 1.25));
      let vertInt = select(
        (rayDist - s0) * exp(-0.5 * (F.cam.y + o.world.y) / hFall),
        exp(-F.cam.y / hFall) * (exp(-s0 * kVert) - exp(-rayDist * kVert)) / kVert,
        abs(kVert) > 1e-3
      );
      let fogTau = clamp(fogDens * 0.016 * max(0.0, vertInt), 0.0, 2.5);
      let trans = exp(-fogTau);
      let fogCol = pow(max(LK.u7.xyz, vec3f(0.002)), vec3f(2.2)) * clamp(LK.u4.x * 0.45, 0.02, 1.0);
      // East-window cool moonlight shaft slicing into the right side of the house interior
      var shaftAdd = vec3f(0.0);
      if (shaftStr > 0.001 && o.world.x > 30.5 && o.world.x < 34.8 && o.world.z > 24.5 && o.world.z < 33.5 && o.world.y < 2.2) {
        let eastDist = max(0.0, 34.3 - o.world.x);
        let winZ1 = exp(-pow((o.world.z - 26.8) / 0.95, 2.0));
        let winZ2 = exp(-pow((o.world.z - 30.8) / 0.95, 2.0));
        let winBeam = (winZ1 + winZ2) * exp(-eastDist * 0.65) * (1.0 - smoothstep(1.2, 2.2, o.world.y));
        let shaftCol = mix(vec3f(0.55, 0.76, 1.12), vec3f(1.05, 0.78, 0.45), clamp(LK.u1.w * 0.5 + 0.25, 0.0, 1.0));
        shaftAdd = shaftCol * winBeam * shaftStr * 0.042;
      }
      col = col * trans + fogCol * (1.0 - trans) + shaftAdd;
    }
    // Cold steel-blue moonlight rim, volumetric flashlight air haze, and room wall-wash halos in Noir mode
    if (i32(round(LK.u14.w)) == 1) {
      // Darken cutaway wall-top caps (mat 9) and unlit exterior walls in Noir
      if (mat == 9) {
        col *= 0.14;
      }
      if (mat == 4 && !interior(o.world.xz + n.xz * 0.3)) {
        let nearPorch = exp(-pow((o.world.x - 27.7) / 1.8, 2.0)) * step(33.2, o.world.z);
        col *= mix(0.26, 0.85, nearPorch);
      }
      // Dim unlit bulb meshes (SW living room, NE kitchen, and streetlamps)
      if (mat == 2) {
        let isLitRoomBulb = (o.world.x < 27.5 && o.world.z < 28.5) || (o.world.x > 28.0 && o.world.z > 28.5 && o.world.z < 33.8);
        let isPorchBulb = abs(o.world.x - 27.7) < 2.0 && o.world.z > 33.8 && o.world.z < 36.2;
        if (!isLitRoomBulb && !isPorchBulb) {
          col *= 0.04;
        }
      }
      // Subtle steel-blue moonlight on shingle roof (mat 21), trees (mat 22), sidewalk, road, and interior floorboards
      let moonRimDir = normalize(vec3f(-0.35, 0.82, -0.45));
      let topCatch = max(0.22, dot(n, moonRimDir));
      let isRoofOrTree = mat == 21 || mat == 22;
      let surfBoost = select(select(0.42, 0.18, interior(o.world.xz)), 1.35, isRoofOrTree);
      col += lookAlbedo * vec3f(0.048, 0.068, 0.102) * topCatch * surfBoost * LK.u5.z;

      // Interior room wall-wash halos & plank-seam contrast
      if (interior(o.world.xz) && o.world.y < 2.75) {
        // Darken unlit SW living room & NE kitchen corners
        let inSW = smoothstep(28.5, 26.8, o.world.x) * smoothstep(28.2, 29.8, o.world.z);
        let inNE = smoothstep(28.0, 29.8, o.world.x) * smoothstep(28.5, 27.0, o.world.z);
        col *= 1.0 - 0.58 * max(inSW, inNE * 0.75);

        // Cool silvery-blue wall wash behind NW bedroom nightstand lamp (25.1, 25.4)
        let dNW = length(o.world.xz - vec2f(25.1, 25.0));
        let nwWash = exp(-(dNW * dNW) / 4.8) * (0.35 + 0.65 * step(abs(n.y), 0.5));
        col += vec3f(0.036, 0.052, 0.082) * nwWash;
        // Rich warm amber-gold wall wash above SE dining table lamp (31.5, 29.5)
        let dSE = length(o.world.xz - vec2f(31.5, 29.3));
        let seWash = exp(-(dSE * dSE) / 5.8) * (0.3 + 0.7 * step(abs(n.y), 0.5));
        col += vec3f(0.145, 0.068, 0.016) * seWash;
        // Plank-seam contrast on interior wood floor
        if (n.y > 0.8 && o.world.y < 0.3) {
          let plankSeam = smoothstep(0.0, 0.08, abs(fract(o.world.z / 0.165 + 0.5) - 0.5));
          col = col * (0.42 + 0.62 * plankSeam) + lookAlbedo * vec3f(0.016, 0.020, 0.026) * plankSeam;
        }
      }

      // Wet central porch walkway & road curb reflection streak (x ~ 27.7, z ~ 34.5..41.5)
      if (n.y > 0.85 && o.world.y < 0.25) {
        let dxWalk = (o.world.x - 27.7);
        let dzWalk = (o.world.z - 35.2);
        if (dzWalk > -0.5 && dzWalk < 7.2 && abs(dxWalk) < 2.2) {
          let streak = exp(-(dxWalk * dxWalk) / 0.55) * exp(-max(0.0, dzWalk) * 0.34);
          let grit = 0.65 + 0.7 * hash2(floor(o.world.xz * 28.0));
          col += vec3f(0.055, 0.052, 0.044) * streak * grit * LK.u6.y;
        }
      }

      // Volumetric flashlight air haze + wet road/floor beam scatter (driven by real 3D flashlight cone in lights[1] or sight row 0)
      if ((LK.u5.w > 1.0 || LK.u15.w > 0.01) && u32(F.screen.z) > 0u && lights[0].color.w <= 0.001 && o.world.y < 2.1) {
        let hasDynFlash = u32(F.screen.z) > 1u && lights[1].cone.w > 0.5 && lights[1].extra.w < -0.5;
        let flashActive = select(true, lights[1].color.w > 0.001, hasDynFlash);
        if (flashActive) {
          let pPos = lights[0].pos.xz;
          let handOrigin = select(pPos + vec2f(cos(F.effects.x), sin(F.effects.x)) * 0.24, lights[1].pos.xz, hasDynFlash);
          let aimDir = select(vec2f(cos(F.effects.x), sin(F.effects.x)), lights[1].cone.xy, hasDynFlash);
          let fSlot = select(0u, 1u, hasDynFlash);
          let fHeight = select(lights[0].pos.y, lights[1].pos.y, hasDynFlash);
          let dv0 = o.world.xz - handOrigin;
          let d0 = length(dv0);
          let along = dot(dv0, aimDir);
          let perp = abs(dv0.x * (-aimDir.y) + dv0.y * aimDir.x);
          let maxR = select(13.5, max(8.5, lights[1].pos.w * 1.25), hasDynFlash);
          let inHouse = pPos.y < 35.0;
          // Close interior hallway runner spill right around the survivor's feet & hand
          if (inHouse && o.world.y < 0.35 && d0 < 2.6 && along > -2.2) {
            let footSpill = exp(-(perp * perp) / 0.65) * exp(-(d0 * d0) / 3.2);
            col += lookAlbedo * vec3f(0.32, 0.22, 0.12) * footSpill;
            lookFlashIrradiance = max(lookFlashIrradiance, clamp(footSpill * 1.15, 0.0, 0.88));
          }
          if (along > 0.05 && d0 < maxR) {
            let halfW = 0.20 + along * 0.34;
            let beamMask = exp(-(perp * perp) / (halfW * halfW * 0.72)) * smoothstep(halfW * 1.52, halfW * 0.26, perp);
            if (beamMask > 0.001) {
              let vis0 = shadowAt(fSlot, handOrigin, fHeight, 0.05, o.world.xz + n.xz * 0.04, o.world.y);
              let distFade = pow(max(0.0, 1.0 - d0 / maxR), 1.25) / (1.0 + d0 * 0.16);
              let hotSpot = exp(-d0 * d0 * 0.55) * 0.65;
              let hazeCol = select(vec3f(0.095, 0.088, 0.072), vec3f(0.115, 0.092, 0.064), inHouse);
              let gritSpec = 0.75 + 0.5 * noise2(o.world.xz * 18.0);
              let plankMod = select(1.0, 0.48 + 0.62 * smoothstep(0.0, 0.08, abs(fract(o.world.z / 0.165 + 0.5) - 0.5)), inHouse && n.y > 0.8);
              col += (lookAlbedo * 0.45 + hazeCol) * (distFade + hotSpot) * beamMask * vis0 * gritSpec * plankMod * (max(LK.u5.w, 1.0) * 0.75);
              lookFlashIrradiance = max(lookFlashIrradiance, clamp((distFade * 1.6 + hotSpot) * beamMask * vis0 * 2.2, 0.0, 1.0));
            }
          }
        }
      }
    }

    // Painterly gouache twilight choreography (retains real shingle/plank/stone/furniture detail & AO while lifting shadows to periwinkle gouache & warm peach-gold pools)
    if (i32(round(LK.u14.w)) == 2 || (LK.u10.w > 0.35 && LK.u10.y >= 2.0)) {
      // Multi-scale cell brush strokes so flat surfaces read as hand-painted gouache dabs
      let warp = vec2f(noise2(o.world.xz * 2.8 + 1.3) - 0.5, noise2(o.world.xz * 2.8 + 7.9) - 0.5) * 0.35;
      let brushCell = floor((o.world.xz + warp) * 3.6);
      let cellTone = (hash2(brushCell) - 0.5) * 0.22;
      let dab = noise2(o.world.xz * 4.5 + vec2f(o.world.y * 2.1, 3.7)) - 0.5;
      let dabBroad = noise2(o.world.xz * 1.15 + vec2f(7.1, 2.3)) - 0.5;
      let brushStroke = cellTone + dab * 0.16 + dabBroad * 0.14;
      let isIn = interior(o.world.xz) && o.world.y < 2.8;
      let fData = floorData(o.world.xz);
      let ao = 1.0 - fData.r * 0.82 * (1.0 - smoothstep(0.0, 1.1, o.world.y));
      let inCutawayView = F.eye.y < 34.0;
      let extScale = select(1.0, 0.28, inCutawayView);

      if (!isIn) {
        var gouacheAlbedo = lookAlbedo * (1.0 + brushStroke);
        if (mat == 2) {
          // Window curtains & lamp bulbs in Painterly: warm glowing peach-gold gouache
          col = mix(col, vec3f(1.75, 1.12, 0.42) * (0.85 + 0.3 * extScale), clamp(LK.u10.w, 0.0, 1.0));
        } else if (mat == 6) {
          // Window glass: warm golden-peach reflection
          col = mix(col, vec3f(1.35, 0.88, 0.36) * (0.75 + 0.25 * extScale), clamp(LK.u10.w * 0.7, 0.0, 1.0));
          alpha = max(alpha, 0.55 * clamp(LK.u10.w, 0.0, 1.0));
        } else {
        if (mat == 20) {
          let k = i32(round(o.aux));
          if (k == 1) {
            // Street asphalt: mottled periwinkle-lavender gouache brush dabs (#5f6c96)
            gouacheAlbedo = mix(lookAlbedo * vec3f(1.25, 1.42, 2.25), vec3f(0.105, 0.132, 0.248), 0.48) * (1.0 + brushStroke * 1.35);
          } else if (k == 2) {
            // Sidewalk concrete: keep slab expansion joints crisp, warm periwinkle-cream stone
            let jx = smoothstep(0.0, 0.035, abs(fract(o.world.x / 1.6 + 0.5) - 0.5));
            let jz = smoothstep(0.0, 0.035, abs(fract(o.world.z / 1.6 + 0.5) - 0.5));
            let joint = 0.55 + 0.45 * (jx * jz);
            gouacheAlbedo = lookAlbedo * vec3f(1.22, 1.28, 1.62) * joint * (1.0 + brushStroke * 0.75);
          } else if (k == 6) {
            // Front cobblestone walk: accentuate individual rounded stone pavers & recessed joints
            gouacheAlbedo = lookAlbedo * vec3f(1.58, 1.32, 0.98) * (1.0 + brushStroke * 0.85);
          } else if (k == 0 || k == 5) {
            // Lawn turf & garden beds: clumped Ghibli sage-moss & sunlit olive brush dabs
            let lushShift = mix(vec3f(0.76, 1.18, 0.64), vec3f(1.26, 1.46, 0.62), clamp(0.5 + dabBroad * 1.4 + cellTone * 1.8, 0.0, 1.0));
            gouacheAlbedo = lookAlbedo * lushShift * (1.08 + brushStroke * 0.85);
          } else if (k == 3) {
            gouacheAlbedo = lookAlbedo * vec3f(1.26, 1.28, 1.46) * (1.0 + brushStroke);
          }
        } else if (mat == 21) {
          // Hand-painted roof shingle tiles: crisp staggered courses & tile-to-tile gouache value steps
          let sRow = floor(o.world.z / 0.26);
          let sCol = floor(o.world.x / 0.42 + fract(sRow * 0.5));
          let tileVar = (hash2(vec2f(sCol, sRow)) - 0.5) * 0.34;
          let rowLine = smoothstep(0.0, 0.14, fract(o.world.z / 0.26));
          let colLine = smoothstep(0.0, 0.09, abs(fract(o.world.x / 0.42 + fract(sRow * 0.5) + 0.5) - 0.5));
          let tileSeam = 0.52 + 0.48 * (rowLine * colLine);
          gouacheAlbedo = lookAlbedo * vec3f(1.38, 1.58, 2.45) * (1.0 + tileVar) * tileSeam;
        } else if (mat == 22) {
          // Trees & bushes: 3-band Ghibli foliage clusters with crisp leaf-clump shadows
          let crownH = clamp((o.world.y - 0.3) / 3.6, 0.0, 1.0);
          let sunSide = clamp(n.y * 0.55 - n.x * 0.25 + 0.35 + dab * 0.35, 0.0, 1.0);
          let bandF = lookQuantizeDiffuse(clamp(crownH * 0.5 + sunSide * 0.65, 0.0, 1.0), 0.18, max(3.0, LK.u10.y), LK.u10.z);
          let folTint = mix(vec3f(0.52, 0.92, 0.64), vec3f(1.46, 1.68, 0.68), bandF);
          gouacheAlbedo = lookAlbedo * folTint * (1.10 + cellTone * 0.9);
        } else if (mat == 4) {
          // Exterior clapboard siding: distinct horizontal lap courses
          let lap = 0.72 + 0.28 * smoothstep(0.0, 0.22, fract(o.world.y / 0.18));
          gouacheAlbedo = lookAlbedo * vec3f(1.42, 1.36, 1.32) * lap;
        } else if (mat == 5) {
          gouacheAlbedo = vec3f(0.112, 0.140, 0.258) * (1.0 + brushStroke);
        }

        // Broad peach-gold gouache glow spilling from front windows (24.5, 35.5), (34.25, 35.5) and porch (27.7, 36.8)
        let dWinL = length(o.world.xz - vec2f(24.5, 35.8));
        let dWinR = length(o.world.xz - vec2f(34.25, 35.8));
        let dPorch = length((o.world.xz - vec2f(27.7, 37.2)) * vec2f(0.82, 0.58));
        let spillL = exp(-(dWinL * dWinL) / 9.5);
        let spillR = exp(-(dWinR * dWinR) / 9.5);
        let spillP = exp(-(dPorch * dPorch) / 16.5);
        let warmSpill = clamp(spillL * 0.75 + spillR * 0.75 + spillP * 1.05, 0.0, 1.35) * step(o.world.y, 2.75);
        let peachLight = vec3f(1.28, 0.82, 0.36) * warmSpill * (0.55 + 0.45 * extScale);

        // Soft flower-bush blossoms along the house foundation (z ~ 35.0..36.8)
        if (mat == 22 && o.world.z > 34.8 && o.world.z < 37.2 && o.world.x > 22.0 && o.world.x < 36.8) {
          let blossom = smoothstep(0.24, 0.44, hash2(floor(o.world.xz * 5.5)));
          gouacheAlbedo = mix(gouacheAlbedo, vec3f(0.68, 0.54, 0.26), blossom * 0.65);
        }

        let hemiN = 0.62 + 0.38 * clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
        let skyAmb = vec3f(0.62, 0.68, 0.90) * hemiN * ao * extScale;
        let paintedExt = col * 0.32 + gouacheAlbedo * (skyAmb + peachLight * 1.38) + peachLight * 0.045 * ao;
        col = mix(col, paintedExt, clamp(LK.u10.w, 0.0, 1.0));
        }
      } else {
        // Interior cutaway gouache: crisp honey-sienna wood plank seams, two-tone wainscot walls, and cozy golden room pools
        var intAlbedo = lookAlbedo * (1.0 + brushStroke * 0.65);
        if (n.y > 0.75 && o.world.y < 0.28) {
          let row = floor(o.world.z / 0.20);
          let plank = floor((o.world.x + fract(row * 0.37) * 1.4) / 1.45);
          let bTone = (hash2(vec2f(row, plank)) - 0.5) * 0.28;
          let seamZ = smoothstep(0.0, 0.08, abs(fract(o.world.z / 0.20 + 0.5) - 0.5));
          let seamX = smoothstep(0.0, 0.04, abs(fract((o.world.x + fract(row * 0.37) * 1.4) / 1.45 + 0.5) - 0.5));
          let plankJoint = 0.42 + 0.58 * (seamZ * seamX);
          intAlbedo = lookAlbedo * vec3f(1.22, 0.84, 0.46) * (1.0 + bTone) * plankJoint;
        } else if (mat == 4) {
          let isUpper = smoothstep(0.88, 1.12, o.world.y);
          let wainscot = lookAlbedo * vec3f(0.52, 0.62, 0.52) * (1.0 + brushStroke * 0.8);
          let upperWall = lookAlbedo * vec3f(1.08, 0.94, 0.80) * (1.0 + brushStroke * 0.8);
          intAlbedo = mix(wainscot, upperWall, isUpper);
        } else if (mat == 0) {
          let furnShade = 0.52 + 0.48 * clamp(n.y * 0.6 + 0.4, 0.0, 1.0);
          intAlbedo = lookAlbedo * vec3f(0.95, 0.90, 0.78) * furnShade;
        }
        let dNW = length(o.world.xz - vec2f(25.2, 25.4));
        let dSW = length(o.world.xz - vec2f(23.6, 32.6));
        let dSE = length(o.world.xz - vec2f(31.5, 30.6));
        let dNE = length(o.world.xz - vec2f(30.4, 26.8));
        let dHall = length(o.world.xz - vec2f(27.7, 29.5));
        let warmPool = exp(-(dNW * dNW) / 8.5) * 0.75
          + exp(-(dSW * dSW) / 7.5) * 0.65
          + exp(-(dSE * dSE) / 9.5) * 0.82
          + exp(-(dNE * dNE) / 8.0) * 0.62
          + exp(-(dHall * dHall) / 12.0) * 0.35;
        let hemiIn = 0.58 + 0.42 * clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
        let roomLight = (vec3f(0.24, 0.22, 0.22) + vec3f(0.78, 0.50, 0.22) * warmPool) * hemiIn * ao;
        let paintedInt = col * 0.38 + intAlbedo * roomLight + vec3f(0.032, 0.018, 0.006) * warmPool * ao;
        col = mix(col, paintedInt, clamp(LK.u10.w, 0.0, 1.0));
      }
      if (mat == 9) {
        col = mix(col, vec3f(0.042, 0.050, 0.082) * (1.0 + dab * 0.16), clamp(LK.u10.w, 0.0, 1.0));
      }
      if (mat == 3) {
        col = mix(col, vec3f(1.55, 1.02, 0.42), clamp(LK.u10.w * 0.85, 0.0, 1.0));
      }
    }
  }\n`,
  })

  return base
    .replace(
      "let diffuse = max((ndl + wrap) / (1.0 + wrap), 0.0);",
      `let useLookLight = LK.u11.w > 0.5;
    let isNoirPreset = useLookLight && i32(round(LK.u14.w)) == 1;
    let effWrap = select(wrap, wrap + LK.u10.x, useLookLight);
    let effBands = select(0.0, LK.u10.y, useLookLight);
    let effSoft = select(0.18, LK.u10.z, useLookLight);
    let diffuse = lookQuantizeDiffuse(ndl, effWrap, effBands, effSoft);`,
    )
    .replace(
      "out.diff += L.color.rgb * att * (diffuse * vis +",
      `let isDynFlash = L.cone.w > 0.5 && L.extra.w < -0.5;
    var lCol = select(L.color.rgb, lookPracticalColor(L.color.rgb, LK.u5.x) * LK.u5.y, useLookLight && !isDynFlash);
    if (isDynFlash && useLookLight) {
      lCol = vec3f(1.06, 0.96, 0.84) * max(LK.u5.y, 1.35);
      let fIrr = clamp(att * vis * (0.55 + 0.65 * max(ndl, 0.0)) * 2.8, 0.0, 1.0);
      lookFlashIrradiance = max(lookFlashIrradiance, fIrr);
    } else if (isNoirPreset) {
      // Noir lighting choreography: dim outer streetlamps (hl > 3.2), living-room SW lamp & north-kitchen lamp;
      // cool silvery-blue NW bedroom lamp; warm amber SE dining lamp & focused porch bulb.
      if (hl > 3.2) {
        lCol *= 0.08;
      } else if (L.cone.w < -0.5) {
        let isNWBedroom = lp.x < 27.5 && lp.y < 28.5;
        let isSEDining = lp.x > 28.0 && lp.y > 28.5;
        if (isNWBedroom) {
          lCol = vec3f(0.58, 0.76, 1.08) * 0.85;
        } else if (isSEDining) {
          lCol = vec3f(1.22, 0.68, 0.24) * 1.15;
        } else {
          lCol *= 0.06;
        }
      } else if (L.cone.w > 0.5 && lp.x < 26.5) {
        // Left front window unlit in Noir
        lCol *= 0.08;
      }
    }
    out.diff += lCol * att * (diffuse * vis +`,
    )
    .replace("out.spec += L.color.rgb * att * s * vis;", "out.spec += lCol * att * s * vis;")
    .replace(
      "return out;\n}",
      `if (LK.u11.w > 0.5 && (LK.u5.w > 1.0 || LK.u15.w > 0.01) && count > 0u && lights[0].color.w <= 0.001) {
    // Survival-horror Noir player flashlight cone using real dynamic cone in lights[1] or polar sight slot 0
    let hasDynFlash = count > 1u && lights[1].cone.w > 0.5 && lights[1].extra.w < -0.5;
    let flashActive = select(true, lights[1].color.w > 0.001, hasDynFlash);
    if (flashActive) {
      let pPos = lights[0].pos.xz;
      let handOrigin = select(pPos + vec2f(cos(F.effects.x), sin(F.effects.x)) * 0.24, lights[1].pos.xz, hasDynFlash);
      let aimDir = select(vec2f(cos(F.effects.x), sin(F.effects.x)), lights[1].cone.xy, hasDynFlash);
      let fSlot = select(0u, 1u, hasDynFlash);
      let fHeight = select(lights[0].pos.y, lights[1].pos.y, hasDynFlash);
      let dv0 = world.xz - handOrigin;
      let d0 = length(dv0);
      let maxR = select(13.5, max(8.5, lights[1].pos.w * 1.25), hasDynFlash);
      if (d0 > 0.08 && d0 < maxR) {
        let along = dot(dv0, aimDir);
        let perp = abs(dv0.x * (-aimDir.y) + dv0.y * aimDir.x);
        if (along > 0.0) {
          let halfW = 0.20 + along * 0.34;
          let beamProfile = exp(-(perp * perp) / (halfW * halfW * 0.72)) * smoothstep(halfW * 1.52, halfW * 0.30, perp);
          if (beamProfile > 0.001) {
            let vis0 = shadowAt(fSlot, handOrigin, fHeight, 0.05, plan, world.y);
            let fade0 = pow(max(0.0, 1.0 - d0 / maxR), 1.25) / (1.0 + d0 * 0.16);
            let l30 = normalize(vec3f(handOrigin.x, fHeight - 0.18, handOrigin.y) - world);
            let ndl0 = lookQuantizeDiffuse(dot(n, l30), wrap + LK.u10.x, LK.u10.y, LK.u10.z);
            let torchStr = clamp((max(LK.u5.w, 1.2) - 0.65) * 1.65, 0.0, 2.6) * beamProfile * fade0 * vis0;
            // Natural warm-halogen white beam so illuminated surfaces reveal their true rich colours
            let torchCol = vec3f(1.06, 0.96, 0.84);
            out.diff += torchCol * torchStr * (0.42 + 0.58 * ndl0);
            lookFlashIrradiance = max(lookFlashIrradiance, clamp(beamProfile * fade0 * vis0 * 2.8, 0.0, 1.0));
            if (shin > 0.0) {
              let h0 = normalize(l30 + V);
              let s0 = pow(max(dot(n, h0), 0.0), shin) * (shin + 2.0) * 0.006;
              out.spec += torchCol * torchStr * s0 * 1.4;
            }
          }
        }
      }
    }
  }
  return out;
}`,
    )
    .replace(
      "col = albedo * (amb + direct + moon)",
      `if (lookUseAfter) {
      amb *= LK.u4.x * LK.u4.yzw;
    }
    let effMoon = select(moon, moon * LK.u5.z, lookUseAfter);
    col = albedo * (amb + direct + effMoon)`,
    )
    .replace(
      "return vec4f(select(col * a, col, mat == 22 && o.aux >= -1.5), a);",
      `let outRgb = select(col * a, col, mat == 22 && o.aux >= -1.5);
  let outAlpha = select(a, 1.0 - clamp(lookFlashIrradiance, 0.0, 1.0), a >= 0.999 && lookUseAfter);
  return vec4f(outRgb, outAlpha);`,
    )
}

/**
 * Opt-in Look-enabled post composite shader generator.
 * Binds `GradeAndLook` (8-float header + 64-float `LookUniforms`) at `@group(0) @binding(4)`.
 * Default `postShader` remains untouched for bit-exact identity under "Current".
 */
export const makeLookPostShader = (finish?: PostFinishOptions): string => /* wgsl */ `
${lookStructWgsl}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> P: vec4f;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;

struct GradeAndLook {
  G: vec4f,
  pad: vec4f,
  L: LookUniforms,
}
@group(0) @binding(4) var<uniform> GL: GradeAndLook;
${postCommonWgsl}

fn kuwaharaPost(uv: vec2f, texel: vec2f, strength: f32) -> vec3f {
  let center = clean(textureSampleLevel(src, samp, uv, 0.0)).rgb;
  if (strength <= 0.01) { return center; }
  let pxCoord = uv / max(texel, vec2f(1e-5));
  let dabAng = hash(floor(pxCoord * 0.28)) * 6.2831853;
  let dabWarp = vec2f(cos(dabAng), sin(dabAng)) * texel * (0.85 * strength);
  let uvW = clamp(uv + dabWarp, vec2f(0.002), vec2f(0.998));

  let r1 = texel * (0.9 + strength * 0.7);
  let r2 = texel * (1.6 + strength * 1.1);
  let lw = vec3f(0.2126, 0.7152, 0.0722);

  var m = array<vec3f, 4>(center, center, center, center);
  var s2 = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
  let lC = dot(center, lw);
  for (var q = 0; q < 4; q++) {
    let sx = select(-1.0, 1.0, (q & 1) != 0);
    let sy = select(-1.0, 1.0, (q & 2) != 0);
    let d = vec2f(sx, sy);
    let c1 = clean(textureSampleLevel(src, samp, clamp(uvW + d * r1, vec2f(0.002), vec2f(0.998)), 0.0)).rgb;
    let c2 = clean(textureSampleLevel(src, samp, clamp(uvW + vec2f(d.x * r2.x, d.y * r1.y), vec2f(0.002), vec2f(0.998)), 0.0)).rgb;
    let c3 = clean(textureSampleLevel(src, samp, clamp(uvW + vec2f(d.x * r1.x, d.y * r2.y), vec2f(0.002), vec2f(0.998)), 0.0)).rgb;
    let c4 = clean(textureSampleLevel(src, samp, clamp(uvW + d * r2, vec2f(0.002), vec2f(0.998)), 0.0)).rgb;
    let mean = (center + c1 + c2 + c3 + c4) * 0.2;
    let l1 = dot(c1, lw); let l2 = dot(c2, lw); let l3 = dot(c3, lw); let l4 = dot(c4, lw);
    let lm = (lC + l1 + l2 + l3 + l4) * 0.2;
    let v = (lC - lm)*(lC - lm) + (l1 - lm)*(l1 - lm) + (l2 - lm)*(l2 - lm) + (l3 - lm)*(l3 - lm) + (l4 - lm)*(l4 - lm);
    m[q] = mean;
    s2[q] = v;
  }
  let w0 = 1.0 / (1.0 + s2[0] * 1400.0);
  let w1 = 1.0 / (1.0 + s2[1] * 1400.0);
  let w2 = 1.0 / (1.0 + s2[2] * 1400.0);
  let w3 = 1.0 / (1.0 + s2[3] * 1400.0);
  let painted = (m[0] * w0 + m[1] * w1 + m[2] * w2 + m[3] * w3) / (w0 + w1 + w2 + w3);
  return mix(center, painted, clamp(strength, 0.0, 1.0));
}

@fragment fn composite(o: VO) -> @location(0) vec4f {
  let G = GL.G;
  let L = GL.L;
  let uv = o.uv;
  let dims = vec2f(textureDimensions(src));
  let texel = 1.0 / max(dims, vec2f(1.0));
  let fromC = uv - 0.5;

  let compareMode = i32(round(L.u12.w));
  let wipeSplit = L.u13.w;
  let useLook = select(compareMode == 1, uv.x >= wipeSplit, compareMode == 2) && L.u11.w > 0.5;

  let baseCA = ${finish ? finish.chromatic.toFixed(4) : "0.012"};
  let baseBloom = ${finish ? finish.bloom.toFixed(4) : "0.32"};
  let baseVig = ${finish ? finish.vignette.toFixed(4) : "0.45"};
  let baseGrain = ${finish ? finish.grain.toFixed(4) : "0.022"};
  let baseHuePres = ${finish?.huePreserve ? finish.huePreserve.toFixed(4) : "0.0"};
  let baseShadowLift = ${finish?.shadowLift === undefined ? "1.0" : finish.shadowLift.toFixed(4)};

  let bloom = textureSampleLevel(bloomTex, samp, uv, 0.0).rgb;
  ${finish?.diagnostics ? `if (G.y > 0.5) {
    var diagHdr = clean(textureSampleLevel(src, samp, uv, 0.0)).rgb;
    if (i32(G.y) == 5) { diagHdr = bloom * baseBloom; }
    return vec4f(pow(max(diagHdr, vec3f(0.0)), vec3f(1.0 / 2.2)), 1.0);
  }` : ""}

  if (!useLook) {
    let ca = fromC * dot(fromC, fromC) * baseCA;
    var hdr = vec3f(
      clean(textureSampleLevel(src, samp, uv + ca, 0.0)).r,
      clean(textureSampleLevel(src, samp, uv, 0.0)).g,
      clean(textureSampleLevel(src, samp, uv - ca, 0.0)).b,
    );
    hdr = hdr + bloom * ${finish?.halation ? `(baseBloom + vec3f(1.08, 0.36, 0.12) * ${finish.halation.toFixed(4)})` : "baseBloom"};
    var c = aces(hdr * G.w);
    if (baseHuePres > 0.0) {
      let exposed = max(hdr * G.w, vec3f(0.0));
      let peak = max(exposed.r, max(exposed.g, exposed.b));
      c = mix(c, exposed * (aces(vec3f(peak)).r / max(peak, 0.0001)), baseHuePres);
    }
    let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
    c = mix(vec3f(l), c, ${finish?.saturation !== undefined ? `${finish.saturation.toFixed(4)} * ` : ""}(1.0 - G.y));
    c += ${finish?.shadowLiftColor ? `vec3f(${finish.shadowLiftColor.map(v => v.toFixed(4)).join(", ")})` : "vec3f(0.006, 0.011, 0.028)"} * baseShadowLift * (1.0 - smoothstep(0.0, 0.25, l));
    c *= mix(${finish?.shadowTint ? `vec3f(${finish.shadowTint.map(v => v.toFixed(4)).join(", ")})` : "vec3f(0.93, 0.97, 1.06)"}, ${finish?.highlightTint ? `vec3f(${finish.highlightTint.map(v => v.toFixed(4)).join(", ")})` : "vec3f(1.04, 1.0, 0.95)"}, smoothstep(0.2, 0.8, l));
    let v = length(fromC * vec2f(1.0, 0.8));
    c *= mix(1.0, baseVig, smoothstep(0.32, 0.85, v));
    c = mix(c, vec3f(0.55, 0.05, 0.06), G.z * smoothstep(0.25, 0.85, v));
    c = pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2));
    let px = o.pos.xy;
    let grain = hash(px + fract(G.x * 13.7) * 1000.0) + hash(px * 1.37 + fract(G.x * 7.3) * 500.0) - 1.0;
    ${finish?.shadowLiftColor ? `let midMask = smoothstep(0.02, 0.20, l) * (1.0 - smoothstep(0.75, 1.0, l));
    c += grain * baseGrain * (0.25 + 0.75 * midMask);
    let ign = fract(52.9829189 * fract(dot(floor(px), vec2f(0.06711056, 0.00583715))));
    c += (ign - 0.5) / 255.0 * step(0.001, l);` : `c += grain * baseGrain * (1.0 - l * 0.6);`}
    if (compareMode == 2) {
      let line = 1.0 - smoothstep(texel.x * 1.2, texel.x * 2.8, abs(uv.x - wipeSplit));
      c = mix(c, vec3f(0.92, 0.96, 1.0), line * 0.85);
    }
    return vec4f(c, 1.0);
  }

  // Active Look composite
  let centerSamp = clean(textureSampleLevel(src, samp, uv, 0.0));
  let flashMask = clamp(1.0 - centerSamp.a, 0.0, 1.0);
  let caAmt = baseCA + L.u9.w * 0.016;
  let ca = fromC * dot(fromC, fromC) * caAmt;
  var hdr: vec3f;
  if (L.u10.w > 0.01) {
    hdr = kuwaharaPost(uv, texel, L.u10.w);
  } else if (caAmt > 0.0005) {
    hdr = vec3f(
      clean(textureSampleLevel(src, samp, clamp(uv + ca, vec2f(0.001), vec2f(0.999)), 0.0)).r,
      centerSamp.g,
      clean(textureSampleLevel(src, samp, clamp(uv - ca, vec2f(0.001), vec2f(0.999)), 0.0)).b,
    );
  } else {
    hdr = centerSamp.rgb;
  }

  // Ink / structural edge outlines
  if (L.u11.x > 0.001) {
    let stepUv = texel * L.u11.y;
    let cR = clean(textureSampleLevel(src, samp, clamp(uv + vec2f(stepUv.x, 0.0), vec2f(0.001), vec2f(0.999)), 0.0)).rgb;
    let cL = clean(textureSampleLevel(src, samp, clamp(uv - vec2f(stepUv.x, 0.0), vec2f(0.001), vec2f(0.999)), 0.0)).rgb;
    let cU = clean(textureSampleLevel(src, samp, clamp(uv - vec2f(0.0, stepUv.y), vec2f(0.001), vec2f(0.999)), 0.0)).rgb;
    let cD = clean(textureSampleLevel(src, samp, clamp(uv + vec2f(0.0, stepUv.y), vec2f(0.001), vec2f(0.999)), 0.0)).rgb;
    let grad = (length(cR - cL) + length(cU - cD)) / max(0.08, length(hdr) + 0.12);
    let edge = smoothstep(0.32, 0.95, grad) * clamp(L.u11.x, 0.0, 1.2);
    let inkCol = vec3f(0.03, 0.035, 0.055) * 0.66;
    hdr = mix(hdr, inkCol, clamp(edge, 0.0, 0.85));
  }

  var c = lookGradeColor(
    L,
    hdr * G.w,
    bloom,
    uv,
    o.pos.xy,
    G.x,
    clamp(L.u7.w * 0.35, 0.0, 1.0),
    baseBloom,
    baseVig,
    baseHuePres,
    flashMask,
  );
  let v = length(fromC * vec2f(1.0, 0.8));
  c = mix(c, vec3f(0.55, 0.05, 0.06), G.z * smoothstep(0.25, 0.85, v));
  c = pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2));
  if (compareMode == 2) {
    let line = 1.0 - smoothstep(texel.x * 1.2, texel.x * 2.8, abs(uv.x - wipeSplit));
    c = mix(c, vec3f(0.92, 0.96, 1.0), line * 0.85);
  }
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}
`
