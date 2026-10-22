import { planBounceSceneWgsl, type PlanBounceShader } from "@arcade/kit/gpu/gi/plan-bounce"
import { blindCookieWgsl } from "../blind-cookie"
import { COLLEAGUES } from "../world"
import { LOOK_CONTACT } from "./contact"
import { BASEMENT_X } from "../descent/state"

/** Scanned surface layers in `look/surfaces.webp` (r albedo detail ×2, gb normal xy, a 0.5 + roughness/2). */
export const LOOK_LAYERS = { fabric: 0, ceiling: 1, carpet: 2, plastic: 3, contact: 4 } as const
/** Scanned layers in the strip; the contact layer after them is baked at load (`contact.ts`). */
export const LOOK_SCANNED_LAYERS = 4
export const LOOK_LAYER_COUNT = 5
export const LOOK_LAYER_SIZE = 512

const f = (v: number) => v.toFixed(4)
/** Screens that glow onto their bezels: centre, half size (x, y), facing z, colour. */
const screens = [
  ...COLLEAGUES.map(c => `LookScreen(vec3f(${f(c.x)},1.113,${f(c.z - .156)}),vec2f(.174,.128),-1.0,vec3f(1.0,.2,.11))`),
  `LookScreen(vec3f(-0.74,1.18,-5.36),vec2f(.155,.11),1.0,vec3f(.25,1.0,.45))`,
]

/**
 * Scene declarations: the look's custom uniform rows (O.lookA–D, see `OfficeLook.pack`), scanned surface sampling at
 * the kit's detail-array binding, screen glow on bezels, curved CRT glass and the bounce/ceiling terms.
 */
