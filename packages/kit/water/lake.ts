import type { ForestLake } from "../sim/forest-world"

export const LAKE_PERIOD = 64
export const lakeTime = (time: number) => ((time % LAKE_PERIOD) + LAKE_PERIOD) % LAKE_PERIOD
/** Keep the whole authoring log inside the shore, including translated/resized lakes. */
export function lakePoint(lake: ForestLake, x: number, z: number) {
  const rx = Math.max(0.1, lake.rx - 2), rz = Math.max(0.1, lake.rz - 2)
  const dx = (x - lake.x) / rx, dz = (z - lake.z) / rz
  const k = Math.max(1, Math.hypot(dx, dz))
  return { x: lake.x + dx / k * rx, z: lake.z + dz / k * rz }
}

/** Original surface-only lake optics. The host supplies its real sky, lights and bathymetry. */
export const LAKE_WGSL = /* wgsl */ `
fn lakeRipples(p: vec2f, t: f32, rain: f32) -> vec2f {
  var slope = vec2f(0.0);
  // Independent wind bands, slowly phase-modulated to avoid a repeating lattice.
  for (var i = 0u; i < 5u; i++) {
    let k = f32(i);
    let dir = vec2f(cos(k * 2.399 + 0.4), sin(k * 2.399 + 0.4));
    let wave = 1.8 * pow(2.17, k);
    let omega = round(sqrt(9.81 * wave) * 64.0 / 6.2831853) * (6.2831853 / 64.0);
    let phase = dot(p, dir) * wave - t * omega + noise2(p * 0.12 + k * 17.0) * 3.0;
    slope += dir * cos(phase) * (0.025 / (1.0 + k * 0.5));
  }
  if (rain > 0.0) {
    let cell = floor(p / 1.7);
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let id = cell + vec2f(f32(x), f32(y));
        let h = hash2(id + 53.1);
        let age = fract(t * (45.0 / 64.0) + h);
        let centre = (id + vec2f(hash2(id + 8.2), hash2(id + 19.7))) * 1.7;
        let delta = p - centre;
        let r = length(delta);
        let ring = r - age * 1.5;
        slope += delta / max(r, 0.001) * cos(ring * 40.0) * exp(-ring * ring * 90.0)
          * sin(age * 3.14159265) * 0.018 * rain;
      }
    }
  }
  return slope;
}
// Fresnel, transmission and the lunar lobe come from kit water (water/shader.ts).
const LAKE_ABSORPTION = vec3f(0.75, 0.32, 0.20); // per metre
const LAKE_MOON_ROUGHNESS = 0.1414; // alpha² = 0.0004: calm capillary chop
// Slowly drifting patches break the lunar path; periodic over the 64 s lake clock.
fn lakeBreakup(p: vec2f, t: f32) -> f32 {
  let drift = vec2f(cos(t * 6.2831853 / 64.0), sin(t * 6.2831853 / 64.0));
  return mix(0.12, 1.0, smoothstep(0.3, 0.75, noise2(p * vec2f(4.0, 9.0) + drift)));
}
`
