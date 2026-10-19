/**
 * Wet ground and puddles (AR-71), one definition in TypeScript and WGSL so the CPU and the shaders agree.
 *
 * The API other passes read (puddle reflections own their rendering; this module owns the mask):
 * - Uniforms: `OL.u8.y` ground wetness 0..1 and `OL.u8.z` standing water 0..1 (`packOutbreakLightingUniforms`, from
 *   `OutbreakWeatherController.surface`).
 * - WGSL: `outbreakPuddleMask(xz, onRoad)` (0..1, where water stands) and `outbreakWetness()`, declared in the scene
 *   shader through `outbreakPuddleDeclarationsWgsl`.
 * - CPU: `puddleMaskAt(x, z, puddles, onRoad)` mirrors the WGSL for placement, tests and probes.
 *
 * Water collects in low spots first (two octaves of value noise, low frequency so puddles are a few metres across,
 * never a pattern) and along the road's gutters, the 0.9 m inside each kerb, which fill before the crown. As the
 * standing water rises the threshold drops and the puddles spread and join.
 */

const fract = (v: number) => v - Math.floor(v)

function hash2(x: number, y: number): number {
  let qx = fract(x * 0.1031)
  let qy = fract(y * 0.103)
  const d = qx * (qy + 33.33) + qy * (qx + 33.33)
  qx += d
  qy += d
  return fract((qx + qy) * qx)
}