export const lookSceneWgsl = /* wgsl */ `
${planBounceSceneWgsl}
@group(0) @binding(15) var lookTex: texture_2d_array<f32>;
@group(0) @binding(16) var lookSamp: sampler;
struct LookScreen { c: vec3f, half: vec2f, face: f32, color: vec3f }
const LOOK_SCREENS = array<LookScreen, ${screens.length}>(${screens.join(",")});
fn lookOn() -> bool { return O.lookA.x > 0.5; }
/** A scanned layer tiled every \`metres\`, its mip picked from the pixel footprint (no implicit derivatives). */
fn lookScan(uv: vec2f, layer: i32, metres: f32) -> vec4f {
  let lod = clamp(log2(max(officeFootprint * ${LOOK_LAYER_SIZE}.0 / metres, 1e-4)), 0.0, 9.0);
  return textureSampleLevel(lookTex, lookSamp, fract(uv / metres), layer, lod);
}
fn lookStain(p: vec2f) -> f32 {
  let m = officeNoise(vec3f(p * 0.9, 1.7)) * 0.65 + officeNoise(vec3f(p * 2.7, 4.1)) * 0.25 + officeNoise(vec3f(p * 7.1, 9.3)) * 0.1;
  return smoothstep(0.5, 0.74, m);
}
/** Tangent-space normal from a scan, on a plane spanned by t and b. */
fn lookPerturb(n: vec3f, t: vec3f, b: vec3f, s: vec4f, amount: f32) -> vec3f {
  let xy = (s.gb * 2.0 - 1.0) * amount;
  return normalize(n + t * xy.x + b * xy.y);
}
/**
 * Wear in the elevator car (origin x in O.lookD.z), -1 outside it. Fine and placed: darker corners, scuffs along the
 * kick plate, finger smudges round the button panel (right wall, z 9.47–9.74, y 0.86–1.52) and along the rails.
 */
fn carGrime(p: vec3f) -> f32 {
  let lx = p.x - O.lookD.z;
  if (abs(lx) > 1.12 || p.z < 8.9 || p.z > 10.9 || p.y > 2.6) { return -1.0; }
  let corner = exp(-min(1.04 - abs(lx), 10.79 - p.z) / 0.035) * 0.6;
  let floor = exp(-p.y / 0.05) * 0.5;
  // Toe and trolley scuffs: short horizontal strokes on the kick plate.
  let scuff = smoothstep(0.72, 0.9, officeNoise(vec3f((p.z + lx) * 9.0, p.y * 90.0, 4.0))) * (1.0 - smoothstep(0.1, 0.16, p.y)) * 0.7;
  // Fingerprints: small oval smudges, dense round the buttons, sparse along the chair rail.
  let print = smoothstep(0.62, 0.8, officeNoise(vec3f(p.z * 70.0, p.y * 52.0, lx * 3.0)));
  let panel = (1.0 - smoothstep(0.04, 0.14, abs(p.z - 9.6) - 0.13)) * (1.0 - smoothstep(0.04, 0.14, abs(p.y - 1.19) - 0.33)) * step(0.0, lx);
  let rail = 1.0 - smoothstep(0.0, 0.12, abs(p.y - 1.08));
  return clamp(corner + floor + scuff + print * (panel * 0.3 + rail * 0.15), 0.0, 1.0);
}
/** Standing water in the basement aisle (0 dry, 1 wet). */
fn basementWet(p: vec3f) -> f32 {
  let lx = p.x - ${f(BASEMENT_X)};
  let pools = officeNoise(vec3f(p.xz * vec2f(1.6, 0.5), 2.0)) * 0.7 + officeNoise(vec3f(p.xz * 6.0, 7.0)) * 0.3;
  return smoothstep(0.44, 0.47, pools) * (1.0 - smoothstep(0.9, 1.6, abs(lx)));
}
/** What the wet floor mirrors: the lit door at the end (bright, smeared vertically) and the green screen walls. */
fn basementMirror(p: vec3f) -> vec3f {
  let V = normalize(p - F.cam.xyz);
  let R = vec3f(V.x, -V.y, V.z);
  var c = vec3f(0.0);
  if (R.z < -0.01) {
    let h = p + R * ((-16.0 - p.z) / R.z);
    let lx = h.x - ${f(BASEMENT_X)};
    let d = length(p.xz - h.xz);
    let spread = 0.05 + d * 0.04;
    let door = (1.0 - smoothstep(0.6 - spread, 0.6 + spread, abs(lx))) * (1.0 - smoothstep(2.0, 2.5 + d * 0.2, h.y));
    let slit = 1.0 - smoothstep(0.0, spread * 0.6, abs(abs(lx) - 0.58));
    c += vec3f(1.0, 0.5, 0.18) * (door * 0.35 + slit * 0.6) / (1.0 + d * 0.08);
  }
  if (abs(R.x) > 0.05) {
    let wall = ${f(BASEMENT_X)} + sign(R.x) * 1.7;
    let h = p + R * ((wall - p.x) / R.x);
    let bank = 1.0 - smoothstep(0.3, 0.6, abs(fract((h.z - 7.02) / 2.9 + 0.5) - 0.5) * 2.9);
    c += vec3f(0.12, 0.45, 0.24) * bank * smoothstep(0.1, 0.4, h.y) * (1.0 - smoothstep(1.6, 2.2, h.y)) * 0.25 * O.lookC.z;
  }
  let fresnel = 0.03 + 0.97 * pow(1.0 - clamp(-V.y, 0.0, 1.0), 5.0);
  return c * (0.25 + 0.75 * fresnel);
}
fn lookNearestTroffer(z: f32) -> f32 {
  var best = 5.0;
  for (var i = 0; i < 4; i++) { let c = array<f32, 4>(5.0, 0.0, -4.0, -7.0)[i]; if (abs(z - c) < abs(z - best)) { best = c; } }
  return best;
}
/** Screen light on the surrounding bezel: falls off over a few centimetres from the glass edge. */
fn lookBezelGlow(p: vec3f, n: vec3f) -> vec3f {
  var g = vec3f(0.0);
  if (p.y < 0.85 || p.y > 1.45) { return g; }
  for (var i = 0; i < ${screens.length}; i++) {
    var s = LOOK_SCREENS[i];
    if (i == ${screens.length - 1}) { s.color = mix(s.color, vec3f(1.0, 0.2, 0.11), O.lookC.y); }
    let front = (p.z - s.c.z) * s.face;
    if (front < -0.07 || front > 0.02) { continue; }
    let q = abs(p.xy - s.c.xy) - s.half;
    let edge = length(max(q, vec2f(0.0)));
    if (edge > 0.09 || (q.x < 0.0 && q.y < 0.0)) { continue; }
    let facing = 0.35 + 0.65 * max(dot(n, vec3f(0.0, 0.0, s.face)), 0.0);
    g += s.color * exp(-edge / 0.016) * facing * (1.0 - 0.6 * smoothstep(0.0, 0.07, -front));
  }
  return g * 0.06 * O.lookA.z;
}
/**
 * Contact shading from the baked footprint layer (\`contact.ts\`): floors and the feet of partitions darken toward every
 * base, and whatever sits under a desk top falls into its shadow. O.lookD.y is the strength (0 off; Low tier).
 */
fn lookOcclusion(p: vec3f, n: vec3f) -> f32 {
  if (!lookOn() || O.lookD.y <= 0.0 || p.y > 0.8) { return 1.0; }
  let uv = (p.xz - vec2f(${f(LOOK_CONTACT.x)}, ${f(LOOK_CONTACT.z)})) / vec2f(${f(LOOK_CONTACT.w)}, ${f(LOOK_CONTACT.d)});
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return 1.0; }
  let c = textureSampleLevel(lookTex, lookSamp, uv, ${LOOK_LAYERS.contact}, 0.0);
  var o = mix(1.0, c.r, 1.0 - smoothstep(0.0, 0.25, p.y));
  if (c.g > 0.05 && p.y < c.g - 0.06) { o *= 0.42 + 0.3 * smoothstep(0.0, c.g, p.y); }
  return pow(max(o, 0.05), O.lookD.y);
}
/** Bounced light from the floor grid, the ceiling's share of it, and blind light kicked up onto the ceiling. */
fn lookBounce(p: vec3f, n: vec3f) -> vec3f {
  if (!lookOn()) { return vec3f(0.0); }
  var b = vec3f(0.0);
  let ceiling = n.y < -0.5 && p.y > 2.6;
  if (planBounceStrength() > 0.0) {
    let lift = mix(1.0, 0.5, smoothstep(0.2, 2.6, p.y));
    b += planBounceAt(p.xz + n.xz * 0.3) * select(lift, 0.55 * O.lookB.y, ceiling);
  }
  if (ceiling) {
    // Tilted slats throw a little sodium up onto the first metres of ceiling.
    let window = (1.0 - smoothstep(1.0, 1.25, abs(p.z - 4.0))) + (1.0 - smoothstep(1.0, 1.25, abs(p.z))) + (1.0 - smoothstep(1.0, 1.25, abs(p.z + 4.0))) + (1.0 - smoothstep(1.0, 1.25, abs(p.z + 7.0)));
    b += vec3f(1.0, 0.42, 0.13) * window * exp(-(p.x + 3.72) * 1.3) * 0.05 * O.lookB.y * O.lamps.z;
    // The lit troffer's diffuser and housing spill onto the tiles around it (the lamp itself only points down).
    let d = length(vec2f(p.x, max(abs(p.z) - 0.6, 0.0)));
    b += vec3f(0.62, 0.78, 0.74) * exp(-d * 1.4) * 0.05 * O.lookB.y * O.lamps.x * O.polish.z;
    // Beyond the bounce grid the whole dropped ceiling still holds a little of the room's light, warmer toward the blinds.
    b += mix(vec3f(0.3, 0.55, 0.6), vec3f(0.75, 0.5, 0.3), exp(-(p.x + 3.72) * 0.5)) * O.look.x * 0.22 * O.lookB.y;
  }
  if (p.z < 8.95 && p.z > 2.0 && p.y < 2.4) {
    // The car's warm light falls out through the doorway: a widening patch on the carpet and the faces turned to it.
    let dz = 9.0 - p.z;
    let halfW = 0.98 + dz * 0.3;
    let soft = 0.12 + dz * 0.1;
    let aperture = 1.0 - smoothstep(halfW - soft, halfW + soft, abs(p.x));
    let toward = normalize(vec3f(-p.x, 2.0 - p.y, 9.8 - p.z));
    let facing = max(dot(n, toward), 0.0);
    b += vec3f(1.0, 0.5, 0.19) * aperture * facing * 2.6 / (1.0 + dz * dz * 0.3) * O.lookC.x;
  }
  return b;
}
`

