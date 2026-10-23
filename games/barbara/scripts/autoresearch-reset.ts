import type { ForestFrameInput, ForestView } from "../../../packages/kit/forest/view"
import type { WoodsWorld } from "../shared/world"

declare const woods: { world: WoodsWorld; view: { forest: ForestView; setWorld(world: WoodsWorld): void }; __input: ForestFrameInput; step(ms: number): void; setPose(x: number, z: number, yaw: number, pitch?: number): void }

/** Real GPU readback regression: a queued old scene must not survive a cut; the first new meter snaps. */
export async function resetProbe() {
  const f = woods.view.forest, renderer = f.renderer, device = renderer.passContext.device
  const check = (ok: boolean, message: string) => { if (!ok) throw new Error(message) }
  // Pausing the game does not cancel a frame already queued by the renderer's automatic scheduler.
  // Drain that startup work so the stale-read check owns every subsequent submission.
  for (let i = 0; i < 8; i++) {
    await device.queue.onSubmittedWorkDone()
    await new Promise(r => setTimeout(r, 0))
    if (!renderer.hasPending) break
  }
  check(!renderer.hasPending, "automatic renderer did not drain after pause")
  await device.queue.onSubmittedWorkDone()
  await new Promise(r => setTimeout(r, 0))
  // Queue old readings, then reset before their mapAsync callbacks land.
  woods.step(1000 / 60)
  f.resetExposure()
  await device.queue.onSubmittedWorkDone()
  await new Promise(r => setTimeout(r, 0))
  check(renderer.sceneMeter === null, "old in-flight meter survived reset")
  const eye = woods.__input.eye
  woods.setPose(eye[0] + 0.1, eye[2], 0, -0.2)
  check(f.camera.exposure === 1, "short teleport failed to reset exposure")
  // Exercise several update-only frames without submitting new meter work.
  for (let i = 0; i < 3; i++) {
    f.update(woods.__input)
    check(f.camera.exposure === 1, "pending meter used a fallback exposure before its first reading")
  }
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
  f.update({ ...woods.__input, eye: [eye[0] + 4, eye[1], eye[2]] })
  check(renderer.sceneMeter === null, "authoritative camera jump kept the old meter")
  woods.view.setWorld(woods.world)
  check(f.camera.exposure === 1 && renderer.sceneMeter === null, "world rebuild failed to reset exposure")
  return { staleReadDiscarded: true, shortTeleportReset: true, pendingReadingHeld: true, cameraJumpReset: true, regenerationReset: true, firstReadingErrorStops: error, frames }
}