function noise2(x: number, y: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = hash2(ix, iy)
  const b = hash2(ix + 1, iy)
  const c = hash2(ix, iy + 1)
  const d = hash2(ix + 1, iy + 1)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Roads run along each 96 m block's z 40..48 band and x 40..48 avenue; gutters are the 0.9 m inside each kerb. */
export function gutterAt(x: number, z: number): number {
  const bx = x - Math.floor(x / 96) * 96
  const bz = z - Math.floor(z / 96) * 96
  const edge = (v: number) => Math.min(Math.abs(v - 40), Math.abs(v - 48))
  const inZ = bz > 39.6 && bz < 48.4
  const inX = bx > 39.6 && bx < 48.4
  const gz = inZ ? 1 - smoothstep(0.15, 0.9, edge(bz)) : 0
  const gx = inX ? 1 - smoothstep(0.15, 0.9, edge(bx)) : 0
  return Math.max(gz, gx)
}

/** Depression field 0..1 (higher = lower ground). */
export function puddleField(x: number, z: number, onRoad: boolean): number {
  const low = noise2(x * 0.19 + 3.1, z * 0.19 + 7.4)
  const mid = noise2(x * 0.53 + 11.3, z * 0.53 + 2.9)
  return low * 0.7 + mid * 0.3 + (onRoad ? gutterAt(x, z) * 0.28 : 0)
}

/** Where water stands, 0..1, for standing water `puddles` 0..1. */
export function puddleMaskAt(x: number, z: number, puddles: number, onRoad: boolean): number {
  if (puddles <= 0.001) return 0
  const threshold = 0.8 - Math.min(1, puddles) * 0.3
  return smoothstep(threshold - 0.04, threshold + 0.06, puddleField(x, z, onRoad))
}

/** WGSL twin of the above. Needs `OL` (u8, win) in scope. */
export const outbreakPuddleDeclarationsWgsl = /* wgsl */ `
fn outbreakWetHash(p: vec2f) -> f32 {
  var q = fract(p * vec2f(0.1031, 0.1030));
  let d = q.x * (q.y + 33.33) + q.y * (q.x + 33.33);
  q += vec2f(d);
  return fract((q.x + q.y) * q.x);
}
fn outbreakWetNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = outbreakWetHash(i);
  let b = outbreakWetHash(i + vec2f(1.0, 0.0));
  let c = outbreakWetHash(i + vec2f(0.0, 1.0));
  let d = outbreakWetHash(i + vec2f(1.0, 1.0));
  return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
}
/** Ground wetness 0..1 (AR-71 weather cycle). */
fn outbreakWetness() -> f32 { return clamp(OL.u8.y, 0.0, 1.0); }
fn outbreakGutter(xz: vec2f) -> f32 {
  let b = xz - floor(xz / 96.0) * 96.0;
  let ez = min(abs(b.y - 40.0), abs(b.y - 48.0));
  let ex = min(abs(b.x - 40.0), abs(b.x - 48.0));
  let gz = select(0.0, 1.0 - smoothstep(0.15, 0.9, ez), b.y > 39.6 && b.y < 48.4);
  let gx = select(0.0, 1.0 - smoothstep(0.15, 0.9, ex), b.x > 39.6 && b.x < 48.4);
  return max(gz, gx);
}
/** Where water stands, 0..1: low spots and road gutters fill first, spreading as OL.u8.z (standing water) rises. */
fn outbreakPuddleMask(xz: vec2f, onRoad: bool) -> f32 {
  let puddles = clamp(OL.u8.z, 0.0, 1.0);
  if (puddles <= 0.001) { return 0.0; }
  let field = outbreakWetNoise(xz * 0.19 + vec2f(3.1, 7.4)) * 0.7 + outbreakWetNoise(xz * 0.53 + vec2f(11.3, 2.9)) * 0.3
    + select(0.0, outbreakGutter(xz) * 0.28, onRoad);
  let threshold = 0.8 - puddles * 0.3;
  return smoothstep(threshold - 0.04, threshold + 0.06, field);
}
`

/**
 * Darkens wet outdoor ground (statement block inside the surface hook, after the ground material; needs `col`,
 * `o`, `n`, `mat`, `inRoom`). Wet asphalt and concrete go darker, standing water darker still; grass a little.
 * Declares `outbreakWetPuddle` for the sheen below.
 */
export const outbreakWetGroundWgsl = /* wgsl */ `
    var outbreakWetPuddle = 0.0;
    let outbreakWet = outbreakWetness();
    if (outbreakWet > 0.002 && !inRoom && mat == 20 && n.y > 0.75 && o.world.y < 0.4) {
      let gKind = i32(round(o.aux));
      let hard = gKind == 1 || gKind == 2 || gKind == 3;
      outbreakWetPuddle = select(0.0, outbreakPuddleMask(o.world.xz, gKind == 1), hard);
      let soak = select(0.16, select(0.30, 0.38, gKind == 1), hard);
      col *= (1.0 - outbreakWet * soak) * (1.0 - outbreakWetPuddle * 0.32);
    }
`

/**
 * Wet gloss only in light (after the flashlight's irradiance is known; needs `flashIrr`, `outbreakPracticalIrr`,
 * `beamAdd`). Puddles catch the beam and lamps; outside light nothing changes, so there is no pattern in the dark.
 * Raindrop rings break the puddles' sheen up, band-limited by the pixel footprint.
 */
export const outbreakWetSheenWgsl = /* wgsl */ `
    if (outbreakWet > 0.002 && outbreakWetPuddle + outbreakWet > 0.01) {
      let gloss = clamp(OL.art.w, 0.0, 2.0);
      let film = outbreakWet * 0.10 + outbreakWetPuddle * 0.55;
      var ring = 0.0;
      if (outbreakWetPuddle > 0.05) {
        let fade = 1.0 - smoothstep(0.04, 0.16, surfaceFootprint);
        if (fade > 0.01) {
          let q = o.world.xz * 2.6;
          let cell = floor(q);
          let h = outbreakWetHash(cell);
          let age = fract(surfaceTime * 1.6 + h);
          let r = length(fract(q) - 0.5 - (vec2f(outbreakWetHash(cell + 7.1), h) - 0.5) * 0.4);
          let band = max(0.0, 1.0 - abs(r - (0.05 + age * 0.38)) * 20.0);
          ring = band * band * (1.0 - age) * fade;
        }
      }
      let lightIrr = clamp(flashIrr, 0.0, 2.0) + clamp(outbreakPracticalIrr, 0.0, 2.0) * 0.6;
      let sheen = beamAdd * film * (0.55 + 0.9 * ring) + vec3f(1.0, 0.62, 0.30) * clamp(outbreakPracticalIrr, 0.0, 2.0) * outbreakWetPuddle * 0.05 * (0.6 + ring);
      col += sheen * gloss * smoothstep(0.0, 0.08, lightIrr) * outbreakSeen;
    }
`
