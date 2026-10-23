import type { WaterSettings } from "@arcade/kit/water/settings"
import type { WaterWakeBoat } from "@arcade/kit/water/wake"

/**
 * Wake field (Sea of Thieves-style "travelling window" foam): a camera-centred plan texture that hull passes draw
 * foam strength into each frame and the ocean shader samples, so wakes break up with the water and use the same foam
 * look as crest foam and surf. R = foam strength 0..1, G = foam age 0..1 (fresh churn → old, coarse foam).
 *
 * One target per device, shared through `wakeTarget(device)`: whoever draws (src/game/wake.ts) sets `centre` for the
 * frame before the ocean's update reads it, and renders in its `prepare`, before the main pass samples it. Nothing
 * draws → the target stays clear and the ocean shows no wake.
 */
export const WAKE_RES = 2048
/** Metres per texel. */
export const WAKE_TEXEL = 2
/** Side of the window in metres. */
export const WAKE_SIZE = WAKE_RES * WAKE_TEXEL
/** The window centre snaps to this grid (metres), so texels stay world-anchored as the camera moves. */
export const WAKE_SNAP = 64
export const WAKE_FORMAT: GPUTextureFormat = "rg8unorm"

export type WakeTarget = {
  readonly texture: GPUTexture
  readonly view: GPUTextureView
  /** World plan centre of the window this frame. */
  readonly centre: Float64Array
  water?: WaterSettings
  readonly boats: WaterWakeBoat[]
}

const targets = new WeakMap<GPUDevice, WakeTarget>()

export function wakeTarget(device: GPUDevice): WakeTarget {
  let t = targets.get(device)
  if (!t) {
    const texture = device.createTexture({
      label: "wake-field",
      size: [WAKE_RES, WAKE_RES],
      format: WAKE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    t = { texture, view: texture.createView(), centre: new Float64Array(2), boats: [] }
    targets.set(device, t)
  }
  return t
}

/** Snaps the window centre near (x, z). */
export function setWakeCentre(t: WakeTarget, x: number, z: number): void {
  t.centre[0] = Math.round(x / WAKE_SNAP) * WAKE_SNAP
  t.centre[1] = Math.round(z / WAKE_SNAP) * WAKE_SNAP
}
