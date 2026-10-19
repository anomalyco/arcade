import { MIRROR_H, MIRROR_LEAN, MIRROR_W } from "../interiors/mesh"
import { REFLECTION_LIGHTS } from "./lights"

/** Mirror glass (`mirror.ts`): vertex colour carries the glass uv, aux 1 marks a cracked plate. */
export const MAT_MIRROR: number = 26

/** Glass rectangle inside the frame, in the frame's slanted plane (m): see `mirrorModel`. */
export const MIRROR_FRAME = 0.07
export const MIRROR_GLASS_FOOT = MIRROR_FRAME + 0.03
export const MIRROR_GLASS_HEAD = MIRROR_FRAME + 0.05
/** How far the frame's top stands off the wall (m). */
export const MIRROR_TOP_OUT = 0.03

/** Street potholes holding water, per 96 m macro-block ([x, z, scale]; `ground.ts` potholes, `audio/space.ts` puddles). */
export const STREET_PUDDLES: readonly (readonly [number, number, number])[] = [
  [25.6, 42.15, 0.95],
  [32.45, 45.2, 1.05],
  [27.4, 46.45, 0.88],
  [36.1, 41.65, 0.85],
  [21.4, 45.3, 1.0],
  [43.4, 36.2, 0.95],
  [52.6, 44.6, 1.05],
  [16.2, 42.9, 0.96],
  [64.5, 45.1, 1.02],
]

const f = (v: number) => v.toFixed(4)
const lean = Math.hypot(MIRROR_H, MIRROR_LEAN - MIRROR_TOP_OUT)
const rise = Math.sqrt(MIRROR_H * MIRROR_H - (MIRROR_LEAN - MIRROR_TOP_OUT) ** 2)

