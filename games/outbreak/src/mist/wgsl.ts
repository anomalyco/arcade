import { foliageWindDeclarationsWgsl } from "@arcade/kit/gpu/foliage"
import { fogScatterVolume } from "@arcade/kit/gpu/fog-scatter"
import { volumeParamsWgsl } from "@arcade/kit/gpu/volume-pass"
import { outbreakLightingStructWgsl } from "../lighting"

/**
 * Where the mist pools (the fog bank's `bankMask`): none inside the resident buildings (their rects, `OL.bldRects`,
 * which also keeps it off the roofs), banked up against their walls, lying in hollows across the yards (a static,
 * ground-fixed noise, so the hollows stay put while the billows drift through them) and thin to nothing elsewhere,
 * and in a narrow line in the gutters along the kerbs of the repeating block's roads (`ground.ts`: kerbs at 40 and 48
 * across each 38..50 road band) with the open road clear. Thin mist also lies lower: the layer's top rises from 30 %
 * of its height where the mask is thin to all of it in the pools, so pools read as standing mist from the camera's
 * angle rather than a tint. Weights in the slot's params (`volumeParams[0]`: yards, gutters, roads, on;
 * `volumeParams[1]`: walls, hollows, 1 / hollow size, wall reach).
 */
const mistMaskWgsl = /* wgsl */ `
fn outbreakMistMask(p: vec3f) -> f32 {
  let k = volumeParams[0];
  let w = volumeParams[1];
  let nBld = i32(OL.win.w);
  var dWall = 1e3;
  for (var i = 0; i < 8; i++) {
    if (i >= nBld) { break; }
    let b = OL.bldRects[i];
    if (all(p.xz > b.xy - 0.15) && all(p.xz < b.zw + 0.15)) { return 0.0; }
    dWall = min(dWall, length(max(max(b.xy - p.xz, p.xz - b.zw), vec2f(0.0))));
  }
  let q = p.xz - floor(p.xz / 96.0) * 96.0;
  let roadX = q.x > 37.9 && q.x < 50.1;
  let roadZ = q.y > 37.9 && q.y < 50.1;
  var m = 0.0;
  if (!roadX && !roadZ) {
    let hollow = smoothstep(0.5, 0.64, fogNoise2(p.xz * w.z + vec2f(13.1, 7.7)));
    let wall = exp(-dWall * dWall / max(w.w * w.w, 1e-3));
    m = k.x * mix(1.0, 0.05 + 0.95 * hollow, w.y) + w.x * wall;
  } else {
    var g = 0.0;
    if (roadX) { let e = min(abs(q.x - 40.3), abs(q.x - 47.7)); g = max(g, exp(-e * e * 9.0)); }
    if (roadZ) { let e = min(abs(q.y - 40.3), abs(q.y - 47.7)); g = max(g, exp(-e * e * 9.0)); }
    // Pockets along the gutter, not an unbroken line.
    m = k.z + k.y * g * smoothstep(0.3, 0.65, fogNoise2(p.xz * 0.3 + vec2f(3.3, 5.9)));
  }
  if (m <= 0.002) { return 0.0; }
  let h = (p.y - FOG.medium.z) / FOG.bank.y;
  let lid = 0.3 + 0.7 * clamp(m, 0.0, 1.0);
  return m * (1.0 - smoothstep(lid * 0.45, lid, h));
}`

/**
 * Slot 2 of Outbreak's volume shaders: the kit fog shared by the lamp fog (Lab › Lamp fog) and the low mist, with the
 * bank and the street lamp lens airlight compiled in. With the bank off and no lens lamps it renders exactly the plain
 * lamp fog; volume slots compile on first use, so Today (both off) compiles none of it.
 */
export const outbreakFogVolume = fogScatterVolume({
  atmosphere: true,
  street: true,
  declarations: `${foliageWindDeclarationsWgsl}\n${outbreakLightingStructWgsl}\n${volumeParamsWgsl}\n${mistMaskWgsl}`,
  bankMask: "outbreakMistMask(p)",
})
