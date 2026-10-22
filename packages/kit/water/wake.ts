/** Presentation-only Kelvin envelope. The game's trajectory and buoyancy remain authoritative. */
export type WaterWakeBoat = { x: number; z: number; heading: number; speed: number; wet: number }
export const WATER_WAKE_BOATS = 32
export const WATER_WAKE_FLOATS = 4 + WATER_WAKE_BOATS * 8

export function packWaterWakes(out: Float32Array, boats: readonly WaterWakeBoat[], originX: number, originZ: number, strength: number): void {
  const count = Math.min(boats.length, WATER_WAKE_BOATS)
  out[0] = count
  out[1] = strength
  for (let i = 0; i < count; i++) {
    const b = boats[i]!, o = 4 + i * 8
    out[o] = b.x - originX; out[o + 1] = b.z - originZ
    out[o + 2] = Math.sin(b.heading); out[o + 3] = -Math.cos(b.heading)
    out[o + 4] = Math.max(0, b.speed); out[o + 5] = b.wet
  }
}

export const WATER_WAKE_WGSL = /* wgsl */ `
struct WaterWakeHull { pose: vec4f, motion: vec4f }
struct WaterWakeUniform { info: vec4f, hulls: array<WaterWakeHull, ${WATER_WAKE_BOATS}> }
@group(1) @binding(4) var<uniform> WW: WaterWakeUniform;

// Diverging crests inside the deep-water Kelvin cusp, tan(asin(1/3)) = 1/sqrt(8).
// A bounded shading model; it does not change rendered or simulated wave heights.
fn waterKelvin(p: vec2f, footprint: f32) -> vec2f {
  var slope = vec2f(0.0);
  for (var i = 0u; i < u32(WW.info.x); i++) {
    let b = WW.hulls[i];
    let d = p - b.pose.xy;
    if (dot(d,d) > 260.0 * 260.0 || b.motion.x < 1.0) { continue; }
    let forward = b.pose.zw;
    let right = vec2f(-forward.y, forward.x);
    let behind = -dot(d,forward) - 7.0;
    let across = dot(d,right);
    if (behind <= 0.0 || behind > 230.0) { continue; }
    let cusp = abs(across) - behind * 0.35355339;
    let width = 2.0 + behind * 0.09;
    let envelope = exp(-cusp*cusp / (width*width)) * exp(-behind / 95.0)
      * smoothstep(0.0, 8.0, behind) * (1.0 - smoothstep(180.0, 230.0, behind));
    let wavelength = clamp(b.motion.x*b.motion.x / 9.81 * 0.48, 3.0, 18.0);
    let k = 6.2831853 / wavelength;
    let band = 1.0 - smoothstep(0.15, 0.55, footprint / wavelength);
    let phase = k * (abs(across) * 0.942809 - behind / 3.0);
    let strength = min(b.motion.x / 12.0, 1.0) * b.motion.y * WW.info.y;
    slope += (right * sign(across) * 0.942809 + forward / 3.0)
      * cos(phase) * envelope * 0.22 * strength * band;
  }
  return slope;
}
`
