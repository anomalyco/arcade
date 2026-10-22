import type { ForestFrameInput, ForestView } from "../../../packages/kit/forest/view"

declare const woods: { view: { forest: ForestView }; __input: ForestFrameInput; step(ms: number): void; setPose(x: number, z: number, yaw: number, pitch?: number): void }

/** Real GPU readback regression: a queued old scene must not survive a cut; the first new meter snaps. */
export async function resetProbe() {
  const f = woods.view.forest, renderer = f.renderer, device = renderer.passContext.device
  const check = (ok: boolean, message: string) => { if (!ok) throw new Error(message) }
  // Queue old readings, then reset before their mapAsync callbacks land.
  woods.step(1000 / 60)
  f.resetExposure()
  await device.queue.onSubmittedWorkDone()
  await new Promise(r => setTimeout(r, 0))
  check(renderer.sceneMeter === null, "old in-flight meter survived reset")
  const eye = woods.__input.eye
  woods.setPose(eye[0] + 0.1, eye[2], 0, -0.2)
  check(f.camera.exposure === 1, "short teleport failed to reset exposure")
  let frames = 0
  while (!renderer.sceneMeter && frames++ < 32) {
    woods.step(1000 / 60)
    await device.queue.onSubmittedWorkDone()
    await new Promise(r => setTimeout(r, 0))
  }
  const meter = renderer.sceneMeter
  check(!!meter, "new scene meter never arrived")
  const s = f.settings
  const luminance = (s.exposureModel === "robust" ? meter!.logMean : meter!.centre) * s.meterGain
  const target = s.exposureModel === "robust" ? s.nightStops - Math.log2(Math.max(luminance, 1e-6) / s.nightKey) * s.nightStrength : -Math.log2(Math.max(luminance, 1e-6) / 0.09) * 0.55
  f.update(woods.__input)
  const error = Math.abs(Math.log2(f.camera.exposure) - Math.max(-s.adaptRange, Math.min(s.adaptLift, target)))
  check(error < 1e-8, "first valid reading adapted instead of snapping")
  return { staleReadDiscarded: true, shortTeleportReset: true, firstReadingErrorStops: error, frames }
}
