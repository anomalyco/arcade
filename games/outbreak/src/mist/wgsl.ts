import { foliageWindDeclarationsWgsl } from "@arcade/kit/gpu/foliage"
import { fogScatterVolume } from "@arcade/kit/gpu/fog-scatter"
import { volumeParamsWgsl } from "@arcade/kit/gpu/volume-pass"
import { outbreakLightingStructWgsl } from "../lighting"

/**
 * Where the mist pools (the fog bank's `bankMask`): none inside the resident buildings (their rects, `OL.bldRects`),
 * thick in yards, thin over the carriageway and sidewalks of the repeating block's roads (`ground.ts`: kerbs at 40 and
 * 48 across each 38..50 road band) and thickest in the gutters along the kerbs. Weights in the slot's params
 * (`volumeParams[0]`: yards, gutters, roads).
 */
const mistMaskWgsl = /* wgsl */ `
fn outbreakMistMask(p: vec3f) -> f32 {
  let k = volumeParams[0];
  let nBld = i32(OL.win.w);
  for (var i = 0; i < 8; i++) {
    if (i >= nBld) { break; }
    let b = OL.bldRects[i];
    if (all(p.xz > b.xy - 0.15) && all(p.xz < b.zw + 0.15)) { return 0.0; }
  }
  let q = p.xz - floor(p.xz / 96.0) * 96.0;
  let roadX = q.x > 37.9 && q.x < 50.1;
  let roadZ = q.y > 37.9 && q.y < 50.1;
  if (!roadX && !roadZ) { return k.x; }
  var g = 0.0;
  if (roadX) { let e = min(abs(q.x - 40.0), abs(q.x - 48.0)); g = max(g, exp(-e * e * 5.0)); }
  if (roadZ) { let e = min(abs(q.y - 40.0), abs(q.y - 48.0)); g = max(g, exp(-e * e * 5.0)); }
  return k.z + k.y * g;
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
