import { wgslStruct } from "@arcade/kit/gpu/wgsl"

export const CarrierFrameStruct = wgslStruct("Frame", {
  viewProj: "mat4x4f",
  eye: "vec4f",
  sunDir: "vec4f",
  sunColor: "vec4f",
  zenith: "vec4f",
  horizon: "vec4f",
  viewport: "vec4f",
  forward: "vec4f",
  extra: "vec4f",
})

/** Frame uniform: 48 floats (192 bytes), bind group 0 binding 0 in every scene pass. See CONTRACTS.md. */
export const FRAME_FLOATS = CarrierFrameStruct.floatCount

/** Float offsets of each field in the packed Frame. */
export const FRAME = {
  viewProj: CarrierFrameStruct.offsetOf("viewProj"),
  eye: CarrierFrameStruct.offsetOf("eye"),
  sunDir: CarrierFrameStruct.offsetOf("sunDir"),
  sunColor: CarrierFrameStruct.offsetOf("sunColor"),
  zenith: CarrierFrameStruct.offsetOf("zenith"),
  horizon: CarrierFrameStruct.offsetOf("horizon"),
  viewport: CarrierFrameStruct.offsetOf("viewport"),
  forward: CarrierFrameStruct.offsetOf("forward"),
  extra: CarrierFrameStruct.offsetOf("extra"),
} as const

/**
 * eye.w carries sea time modulo this many seconds, for cheap animation only (foliage, grain). Periodic shader
 * animation should use angular frequencies that are whole multiples of 2π / TIME_WRAP so the wrap is seamless.
 */
export const TIME_WRAP = 3600

export const FRAME_WGSL = `\n${CarrierFrameStruct.wgsl}\n`

/** The Frame struct plus its binding as `F`, for passes that use the shared atmosphere helpers. */
export const FRAME_BINDING_WGSL = /* wgsl */ `${FRAME_WGSL}
@group(0) @binding(0) var<uniform> F: Frame;
`
