import { DAYNIGHT_WGSL } from "./daynight-wgsl"
import { FRAME } from "./frame"

type Vec3 = readonly [number, number, number]

/** Sun, sky and haze. Colours are linear HDR radiance; the composite tone-maps them. */
export type Atmosphere = {
  /** Unit vector toward the sun: lighting. */
  sunDir: Vec3
  /**
   * Where the sun disc, its glow and its glitter path on the sea sit (sky, ocean and clouds read it from their own
   * uniforms). Same azimuth as sunDir but lower: the concepts paint the sun just above the horizon with a long glitter
   * path while lighting the scene like midday.
   */
  sunView?: Vec3
  sunIntensity: number
  sunColor: Vec3
  /** Sky ambient multiplier for surfaces. */
  ambient: number
  zenith: Vec3
  horizon: Vec3
  /** Fog extinction per metre toward the horizon colour. */
  fog: number
  /**
   * 0..1 overcast (weather): veils the sun disc, its halo, glow and glitter, and turns the distant sea from blue to the
   * grey of an overcast horizon. 0 or absent: the sunny look, untouched. Sent as the Frame's zenith.w.
   */
  overcast?: number
}

const toward = (azimuthDeg: number, elevationDeg: number): Vec3 => {
  // Azimuth is clockwise from north (-z), so 90 is east (+x).
  const a = (azimuthDeg * Math.PI) / 180
  const e = (elevationDeg * Math.PI) / 180
  return [Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)]
}

/**
 * A clear tropical midday. The default camera looks north, so the sun sits ahead and to the right, high enough that
 * its glitter path lands in the lower right of the view like the concepts. The far islands melt into the haze.
 */
export const ATMOSPHERE: Atmosphere = {
  sunDir: toward(26, 34),
  sunView: toward(26, 7.5),
  sunIntensity: 3.1,
  sunColor: [1.0, 0.93, 0.8],
  ambient: 0.6,
  zenith: [0.03, 0.15, 0.66],
  horizon: [0.45, 0.68, 1.0],
  fog: 7.0e-5,
}

/** Writes sunDir, sunColor, zenith and horizon (with fog density) into a packed Frame. */
export function fillAtmosphere(frame: Float32Array, a: Atmosphere = ATMOSPHERE): void {
  frame.set(a.sunDir, FRAME.sunDir)
  frame[FRAME.sunDir + 3] = a.sunIntensity
  frame.set(a.sunColor, FRAME.sunColor)
  frame[FRAME.sunColor + 3] = a.ambient
  frame.set(a.zenith, FRAME.zenith)
  frame[FRAME.zenith + 3] = a.overcast ?? 0
  frame.set(a.horizon, FRAME.horizon)
  frame[FRAME.horizon + 3] = a.fog
}

/**
 * Shared sky and haze helpers. Requires `F: Frame` in scope (use FRAME_BINDING_WGSL). `hazeColor` is the colour fog
 * fades to along a view direction, and equals the sky at the horizon, so distant surfaces melt into the sky.
 * `overcast()` (F.zenith.w) veils every sun term and greys the sea haze.
 */
