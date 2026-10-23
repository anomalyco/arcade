import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { BoneFrameLike, CapsuleShadows } from "@arcade/kit/gpu/shadows/capsule-shadows"
import { takeLyingBodies } from "./lying-bodies"
import type { OutbreakQualityProfile } from "../quality"
import { capsuleSettings, softShadowsOn, type OutbreakSoftShadowSettings } from "./settings"

type Rig = Partial<Record<string, BoneFrameLike | null | undefined>>

/** What one frame hands the soft shadows, after every body is posed and every light is packed. */
export type SoftShadowFrame = {
  settings: OutbreakSoftShadowSettings
  /** The active quality tier, for settings left on "Quality tier". */
  quality: Pick<OutbreakQualityProfile, "softShadowLights">
  /** Plan rect the camera sees (x0, z0, x1, z1). */
  rect: readonly [number, number, number, number]
  lights: Float32Array
  lightCount: number
  /** Unit direction toward the sun or moon (the scene's directional light). */
  sun: readonly [number, number, number]
  /** The local survivor's rig when it is drawn standing (not hidden, downed or in a car). */
  survivor: Rig | null
  /** Remote survivors' rigs drawn this frame. */
  others: (visit: (bones: Rig) => void) => void
  /** Zombie bodies drawn this frame, living and dead (`ZombieCrowdRenderer.forEachDrawnBody`). */
  zombies: (visit: (bones: Float32Array, off: number, hidden: number, scale: number, origin: readonly [number, number, number]) => void) => void
}

let current: SoftShadowPresenter | null = null

/** The frame renderer's presenter (proof telemetry), once made. */
export const currentSoftShadows = (): SoftShadowPresenter | null => current

/** Fills the kit's capsule shadows from Outbreak's bodies each frame; Today uploads only the header (off). */
export class SoftShadowPresenter {
  private readonly shadows: CapsuleShadows
  /** Last frame: bodies and capsules sent, and CPU time in ms (proofs). */
  readonly stats = { on: false, bodies: 0, capsules: 0, cpuMs: 0 }

  constructor(renderer: Pick<Renderer, "capsuleShadows">) {
    this.shadows = renderer.capsuleShadows()
    current = this
  }

  frame(f: SoftShadowFrame): void {
    const t0 = performance.now()
    const on = softShadowsOn(f.settings)
    const s = this.shadows
    s.begin(f.rect)
    if (on) {
      if (f.survivor) s.addBonePose(f.survivor)
      f.others((bones) => s.addBonePose(bones))
      f.zombies((bones, off, hidden, scale, origin) => s.addBoneFrames(bones, off, hidden, scale, origin))
      takeLyingBodies((x, y, z, yaw) => s.addLyingBody(x, y, z, yaw))
    } else takeLyingBodies(() => {})
    s.upload(f.lights, f.lightCount, capsuleSettings(f.settings, f.quality), f.sun)
    this.stats.on = on
    this.stats.bodies = on ? s.characterCount : 0
    this.stats.capsules = on ? s.capsuleCount : 0
    this.stats.cpuMs = performance.now() - t0
  }
}