/** Appended to the office material recipes. Today returns before touching anything. */
export const lookMaterialWgsl = /* wgsl */ `
    if (lookOn()) {
      let W = O.lookA.w;
      let scans = O.lookB.x > 0.5;
      if (kind == 1) {
        // Partition fabric: woven scan, kick scuffs at the base, hand grime along the top, the odd stain.
        let side = abs(n.x) > 0.5;
        let uv = select(p.xy, p.zy, side);
        if (scans) {
          let s = lookScan(uv, ${LOOK_LAYERS.fabric}, 0.45);
          albedo *= mix(1.0, s.r * 2.0, 0.85);
          n = lookPerturb(n, select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), side), vec3f(0.0, 1.0, 0.0), s, 0.5);
          pbrRough = clamp(s.a * 2.0 - 1.0, 0.75, 1.0);
        }
        let foot = 1.0 - smoothstep(0.08, 0.42, p.y);
        let along = select(p.x, p.z, side);
        let scuff = smoothstep(0.55, 0.8, officeNoise(vec3f(along * 3.0, p.y * 6.0, 2.0)));
        let stain = lookStain(vec2f(along * 1.3 + 7.0, p.y * 1.6));
        // Mottled fading and hand grime: low-frequency blotches a palm to a metre across, darkest along the top rail.
        let mottle = smoothstep(0.32, 0.68, officeNoise(vec3f(along * 2.2, p.y * 2.6, 11.0)) * 0.6 + officeNoise(vec3f(along * 6.5, p.y * 7.0, 3.0)) * 0.4);
        let rail = smoothstep(0.7, 1.4, p.y);
        albedo *= 1.0 - W * (foot * (0.18 + 0.2 * scuff) + stain * 0.25 + (mottle - 0.5) * 0.36 + rail * 0.15);
      }
      if (kind == 4 && n.y < -0.5) {
        // Dropped-ceiling tiles on the 0.6 × 1.2 m grid: fissured scan, per-tile age, water stains, one missing tile.
        let basement = p.x > 20.0;
        let cell = select(vec2f((p.x + 6.0) / 0.6, (p.z + 9.0) / 1.2), vec2f((p.x - ${f(BASEMENT_X - 3)}) / 0.6, (p.z - 8.0) / 1.2), basement);
        let id = floor(cell);
        let local = fract(cell);
        let age = officeHash(vec3f(id, 3.0));
        if (scans) {
          let s = lookScan(p.xz + vec2f(6.0, 9.0), ${LOOK_LAYERS.ceiling}, 0.6);
          albedo *= mix(1.0, s.r * 2.0, 0.8);
          n = lookPerturb(n, vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), s, 0.6);
        }
        albedo *= mix(1.0, 0.86 + 0.2 * age, W);
        let bevel = min(min(local.x, 1.0 - local.x) * 0.6, min(local.y, 1.0 - local.y) * 1.2);
        albedo *= mix(1.0, 0.55 + 0.45 * smoothstep(0.0, 0.035, bevel), W);
        let damp = lookStain(p.xz * 0.55 + vec2f(3.2, 9.7));
        let tide = smoothstep(0.1, 0.2, damp) * (1.0 - smoothstep(0.24, 0.42, damp));
        albedo *= mix(vec3f(1.0), vec3f(0.68, 0.55, 0.36), clamp(damp * 0.9 + tide * 0.5, 0.0, 1.0) * W);
        if (!basement && (all(id == vec2f(6.0, 13.0)) || all(id == vec2f(15.0, 4.0)))) { albedo *= mix(1.0, 0.04, W); }
        pbrRough = 0.97;
      }
      if (kind == 2) {
        // Carpet: traffic down the aisle and into each cubicle, spills and caster wear.
        let lane = 1.0 - smoothstep(0.35, 0.95, abs(p.x));
        let traffic = lane * (0.6 + 0.4 * officeNoise(vec3f(p.xz * 1.3, 5.0)));
        var stain = lookStain(p.xz * 1.1 + vec2f(41.0, 3.0));
        if (scans) { let s = lookScan(p.xz, ${LOOK_LAYERS.carpet}, 1.6); stain = max(stain, (1.0 - s.r) * 0.6); }
        albedo *= mix(vec3f(1.0), vec3f(0.78, 0.74, 0.66), traffic * 0.55 * W);
        albedo *= 1.0 - stain * 0.22 * W;
      }
      if (kind == 3 || kind == 0 || kind == 15) {
        // Laminate and beige plastics: a fine scanned grain and uneven sheen, so they stop reading as clean CG plastic.
        let a = abs(n);
        let uv = select(select(p.xy, p.zy, a.x > a.z), p.xz, a.y > max(a.x, a.z));
        var detail = 0.5;
        var rough = 0.5;
        if (scans) { let s = lookScan(uv, ${LOOK_LAYERS.plastic}, 0.35); detail = s.r; rough = s.a * 2.0 - 1.0; }
        let yellow = officeNoise(vec3f(p * 1.7));
        albedo *= mix(vec3f(1.0), mix(vec3f(1.0), vec3f(1.02, 0.97, 0.86), yellow) * (0.88 + 0.24 * detail), W);
        pbrRough = mix(pbrRough, clamp(0.45 + rough * 0.5 + 0.08 * officeNoise(p * 9.0), 0.35, 0.95), W);
      }
      if (kind == 20 || kind == 21 || kind == 10 || kind == 5) {
        let grime = carGrime(p);
        if (grime >= 0.0) {
          let along = select(p.x, p.z, abs(n.x) > 0.5);
          let fine = 1.0 - smoothstep(0.0015, 0.006, officeFootprint);
          if (kind == 20) {
            // Mostly clean stainless with a vertical brushed grain: fine streaks set the roughness, so highlights
            // stretch into soft vertical sheens; rare scratches catch the light.
            let streak = officeNoise(vec3f(along * 420.0, p.y * 2.5, 1.0)) * 0.6 + officeNoise(vec3f(along * 90.0, p.y * 1.2, 6.0)) * 0.4;
            let scratch = 0.5 * smoothstep(0.96, 1.0, officeNoise(vec3f((along + p.y * 0.6) * 80.0, (along - p.y) * 3.0, 2.0))) * fine;
            // Broad vertical bands of polish, a hand to a forearm wide, give the soft sheen its stripes.
            let band = officeNoise(vec3f(along * 7.0, 0.0, 9.0));
            albedo = vec3f(0.5, 0.51, 0.52) * (0.9 + 0.12 * streak * fine) * (1.0 + 0.5 * scratch);
            pbrMetal = 0.9;
            pbrRough = mix(0.18, 0.38, streak * fine * 0.6 + band * 0.4 + (1.0 - fine) * 0.3) + 0.3 * grime;
          } else if (kind == 21) {
            // Walnut laminate: printed grain, sun-faded patches.
            let grain = fract(officeNoise(vec3f(along * 1.2, p.y * 30.0, 3.0)) * 7.0);
            albedo *= (0.7 + 0.35 * smoothstep(0.1, 0.9, grain)) * (0.9 + 0.2 * officeNoise(p * 2.0));
            pbrRough = 0.55;
          } else if (kind == 10) {
            albedo *= 0.75;
          } else {
            // The shell's bronze jambs and ceiling, dulled.
            albedo *= 0.6;
          }
          albedo *= 1.0 - grime * 0.55 * W;
        }
      }
      if (p.x > 20.0 && carGrime(p) < 0.0) {
        let lx = p.x - ${f(BASEMENT_X)};
        if (kind == 5 && p.y < 0.01 && n.y > 0.5) {
          // Sweating concrete: dark, with standing water along the aisle that mirrors the practicals.
          let wet = basementWet(p);
          let edge = exp(-max(1.74 - abs(lx), 0.0) / 0.18);
          albedo *= (0.45 + 0.2 * officeNoise(vec3f(p.xz * 3.0, 4.0))) * (1.0 - 0.5 * wet) * (1.0 - 0.45 * edge * W);
          pbrRough = mix(0.8, 0.06, wet);
          pbrMetal = 0.0;
        }
        if (kind == 0 && p.y < 0.08) {
          // Rubber-jacketed cable bundles: dark, with a tight sheen that picks up the door and the screens.
          albedo *= 0.22;
          pbrRough = 0.42;
        }
        if (kind == 4 && abs(n.x) > 0.5) {
          // Damp walls: tide marks from the floor and long streaks under the pipe brackets.
          let streak = smoothstep(0.55, 0.85, officeNoise(vec3f(p.z * 7.0, p.y * 0.6, 3.0))) * smoothstep(0.2, 1.9, p.y);
          let tide = 1.0 - smoothstep(0.25, 0.65, p.y + 0.15 * officeNoise(vec3f(p.z * 2.0, 0.0, 9.0)));
          albedo *= 1.0 - W * (0.35 * streak + 0.4 * tide);
          pbrRough = mix(pbrRough, 0.45, tide);
        }
        if (kind == 5 && p.y > 1.8 && abs(lx) > 3.2) {
          // Condensation on the pipes: wet, darker, beaded.
          let beads = smoothstep(0.7, 0.9, officeNoise(p * vec3f(40.0, 60.0, 40.0)));
          albedo *= 0.75 - 0.2 * beads;
          pbrRough = mix(0.22, 0.08, beads);
        }
      }
      if (kind == 15 && O.lookB.z > 0.5) {
        // Dead tubes: grey glass, ends burnt black by the cathodes.
        let ends = smoothstep(0.36, 0.46, abs(p.z - lookNearestTroffer(p.z)));
        albedo *= vec3f(0.62, 0.64, 0.6) * (1.0 - 0.85 * ends);
      }
    }
`

