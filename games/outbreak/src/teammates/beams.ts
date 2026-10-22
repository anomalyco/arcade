import type { LabControl } from "@arcade/kit/lab-panel"
import { LIGHT_FLOATS } from "@arcade/kit/limits"
import type { VisionBeam } from "../../shared/vision"

/** Today: a teammate's light is a dim 5–6 m plan spot that their own sight shroud hides ("It's just like a little hint"). */
export const TEAM_BEAMS_TODAY = 0
/**
 * Everyone's flashlight lights the world like your own: the same beam profile and range about their lens, a faint shaft
 * in the air, and what it lands on (zombies too) shows through your shroud (playtest Oct 21, "We can't see each
 * other's flashlights").
 */
export const TEAM_BEAMS_FULL = 1

/** Teammates' flashlights; the values live in the flashlight settings (Backquote › Flashlight). */
export const DEFAULT_TEAM_BEAM_SETTINGS = {
  teamBeams: TEAM_BEAMS_FULL,
  /** A teammate's beam strength next to your own (1 = the same light). */
  teamBeamPower: 1,
  /** Brightness of a teammate's shaft in the air (0 = no shaft). */
  teamBeamShaft: 0.35,
}

export type TeamBeamSettings = typeof DEFAULT_TEAM_BEAM_SETTINGS

export const teamBeamControls: LabControl[] = [
  {
    key: "teamBeams",
    label: "Teammates' flashlights",
    group: "Flashlight",
    options: [
      { label: "Full beams, seen through the shroud", value: TEAM_BEAMS_FULL },
      { label: "Today (dim 6 m hint)", value: TEAM_BEAMS_TODAY },
    ],
  },
  { key: "teamBeamPower", label: "Teammate beam strength", group: "Flashlight", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "teamBeamShaft", label: "Teammate beam shaft", group: "Flashlight", min: 0, max: 1.5, step: 0.05, unit: "" },
]

/** The cone code the scene's light hooks read as a teammate's beam (`mateBeamAttenuation` in lighting.ts). */
export const MATE_BEAM_CONE_W = 3

/**
 * Writes one teammate's beam into a light slot: lens position and range, colour and power, the plan axis in cone.xy,
 * its own outer half-angle in cone.z (radians, so a low local battery that narrows your beam leaves theirs alone), the
 * shaft strength in the fraction of the cone code (cone.w = 3 + shaft × 0.2), and the lens pitch in extra.x (shadowed
 * by the frame's wall occluders).
 */
export function writeMateBeam(
  lights: Float32Array,
  slot: number,
  beam: { x: number; y: number; h: number; yaw: number; pitch: number },
  range: number,
  rgb: readonly [number, number, number],
  power: number,
  coneDeg: number,
  shaft: number,
  occluders: number,
): void {
  const halfRad = (Math.max(10, Math.min(120, coneDeg)) * Math.PI) / 360
  const code = MATE_BEAM_CONE_W + Math.max(0, Math.min(1.5, shaft)) * 0.2
  lights.set(
    [beam.x, beam.h, beam.y, range, rgb[0], rgb[1], rgb[2], power, Math.cos(beam.yaw), Math.sin(beam.yaw), halfRad, code, beam.pitch, occluders, 0.06, -1],
    slot * LIGHT_FLOATS,
  )
}

/** A teammate's beam as sight: actors it lights count as seen (`Vision.actorVisible`). */
export function mateBeamSight(x: number, y: number, aim: number, range: number, coneDeg: number, output: number): VisionBeam {
  return { x, y, aimCos: Math.cos(aim), aimSin: Math.sin(aim), coneCos: Math.cos((coneDeg * Math.PI) / 360), range: range * Math.min(1, output * 1.5) }
}
