/** Frame uniform: 48 floats (192 bytes), bind group 0 binding 0 in every scene pass. See CONTRACTS.md. */
export const FRAME_FLOATS = 48

/** Float offsets of each field in the packed Frame. */
export const FRAME = {
  viewProj: 0,
  eye: 16,
  sunDir: 20,
  sunColor: 24,
  zenith: 28,
  horizon: 32,
  viewport: 36,
  forward: 40,
  extra: 44,
} as const

/**
 * eye.w carries sea time modulo this many seconds, for cheap animation only (foliage, grain). Periodic shader
 * animation should use angular frequencies that are whole multiples of 2π / TIME_WRAP so the wrap is seamless.
 */
export const TIME_WRAP = 3600

export const FRAME_WGSL = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  eye: vec4f,      // camera position xyz, w = sea time in seconds (wrapped)
  sunDir: vec4f,   // unit vector toward the sun, w = sun intensity
  sunColor: vec4f, // rgb, w = ambient strength
  zenith: vec4f,   // sky colour overhead
  horizon: vec4f,  // sky colour at the horizon, w = fog density (per metre)
  viewport: vec4f, // w, h, 1/w, 1/h in pixels
  forward: vec4f,  // camera forward xyz
  extra: vec4f,    // day-night: night, warm twilight, practical lights, moon as key light (all 0 by day)
}
`

/** The Frame struct plus its binding as `F`, for passes that use the shared atmosphere helpers. */
export const FRAME_BINDING_WGSL = /* wgsl */ `${FRAME_WGSL}
@group(0) @binding(0) var<uniform> F: Frame;
`