/** Appended to the surface hook, before fog. */
export const lookSurfaceWgsl = /* wgsl */ `
    if (lookOn()) {
      if (kind == 0) { col += lookBezelGlow(o.world, n); }
      if (kind == 22) { col = vec3f(1.8, 0.75, 0.15) * O.lookD.w; }
      if (kind == 23) {
        // Extra basement screens: scrolling lines of green text, dipping with the others.
        let a = vec2f(select(o.world.x + o.world.z, o.world.x - o.world.z, o.world.x < ${f(BASEMENT_X)}), o.world.y);
        let line = floor(a.y * 80.0 + O.look.w * 3.0);
        let glyph = floor(a.x * 120.0);
        let lit = step(0.35, officeHash(vec3f(glyph, line, 3.0))) * step(0.3, fract(a.y * 80.0)) * step(officeHash(vec3f(line, 1.0, 7.0)) * 0.8, fract(a.x * 3.0));
        col = vec3f(0.012, 0.035, 0.02) + vec3f(0.16, 0.6, 0.3) * lit * 0.12;
        col *= O.lookC.z;
      }
      if (kind == 24) { col = vec3f(4.0, 1.9, 0.7); }
      if (kind == 5 && o.world.x > 20.0 && o.world.y < 0.01 && n.y > 0.5 && o.world.z < 8.8) {
        col += basementMirror(o.world) * basementWet(o.world) * O.lookA.w;
      }
      if (kind == 13 && o.world.x > 20.0 && o.world.y > 2.7) {
        col *= select(select(0.03, O.lookD.x * 0.7, o.world.z > -5.0), O.lookC.w * 0.5, o.world.z > 3.0);
      }
      if (kind == 15 && O.lookB.z > 0.5) {
        let x = o.world.x;
        let z = o.world.z;
        let fixture = lookNearestTroffer(z);
        let ends = smoothstep(0.36, 0.46, abs(z - fixture));
        if (abs(x) < 1.0 && fixture > 4.0 && x < 0.0) {
          // Dying tube by the elevator: shares the kit flicker signal, orange-pink cathode glow when it gutters.
          let level = O.lookB.w;
          col = vec3f(0.77, 0.89, 0.70) * level * 2.2 + vec3f(1.0, 0.3, 0.12) * ends * (0.15 + 0.5 * (1.0 - level));
        } else if (abs(x - 3.6) < 1.0 && fixture < -3.0 && fixture > -5.0 && x > 3.6) {
          col = vec3f(0.62, 0.78, 0.70) * 0.9 * (1.0 - 0.6 * ends);
        }
      }
    }
`

