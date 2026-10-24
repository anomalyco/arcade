// Presentation only: the camera, the felled crown's motion, the lights and the gore. The sim never reads these.
import type { LabControl } from "@arcade/kit/lab-navigation"

export const LOOK = {
  // Low chase camera.
  chasePitch: 0.26,
  chaseDist: 5.2,
  chaseHeight: 1.35,
  chaseFov: 58,
  chaseLead: 0.6,
  chaseSide: 0.55,
  chaseTurn: 3.5,
  chaseCollide: 1,
  // Felling cam: when a tree you cut goes over, a low eye off your shoulder watches it come down.
  fellCam: 1,
  fellCamTime: 3.2,
  fellCamDist: 5.5,
  fellCamHeight: 1.4,
  // Fall hint: a faint line of pale dots on the ground while you cut (0 off).
  fallHint: 0.35,
  // Felled crown.
  crownLag: 0.06,
  crownFlutter: 0.25,
  crownWhip: 0.5,
  crownShake: 0.7,
  crownFreq: 1.1,
  crownDamp: 0.16,
  creak: 0.006,
  // Lights.
  torchLevel: 1,
  sawLight: 0.5,
  truckLamps: 1.6,
  fxLight: 1,
  fxLightReach: 9,
  glare: 0.1,
  // Gore.
  bloodPool: 1,
  bloodDrops: 1,
  landingShake: 1,
}

export type LookConfig = typeof LOOK

const range = (key: keyof LookConfig, label: string, group: string, min: number, max: number, step: number, unit?: string): LabControl => ({ key, label, group, min, max, step, ...(unit ? { unit } : {}) })

export const LOOK_CONTROLS: LabControl[] = [
  range("chasePitch", "Chase pitch", "Camera", 0, 1.2, 0.01, "rad"),
  range("chaseDist", "Chase distance", "Camera", 2, 16, 0.1, "m"),
  range("chaseHeight", "Chase look height", "Camera", 0.5, 3, 0.05, "m"),
  range("chaseFov", "Chase field of view", "Camera", 30, 90, 1, "°"),
  range("chaseLead", "Chase look ahead", "Camera", 0, 3, 0.05, "m"),
  range("chaseSide", "Chase over the right shoulder", "Camera", -1.5, 1.5, 0.05, "m"),
  range("chaseTurn", "Chase turn towards aim", "Camera", 0, 12, 0.1, "/s"),
  range("chaseCollide", "Pull in at trunks", "Camera", 0, 1, 1),
  range("fellCam", "Felling cam", "Camera", 0, 1, 1),
  range("fellCamTime", "Felling cam hold", "Camera", 0.5, 8, 0.1, "s"),
  range("fellCamDist", "Felling cam: back from you", "Camera", 1.5, 15, 0.25, "m"),
  range("fellCamHeight", "Felling cam: eye height", "Camera", 0.4, 6, 0.1, "m"),
  range("fallHint", "Fall hint while cutting", "Felling look", 0, 1, 0.05),
  range("crownLag", "Crown lag in the fall", "Felling look", 0, 0.3, 0.005, "rad·s²"),
  range("crownFlutter", "Crown flutter in the fall", "Felling look", 0, 1, 0.01, "m·s"),
  range("crownWhip", "Crown whip on landing", "Felling look", 0, 2, 0.05),
  range("crownShake", "Crown thrash on landing", "Felling look", 0, 3, 0.05, "m·s"),
  range("crownFreq", "Crown spring", "Felling look", 0.3, 3, 0.05, "Hz"),
  range("crownDamp", "Crown damping", "Felling look", 0.02, 1, 0.01),
  range("creak", "Creak shiver", "Felling look", 0, 0.03, 0.001, "rad"),
  range("landingShake", "Landing shake", "Felling look", 0, 3, 0.05, "×"),
  range("torchLevel", "Survivor torches", "Lights", 0, 3, 0.05, "×"),
  range("sawLight", "Helmet lamp (runs with the saw)", "Lights", 0, 3, 0.05, "×"),
  range("truckLamps", "Truck lamps", "Lights", 0, 4, 0.05, "×"),
  range("fxLight", "Lights on chips and smoke", "Lights", 0, 4, 0.05, "×"),
  range("fxLightReach", "Light reach on chips and smoke", "Lights", 2, 30, 0.5, "m"),
  range("glare", "Veiling glare (lifts the whole frame)", "Lights", 0, 1, 0.01),
  range("bloodPool", "Blood pools", "Gore", 0, 3, 0.05, "×"),
  range("bloodDrops", "Blood drops", "Gore", 0, 3, 0.05, "×"),
]
