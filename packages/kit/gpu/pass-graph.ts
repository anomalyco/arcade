/**
 * Shared scene-pass plugin contract (`ScenePass`, `PassList`), depth-buffer convention
 * descriptors (`DepthMode`), and WGSL module compilation diagnostics across Arcade renderers.
 */

export type PassSlot = "sky" | "opaque" | "alpha"

export const PASS_SLOTS: readonly PassSlot[] = ["sky", "opaque", "alpha"] as const

/**
 * Depth-buffer convention for a renderer's main scene pass:
 * - `"standard"`: `depth24plus`, clear `1`, `less-equal` (top-down / three-quarter indoor & town scenes)
 * - `"stencil"`: `depth24plus-stencil8`, clear `1`, `less` (scenes with stencil-masked occluded silhouettes)
 * - `"reversed-z"`: `depth32float`, clear `0`, `greater-equal` (40 km ocean/flight horizons with zero Z-fighting)
 */
export type DepthMode = "standard" | "stencil" | "reversed-z"

export interface DepthModeConfig {
  readonly mode: DepthMode
  readonly format: GPUTextureFormat
  readonly clearValue: number
  readonly compare: GPUCompareFunction
  readonly hasStencil: boolean
}

export function depthConfigForMode(mode: DepthMode): DepthModeConfig {
  switch (mode) {
    case "stencil":
      return {
        mode,
        format: "depth24plus-stencil8",
        clearValue: 1,
        compare: "less",
        hasStencil: true,
      }
    case "reversed-z":
      return {
        mode,
        format: "depth32float",
        clearValue: 0,
        compare: "greater-equal",
        hasStencil: false,
      }
    case "standard":
    default:
      return {
        mode: "standard",
        format: "depth24plus",
        clearValue: 1,
        compare: "less-equal",
        hasStencil: false,
      }
  }
}

export interface PassContext {
  readonly device: GPUDevice
  /** Group 0: the Frame uniform bind group layout, visible to vertex + fragment. */
  readonly frameLayout: GPUBindGroupLayout
  /** `"rgba16float"` HDR color target format. */
  readonly color: GPUTextureFormat
  /** Depth attachment format (`"depth24plus"`, `"depth24plus-stencil8"`, or `"depth32float"`). */
  readonly depth: GPUTextureFormat
  /** MSAA sample count (4). */
  readonly samples: number
}

export interface ScenePass {
  /** Called inside the main HDR render pass with group 0 (Frame) already bound. Set your own pipeline and group 1+. */
  draw(pass: GPURenderPassEncoder): void
  /** Optional: encode work (compute, offscreen passes) before the main HDR pass begins. */
  prepare?(enc: GPUCommandEncoder): void
}

/**
 * Ordered registry of `ScenePass` plugins grouped into `"sky"`, `"opaque"`, and `"alpha"` slots.
 */
export class PassList {
  private readonly slots: Record<PassSlot, ScenePass[]> = {
    sky: [],
    opaque: [],
    alpha: [],
  }

  add(slot: PassSlot, pass: ScenePass): void {
    this.slots[slot].push(pass)
  }

  remove(pass: ScenePass): boolean {
    for (const slot of PASS_SLOTS) {
      const list = this.slots[slot]
      const idx = list.indexOf(pass)
      if (idx >= 0) {
        list.splice(idx, 1)
        return true
      }
    }
    return false
  }

  prepareAll(enc: GPUCommandEncoder): void {
    for (const slot of PASS_SLOTS) {
      const list = this.slots[slot]
      for (let i = 0; i < list.length; i++) {
        list[i]!.prepare?.(enc)
      }
    }
  }

  drawSlot(slot: PassSlot, pass: GPURenderPassEncoder): void {
    const list = this.slots[slot]
    for (let i = 0; i < list.length; i++) {
      list[i]!.draw(pass)
    }
  }

  count(slot?: PassSlot): number {
    if (slot) return this.slots[slot].length
    return this.slots.sky.length + this.slots.opaque.length + this.slots.alpha.length
  }
}

/**
 * Compiles a WGSL shader module and asynchronously logs any compilation errors with `[wgsl label:line:col]`.
 */
export function compileShaderModuleWithLog(device: GPUDevice, code: string, label: string): GPUShaderModule {
  const m = device.createShaderModule({ code, label })
  m.getCompilationInfo?.().then(
    (info) => {
      for (const msg of info.messages) {
        if (msg.type === "error") {
          console.error(`[wgsl ${label}:${msg.lineNum}:${msg.linePos}] ${msg.message}`)
        }
      }
    },
    () => undefined,
  )
  return m
}