/** Curved phosphor glass for the textured CRT screens (hero and colleagues). */
export const lookGlassWgsl = /* wgsl */ `
fn lookGlass(colIn: vec3f, uv: vec2f, p: vec3f, nIn: vec3f) -> vec3f {
  // The car's own displays (both locations) keep Today's look.
  if (!lookOn() || p.z > 8.9) { return colIn; }
  let g = O.lookA.z;
  let basement = p.x > 20.0;
  // Basement screens sample a 4 × 4 atlas; each cell is one screen.
  let q = select(uv, fract(uv * 4.0), basement) - 0.5;
  let synced = select(1.0, O.lookC.z, nIn.z < -0.5 || basement);
  // Phosphor falls away toward the curved edge and the rounded corners.
  let edge = 1.0 - smoothstep(0.34, 0.5, max(abs(q.x), abs(q.y)) * 0.55 + length(q) * 0.45);
  var col = colIn * mix(1.0, 0.45 + 0.55 * edge, g) * synced;
  let t = normalize(cross(vec3f(0.0, 1.0, 0.0), nIn));
  let nb = normalize(nIn + (t * q.x - vec3f(0.0, 1.0, 0.0) * q.y) * 0.7);
  let V = normalize(F.cam.xyz - p);
  let R = reflect(-V, nb);
  // A dark office in the glass: blind slats on the window side, the troffers above, teal room light.
  let blinds = select(1.0, 0.0, basement) * smoothstep(0.2, 0.8, -R.x) * smoothstep(-0.25, 0.25, R.y + 0.05) * (0.55 + 0.45 * sin(R.y * 95.0));
  let tubes = smoothstep(0.82, 0.97, R.y);
  let env = vec3f(1.0, 0.45, 0.15) * blinds * 0.05 * O.lamps.z + vec3f(0.7, 0.85, 0.8) * tubes * 0.03 + vec3f(0.004, 0.008, 0.009);
  let fresnel = 0.04 + 0.96 * pow(1.0 - clamp(dot(nb, V), 0.0, 1.0), 5.0);
  col += env * fresnel * g * 6.0;
  // Grey glass lifts the black of an unlit phosphor slightly, more toward the curved edge.
  col += vec3f(0.0025, 0.003, 0.003) * g * (1.0 + 2.0 * (1.0 - edge));
  return col;
}
`

