import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Combat feel values that were hard-coded in the feel tracker and the melee feel hook: hit-stop per kind of hit (ms of
 * presentation slowed to 8%), the bullet impact flash and the zombie strike lunge. Presentation only; the simulation
 * never reads them. Defaults are the values the game shipped with.
 */
export const DEFAULT_FEEL_TUNING = {
  hitStopShotHit: 0,
  hitStopShotKill: 22,
  hitStopShove: 28,
  hitStopMeleeLight: 26,
  hitStopMeleeStrong: 36,
  hitStopMeleeHeavy: 44,
  hitStopHitTaken: 26,
  /** Spark and dust where a missed round strikes, × size and brightness (0 = off). */
  impactFlash: 1,
  /** How far a zombie lunges when its strike lands, × (0 = off). */
  strikeLunge: 1,
}

export type FeelTuning = typeof DEFAULT_FEEL_TUNING

const hitStop = (key: keyof FeelTuning, label: string): LabControl => ({
  key,
  label,
  group: "Feel",
  min: 0,
  max: 120,
  step: 2,
  unit: "ms",
})

export const feelControls: readonly LabControl[] = [
  hitStop("hitStopShotHit", "Hit-stop: bullet hit"),
  hitStop("hitStopShotKill", "Hit-stop: bullet kill"),
  hitStop("hitStopShove", "Hit-stop: shove"),
  hitStop("hitStopMeleeLight", "Hit-stop: melee hit"),
  hitStop("hitStopMeleeStrong", "Hit-stop: melee kill or head"),
  hitStop("hitStopMeleeHeavy", "Hit-stop: heavy melee"),
  hitStop("hitStopHitTaken", "Hit-stop: survivor hit"),
  { key: "impactFlash", label: "Bullet impact flash", group: "Feel", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "strikeLunge", label: "Zombie strike lunge", group: "Feel", min: 0, max: 2, step: 0.05, unit: "×" },
]

/** Hit-stop seconds for a Lab value in milliseconds. */
export const hitStopSeconds = (ms: number) => Math.max(0, ms) / 1000

/**
 * On-foot camera lead. The follow trails a moving survivor by speed / 6 s⁻¹ (0.54 m walking, 0.89 m sprinting), so
 * without a lead the screen shows more of where you came from than where you are going.
 */
export const DEFAULT_CAMERA_LEAD = {
  /** Lead along the survivor's velocity, in seconds of travel (0.17 s cancels the trail at any speed). */
  cameraMoveLead: 0,
  /** Lead toward the aim, in metres. */
  cameraAimLead: 0,
}

export type CameraLeadSettings = typeof DEFAULT_CAMERA_LEAD

export const cameraLeadControls: readonly LabControl[] = [
  { key: "cameraMoveLead", label: "Lead movement", group: "Camera", min: 0, max: 0.6, step: 0.01, unit: "s" },
  { key: "cameraAimLead", label: "Lead toward aim", group: "Camera", min: 0, max: 4, step: 0.1, unit: "m" },
]

/** The on-foot look offset the camera eases toward: velocity × lead time plus a fixed distance along the aim. */
export function onFootLead(
  p: { vx: number; vy: number; aim: number },
  lead: CameraLeadSettings,
): { x: number; y: number } {
  return {
    x: p.vx * lead.cameraMoveLead + Math.cos(p.aim) * lead.cameraAimLead,
    y: p.vy * lead.cameraMoveLead + Math.sin(p.aim) * lead.cameraAimLead,
  }
}