export const ATMOSPHERE_WGSL = /* wgsl */ `
fn overcast() -> f32 { return F.zenith.w; }
/** Share of the sun's disc, halo and glints left under the overcast. */
fn sunVeil() -> f32 { return 1.0 - F.zenith.w; }

fn sunGlow(dir: vec3f) -> f32 {
  let c = max(dot(dir, F.sunDir.xyz), 0.0);
  return (pow(c, 6.0) * 0.18 + pow(c, 64.0) * 0.35) * sunVeil();
}

fn hazeColor(dir: vec3f) -> vec3f {
  let flat = normalize(vec3f(dir.x, 0.0, dir.z) + vec3f(0.0, 1e-4, 0.0));
  return F.horizon.rgb + F.sunColor.rgb * sunGlow(flat);
}

/** Sky radiance along a view direction, including the sun disc. */
fn skyColor(dir: vec3f) -> vec3f { return skyColorAt(dir, F.sunDir.xyz); }

/** Sky with the sun disc placed at s. */
fn skyColorAt(dir: vec3f, s: vec3f) -> vec3f {
  var c = skyNoSunAt(dir, s);
  let c2 = max(dot(dir, s), 0.0);
  let veil = sunVeil();
  c += F.sunColor.rgb * (pow(c2, 40.0) * 0.4 + pow(c2, 160.0) * 1.0 + (pow(c2, 1800.0) * 4.0 + smoothstep(0.99955, 0.99968, c2) * 40.0) * (1.0 - F.extra.w)) * veil * veil;
  return c;
}

/**
 * Sky along a direction without the sun disc or its tight corona (the sea's sky reflection: the sun is its specular
 * term). A deep zenith, a paler band low down, and a soft glow around the sun.
 */
fn skyNoSun(dir: vec3f) -> vec3f { return skyNoSunAt(dir, F.sunDir.xyz); }

fn skyNoSunAt(dir: vec3f, s: vec3f) -> vec3f {
  let up = max(dir.y, 0.0);
  // A bright pale band at the horizon (brighter than the fog, so far islands read as soft blue silhouettes), fading
  // to a deep saturated zenith within ~25 degrees, like the concepts.
  // Under an overcast the pale blue band goes neutral grey (the deck is lit evenly), and the zenith stays close to it.
  // In the warm twilight (Frame extra.y) the band takes the horizon colour as given: sunset oranges stay orange.
  let low = hazeColor(dir) * mix(vec3f(0.74, 1.1, 1.55), vec3f(1.0), max(overcast(), F.extra.y));
  // The warm twilight band is narrower, so a golden-hour sky is still blue overhead.
  var c = mix(low, F.zenith.rgb, pow(smoothstep(0.0, 0.38 - 0.18 * F.extra.y, up), 0.45));
  let c2 = max(dot(dir, s), 0.0);
  c += F.sunColor.rgb * pow(c2, 12.0) * 0.18 * sunVeil();
  return c;
}

/** Distant sea seen along a (downward) view direction: darker and bluer than the sky's horizon, plus the sun glow. */
fn seaHaze(dir: vec3f) -> vec3f { return seaHazeAt(dir, F.sunDir.xyz); }

fn seaHazeAt(dir: vec3f, s: vec3f) -> vec3f {
  let flat = normalize(vec3f(dir.x, 0.0, dir.z) + vec3f(0.0, 1e-4, 0.0));
  let c = max(dot(flat, normalize(vec3f(s.x, 0.0, s.z))), 0.0);
  // The glow lives near the horizon: looking steeply down from altitude it must not paint a beam across the sea.
  let low = 1.0 - smoothstep(0.04, 0.35, -dir.y);
  // Under an overcast the far sea is grey-green slate a little darker than the horizon, never a dark blue band.
  let tint = mix(vec3f(0.19, 0.47, 0.86), vec3f(0.74, 0.8, 0.8), overcast());
  return F.horizon.rgb * tint + F.sunColor.rgb * (pow(c, 8.0) * 0.08 + pow(c, 90.0) * 0.3) * low * sunVeil();
}

${DAYNIGHT_WGSL}
/** Fades a surface colour at world position p toward the haze. */
fn applyFog(color: vec3f, p: vec3f) -> vec3f {
  let d = p - F.eye.xyz;
  let dist = length(d);
  let f = 1.0 - exp(-dist * F.horizon.w);
  // In the warm twilight (Frame extra.y) islands against the low sun stay silhouettes: the haze keeps less sun glow.
  let dir = d / max(dist, 1e-3);
  let haze = hazeColor(dir) - F.sunColor.rgb * sunGlow(normalize(vec3f(dir.x, 0.0, dir.z) + vec3f(0.0, 1e-4, 0.0))) * 0.8 * F.extra.y;
  return mix(color, haze, f);
}
`