export const reflectionDeclarationsWgsl = /* wgsl */ `
/** One pothole's standing water: an irregular pool about half a metre across. */
fn outbreakPothole(q: vec2f, c: vec3f) -> f32 {
  let d = q - c.xy;
  let d2 = dot(d, d);
  if (d2 > 0.64 * c.z * c.z) { return 0.0; }
  let wob = surfaceNoise(d * 4.2 + c.xy);
  let r = c.z * (0.38 + 0.2 * wob);
  let aa = max(0.03, surfaceFootprint * 1.2);
  return 1.0 - smoothstep(r - aa, r + aa, sqrt(d2));
}

/**
 * Standing water (x) and wetness (y) of hard ground at p. The street potholes always hold water; rain (or the Lab's
 * wetness) wets the paving and gathers broad, domain-warped pools a few metres across, never in rows.
 */
fn outbreakWetMask(p: vec2f, paved: bool, road: bool) -> vec2f {
  let wet = max(OL.u8.y, OL.refl.z);
  var pud = 0.0;
  if (road && OL.refl.y > 0.5) {
    let q = p - floor(p / 96.0) * 96.0;
${STREET_PUDDLES.map(([x, z, s]) => `    pud = max(pud, outbreakPothole(q, vec3f(${f(x)}, ${f(z)}, ${f(s)})));`).join("\n")}
  }
  let cover = max(OL.u8.z, OL.refl.z * 0.55);
  if (paved && wet > 0.01 && cover > 0.01) {
    let w = surfaceNoise(p * 0.19 + vec2f(5.3, 1.7));
    let n = surfaceNoise(p * 0.43 + vec2f(w * 2.3 + 0.7, 9.1 - w * 1.7));
    let th = mix(0.9, 0.56, clamp(cover, 0.0, 1.0));
    let aa = max(0.04, surfaceFootprint * 0.8);
    pud = max(pud, smoothstep(th - aa, th + aa, n) * clamp(wet * 1.6, 0.0, 1.0));
  }
  return vec2f(pud, wet);
}

/**
 * Raindrop rings in standing water: one drop site per 0.45 m cell, jittered with its own phase, as a plan offset of
 * where the eye's reflection lands (so glints shiver), faded out where the rings would be under a pixel.
 */
fn outbreakRainRipple(p: vec2f) -> vec2f {
  let g = p * 2.2;
  let c = floor(g);
  let site = c + vec2f(0.2) + 0.6 * vec2f(hash2(c + vec2f(3.1, 7.7)), hash2(c + vec2f(9.2, 1.3)));
  let ph = fract(F.cam.w * 1.1 + hash2(c + vec2f(5.5, 2.2)));
  let d = g - site;
  let r = length(d);
  let x = (r - ph * 0.5) * 12.0;
  let band = exp(-x * x) * (1.0 - ph);
  return d / max(r, 1e-3) * band * 0.08 * (1.0 - smoothstep(0.05, 0.2, surfaceFootprint));
}

/**
 * How much a survivor's or zombie's reflection covers ground point p (1 covered), and how far the figure stands from
 * the eye in plan (a light further away than that is behind it). A standing figure's mirror image runs from its feet
 * toward the camera, its length set by how high the camera is.
 */
fn outbreakFigureCover(p: vec2f, a: vec2f, foot: f32, cover: ptr<function, vec2f>) {
  let e = F.cam.xyz;
  let toEye = e.xz - a;
  let dist = length(toEye);
  if (dist < 0.01) { return; }
  let dir = toEye / dist;
  let len = 1.72 * dist / (1.72 + max(e.y - foot, 1.0));
  let rel = p - a;
  let s = dot(rel, dir) / len;
  if (s < -0.1 || s > 1.05) { return; }
  let side = abs(dot(rel, vec2f(-dir.y, dir.x)));
  let half = select(select(0.2, 0.23, s > 0.45), 0.11, s > 0.84);
  let c = (1.0 - smoothstep(half - 0.05, half + 0.03, side)) * smoothstep(-0.1, 0.02, s) * (1.0 - smoothstep(0.98, 1.05, s));
  if (c > (*cover).x) { *cover = vec2f(c, dist); }
}

/**
 * Lamps, lit windows, fire, police lights and headlights mirrored in standing water (a tight image) and wet paving (a
 * soft streak toward the camera), the same analytic image as the kit's floor-plane lamp mirror. The CPU picks up to
 * eight outdoor lights whose images land in view and works out each image (reflections/lights.ts, OL.reflLights), so
 * the loop is a distance test per light and never reads the light buffer or the shadow map (register pressure,
 * docs/game-notes.md). The survivor and the nearest zombies stand in front of the lights behind them as dark figures.
 */
fn outbreakWetGlints(world: vec3f, puddle: f32, wet: f32) -> vec3f {
  let gloss = max(puddle, wet * 0.4);
  if (gloss <= 0.01) { return vec3f(0.0); }
  let e = F.cam.xyz;
  var q = world.xz;
  if (OL.refl.w > 0.01 && puddle > 0.05) { q += outbreakRainRipple(world.xz) * OL.refl.w * puddle; }
  var cover = vec2f(0.0);
  var covered = false;
  var acc = vec3f(0.0);
  for (var j = 0u; j < ${REFLECTION_LIGHTS}u; j++) {
    let img = OL.reflLights[j * 2u];
    if (img.w <= 0.0) { break; }
    let sA = mix(img.w * 2.4, img.w, puddle);
    let sLong = mix(img.w * 7.5, img.w * 1.8, puddle);
    let dq = q - img.xy;
    let d2 = dot(dq, dq);
    if (d2 > 6.0 * sLong * sLong) { continue; }
    let toEye = normalize(e.xz - img.xy + vec2f(1e-4, 0.0));
    let along = dot(dq, toEye);
    let across = dot(dq, vec2f(-toEye.y, toEye.x));
    // The streak runs from the image toward the eye; behind it the image stays tight.
    let sL = select(sA, sLong, along > 0.0);
    let r2 = across * across / (sA * sA) + along * along / (sL * sL);
    if (r2 > 6.0) { continue; }
    if (!covered) {
      outbreakFigureCover(q, OL.u6.xy, OL.u6.z, &cover);
      outbreakFigureCover(q, OL.u9.xy, world.y, &cover);
      outbreakFigureCover(q, OL.u9.zw, world.y, &cover);
      covered = true;
    }
    var g = exp(-r2);
    if (img.z > cover.y + 0.15) { g *= 1.0 - cover.x; }
    acc += OL.reflLights[j * 2u + 1u].rgb * g;
  }
  // The flashlight's hotspot on a wall or a body, seen again in the water in front of it.
  let bouncePower = OL.u14.z;
  if (bouncePower > 0.001) {
    let bp = OL.u14.xy;
    let bh = max(OL.u17.x - world.y, 0.05);
    let k = bh / (bh + max(e.y - world.y, 1.0));
    let pm = bp + (e.xz - bp) * k;
    let dq = q - pm;
    let r2 = dot(dq, dq) / (0.16 + 0.5 * (1.0 - puddle));
    if (r2 < 6.0) {
      if (!covered) {
        outbreakFigureCover(q, OL.u6.xy, OL.u6.z, &cover);
        outbreakFigureCover(q, OL.u9.xy, world.y, &cover);
        outbreakFigureCover(q, OL.u9.zw, world.y, &cover);
      }
      var g = exp(-r2) * smoothstep(0.6, 1.2, OL.u17.x - world.y);
      if (length(bp - e.xz) > cover.y + 0.15) { g *= 1.0 - cover.x; }
      acc += OL.u5.rgb * bouncePower * g * 0.35;
    }
  }
  return acc * gloss * OL.refl.x * 0.55;
}

/**
 * Wet hard ground outdoors: standing water darkens and takes the lights' images, wet paving a soft streak. Leaves the
 * reflected light in the practical-light colour mask, so reflections keep their colour like a lamp pool.
 */
fn outbreakWetSurface(world: vec3f, colIn: vec3f, paved: bool, road: bool) -> vec3f {
  let m = outbreakWetMask(world.xz, paved, road);
  if (m.x <= 0.001 && m.y <= 0.01) { return colIn; }
  // The weather already darkens what rain wets; the Lab's dry-weather wetness darkens its own share.
  let labWet = max(0.0, OL.refl.z - OL.u8.y);
  var col = colIn * (1.0 - 0.32 * m.x) * (1.0 - 0.22 * labWet);
  let glint = outbreakWetGlints(world, m.x, m.y);
  col += glint;
  outbreakPracticalIrr += dot(glint, vec3f(0.2126, 0.7152, 0.0722)) * 1.6;
  return col;
}

/** A vertical body (survivor or zombie) as two stacked cylinders: distance along the ray to its surface, or -1. */
fn outbreakRayFigure(o: vec3f, d: vec3f, c: vec2f, foot: f32, tMax: f32) -> f32 {
  let a = dot(d.xz, d.xz);
  if (a < 1e-6) { return -1.0; }
  let oc = o.xz - c;
  let b = dot(oc, d.xz);
  var best = -1.0;
  for (var part = 0; part < 2; part++) {
    let r = select(0.23, 0.12, part == 1);
    let y0 = foot + select(0.0, 1.46, part == 1);
    let y1 = foot + select(1.46, 1.76, part == 1);
    let cc = dot(oc, oc) - r * r;
    let disc = b * b - a * cc;
    if (disc < 0.0) { continue; }
    let t = (-b - sqrt(disc)) / a;
    if (t <= 0.0 || t >= tMax) { continue; }
    let y = o.y + d.y * t;
    if (y < y0 || y > y1) { continue; }
    if (best < 0.0 || t < best) { best = t; }
  }
  return best;
}

/** The survivor's beam at a point the mirror shows, without shadows: inside the cone, falling off with distance. */
fn outbreakMirrorBeam(p: vec3f, nrm: vec3f) -> vec3f {
  if (OL.u4.z <= 0.001) { return vec3f(0.0); }
  let lens = vec3f(OL.u3.x, OL.u11.x, OL.u3.y);
  let d = p - lens;
  let dist = max(length(d), 0.05);
  let dir = d / dist;
  let axis = vec3f(OL.u3.z * OL.u13.y, OL.u13.x, OL.u3.w * OL.u13.y);
  let inCone = smoothstep(OL.u11.y, mix(OL.u11.y, 1.0, 0.2), dot(dir, axis));
  let fall = clamp(1.0 - dist / max(OL.u4.y, 1.0), 0.0, 1.0) / (1.0 + dist * dist * 0.08);
  return OL.u5.rgb * OL.u4.z * inCone * fall * max(dot(nrm, -dir), 0.0) * 2.2;
}

/**
 * An old leaning floor mirror (RE mansion): what the camera sees reflected in it, worked out from the glass rather than
 * rendered: the floor in front (its baked lamp pools, bounce and AO; the flashlight's beam at Mirror detail 1), the
 * survivor and the two nearest zombies standing in front of it (detail 2), and the flashlight's lens flaring when it is aimed into the
 * glass. Old plate glass bends the image a little; the silvering has foxed and worn away at the edges, where the dark
 * backing shows; grime on the glass catches the beam. A cracked plate tilts each shard its own way.
 */
fn outbreakMirrorSurface(world: vec3f, nIn: vec3f, uvIn: vec2f, cracked: bool) -> vec3f {
  let uv = clamp(uvIn, vec2f(0.0), vec2f(1.0));
  let gw = ${f(MIRROR_W - 2 * MIRROR_FRAME)};
  let gh = ${f(lean)} - ${f(MIRROR_GLASS_FOOT + MIRROR_GLASS_HEAD)};
  let up = normalize(vec3f(0.0, ${f(rise)}, ${f(MIRROR_TOP_OUT - MIRROR_LEAN)}));
  let side = normalize(cross(up, nIn));
  // Floor under the foot, from where this point sits up the slant.
  let floorY = world.y - up.y * (${f(MIRROR_GLASS_FOOT)} + uv.y * gh);
  let centre = world - side * (uv.x - 0.5) * gw - up * (uv.y - 0.5) * gh;
  let seed = hash2(floor(centre.xz * 4.0 + 0.5));
  let age = clamp(OL.mirror.y, 0.0, 1.5);
  let m = uv * vec2f(gw, gh);
  var n = nIn;
  let wav = vec2f(surfaceNoise(m * vec2f(4.0, 2.2) + seed * 17.0) - 0.5, surfaceNoise(m * vec2f(2.6, 3.4) + seed * 23.0) - 0.5);
  n = normalize(n + (side * wav.x + up * wav.y) * 0.03);
  var crack = 0.0;
  if (cracked) {
    let hit = vec2f(0.3 + 0.4 * seed, 0.45 + 0.3 * fract(seed * 7.3)) * vec2f(gw, gh);
    let rel = m - hit;
    let ang = atan2(rel.y, rel.x) / 6.2831853 + 0.5;
    let wedges = 7.0;
    let shard = floor(ang * wedges + hash2(vec2f(seed, 3.0)));
    let tilt = vec2f(hash2(vec2f(shard, seed)), hash2(vec2f(seed, shard * 1.7))) - 0.5;
    let rd = length(rel);
    let ringShard = step(0.13, rd);
    n = normalize(n + (side * tilt.x + up * tilt.y) * 0.09 * ringShard);
    // Lines along the wedge edges (distance in metres across the line) and a ring round the impact.
    let fw = max(0.004, surfaceFootprint * 0.7);
    let edgeT = 0.5 - abs(fract(ang * wedges + hash2(vec2f(seed, 3.0))) - 0.5);
    let radial = 1.0 - smoothstep(0.0, fw, edgeT / wedges * 6.2831853 * rd);
    let ring = 1.0 - smoothstep(0.0, fw * 1.5, abs(rd - 0.13));
    crack = clamp(max(radial * smoothstep(0.02, 0.06, rd), ring), 0.0, 1.0);
  }
  let V = normalize(F.cam.xyz - world);
  let R = reflect(-V, n);
  let detail = i32(round(OL.mirror.x));
  var tHit = 1e4;
  var hitCol = vec3f(0.0);
  // The room floor in front.
  if (R.y < -0.02) {
    tHit = (floorY - world.y) / R.y;
    let fp = world + R * tHit;
    let fd = floorData(fp.xz);
    let boards = 0.82 + 0.3 * surfaceNoise(vec2f(fp.x * 0.7, fp.z * 6.5)) - 0.1 * (1.0 - smoothstep(0.0, 0.03, abs(fract(fp.z * 6.5) - 0.5) * 2.0));
    let albedo = vec3f(0.23, 0.15, 0.09) * boards;
    let nightLamps = clamp(1.38 - F.monitorBounds.w * 1.38, 0.0, 1.0);
    var light = outbreakBounce(fp.xz, 0.58 * nightLamps * OL.u1.z * OL.colour.w);
    light += outbreakSkyAmbient(vec3f(0.0, 1.0, 0.0), F.ambient.rgb) * mix(0.03, 0.88, fd.g * 0.28);
    light += vec3f(1.38, 1.14, 0.82) * F.monitorBounds.w * fd.g * 0.42 * F.ambient.w;
    if (detail >= 1) { light += outbreakMirrorBeam(fp, vec3f(0.0, 1.0, 0.0)); }
    hitCol = albedo * light * (1.0 - fd.r * 0.85);
  } else {
    hitCol = vec3f(0.004, 0.0035, 0.003);
  }
  // People standing in front: the survivor and the two nearest zombies.
  if (detail >= 2) {
    var tf = outbreakRayFigure(world, R, OL.u6.xy, OL.u6.z, tHit);
    var tint = vec3f(0.11, 0.1, 0.09);
    var c = OL.u6.xy;
    for (var z = 0; z < 2; z++) {
      let zc = select(OL.u9.zw, OL.u9.xy, z == 0);
      let tz = outbreakRayFigure(world, R, zc, floorY, select(tHit, tf, tf > 0.0));
      if (tz > 0.0) { tf = tz; tint = vec3f(0.085, 0.095, 0.075); c = zc; }
    }
    if (tf > 0.0) {
      let hp = world + R * tf;
      let fn0 = normalize(vec3f(hp.x - c.x, 0.0, hp.z - c.y));
      var light = outbreakSkyAmbient(fn0, F.ambient.rgb) * 0.4 + bounceAt(hp.xz) * 0.5 * OL.colour.w * OL.u1.z;
      if (detail >= 1) { light += outbreakMirrorBeam(hp, fn0); }
      let rim = pow(1.0 - abs(dot(fn0, R)), 2.0) * 0.6;
      hitCol = tint * light * (0.8 + rim);
      tHit = tf;
    }
  }
  // The flashlight's lens, when it shines into the glass.
  if (OL.u4.z > 0.001) {
    let lens = vec3f(OL.u3.x, OL.u11.x, OL.u3.y);
    let tl = dot(lens - world, R);
    if (tl > 0.0 && tl < tHit + 0.3) {
      let dl = length(world + R * tl - lens);
      let axis = vec3f(OL.u3.z * OL.u13.y, OL.u13.x, OL.u3.w * OL.u13.y);
      let aim = smoothstep(OL.u11.y, mix(OL.u11.y, 1.0, 0.5), dot(normalize(world - lens), axis));
      hitCol += OL.u5.rgb * OL.u4.z * aim * (exp(-dl * dl / 0.0012) * 6.0 + exp(-dl * dl / 0.03) * 0.5);
    }
  }
  // Old silvering: foxed spots, worn edges showing the dark backing, a cold green cast; grime catches the light.
  let edge = min(min(m.x, gw - m.x), min(m.y, gh - m.y));
  let wornEdge = 1.0 - smoothstep(0.0, (0.03 + 0.06 * surfaceNoise(m * 9.0 + seed * 5.0)) * age + 0.001, edge);
  let fox = smoothstep(0.7, 0.82, surfaceNoise(m * 11.0 + seed * 31.0)) * (0.35 + 0.65 * (1.0 - smoothstep(0.0, 0.18, edge))) * age;
  let silver = clamp((1.0 - wornEdge * 0.85) * (1.0 - fox * 0.75) * (1.0 - crack * 0.9), 0.0, 1.0);
  let reflected = hitCol * vec3f(0.74, 0.78, 0.72) * silver;
  let grimeLight = OL.u5.rgb * outbreakFlashIrr * 0.9 + vec3f(1.0, 0.72, 0.42) * outbreakPracticalIrr * 0.25;
  let grime = vec3f(0.05, 0.045, 0.036) * grimeLight * (0.35 + 0.65 * age * (0.4 + fox + wornEdge)) + vec3f(0.06, 0.055, 0.05) * grimeLight * crack;
  let backing = vec3f(0.012, 0.009, 0.006) * (0.2 + grimeLight) * (1.0 - silver);
  let col = reflected + grime + backing;
  outbreakPracticalIrr += dot(reflected, vec3f(0.2126, 0.7152, 0.0722)) * 3.0;
  outbreakAlbedo = max(col / max(max(col.r, max(col.g, col.b)), 1e-4) * 0.5, vec3f(0.01));
  return col;
}
`

/**
 * Surface step (after the lamp bounce, before the fog of war): mirrors, and wet hard ground outdoors. Ground kinds:
 * 1 road, 2 sidewalk and curb, 3 and 6 paths and drives; the pothole's wet centre, manholes and drain grates are
 * flat shiny props. Matte things (blood, litter, paint) never take reflections.
 */
export const reflectionSurfaceWgsl = /* wgsl */ `
    if (mat == ${MAT_MIRROR}) {
      col = outbreakMirrorSurface(o.world, n, pow(max(o.color.rg, vec2f(0.0)), vec2f(1.0 / 2.2)), o.aux > 0.5);
    } else if (OL.refl.x > 0.001 && !inRoom && n.y > 0.85 && o.world.y < 0.16 && OL.u8.w < 0.5) {
      let gk = i32(round(o.aux));
      let ground = mat == 20 && (gk == 1 || gk == 2 || gk == 3 || gk == 6);
      let flatProp = mat == 10 && o.world.y < 0.06;
      if (ground || flatProp) {
        col = outbreakWetSurface(o.world, col, true, (mat == 20 && gk == 1) || flatProp);
      }
    }
`