/**
 * Bounce emission for the office's lights: the physical spot cones and the windowed inverse square the surfaces use,
 * with the blind slats for the streetlights (blurred to the grid).
 */
export const lookPlanBounce: PlanBounceShader = {
  declarations: blindCookieWgsl.replace("O.lightShape.x", "0.0025"),
  attenuation: /* wgsl */ `let pw = vec3f(p.x, select(PB.c.z, 1.0, wall), p.y);
    let dl = pw - L.pos.xyz;
    let dist = max(length(dl), 0.05);
    let xw = dist / max(r, 0.001);
    let ww = clamp(1.0 - xw * xw * xw * xw, 0.0, 1.0);
    var att = power * ww * ww / max(dist * dist, max(L.extra.z * L.extra.z, 0.01)) / 3.14159265;
    if (L.cone.w >= 2.5 && L.cone.w < 4.5) {
      let axis = vec3f(L.cone.x, -sqrt(max(1.0 - dot(L.cone.xy, L.cone.xy), 0.0)), L.cone.y);
      att *= smoothstep(L.cone.z, L.cone.w - 3.0, dot(dl / dist, axis));
    } else if (L.cone.w >= 4.5 && L.cone.w < 6.5) {
      let half = L.cone.w - 5.0;
      att *= smoothstep(cos(half), cos(half * 0.4), dot(dl / dist, L.cone.xzy));
    }
    if (L.pos.x < -3.0 && L.color.r > 0.95 && L.color.b < 0.2) { att *= blindCookieAt(pw, L.pos.xyz, 0.2); }`,
}
