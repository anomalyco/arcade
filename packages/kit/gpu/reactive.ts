/**
 * The temporal reactive mask's draw contract (`@arcade/kit/gpu/temporal`). Under temporal AA the renderer runs one pass
 * after the scene into an rgba8 mask at the internal size: one sample, no depth, group 0 the scene's Frame group (the
 * jittered camera). Anything that moves on its own (sprites, particles, rain, splatter drops, smoke, motes, flying
 * debris) redraws itself there with its own vertex stage; the resolve trusts the current frame where the mask is lit, so
 * it neither smears nor averages away what the camera's reprojection can't follow.
 */

export const REACTIVE_FORMAT = "rgba8unorm" satisfies GPUTextureFormat

/** Additive into the mask: overlapping layers saturate instead of covering each other. */
export const REACTIVE_TARGET: GPUColorTargetState = {
  format: REACTIVE_FORMAT,
  blend: { color: { srcFactor: "one", dstFactor: "one" }, alpha: { srcFactor: "one", dstFactor: "one" } },
}

/** Full coverage for opaque geometry (flying debris, thrown items), whose lit colour says nothing about coverage. */
export const REACTIVE_COVERAGE_WGSL = /* wgsl */ `
@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }
`

/**
 * The reactive twin of a scene pipeline: the same layout, vertex stage and (unless `fragment` replaces it) fragment
 * stage, writing only its first colour output into the mask, without depth or multisampling. A transparent layer's own
 * fragment output is its mask value (premultiplied colour and coverage, the largest channel counts).
 */
export function reactivePipelineDescriptor(
  desc: GPURenderPipelineDescriptor,
  fragment?: Omit<GPUFragmentState, "targets">,
): GPURenderPipelineDescriptor {
  const { depthStencil: _depth, multisample: _samples, ...rest } = desc
  const stage = fragment ?? desc.fragment
  if (!stage) throw new Error("reactive pipeline needs a fragment stage")
  return {
    ...rest,
    label: `${desc.label ?? "scene"} (reactive)`,
    fragment: { module: stage.module, entryPoint: stage.entryPoint, constants: stage.constants, targets: [REACTIVE_TARGET] },
  }
}
