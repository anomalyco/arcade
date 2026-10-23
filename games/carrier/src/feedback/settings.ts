import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Damage and reward feedback (src/feedback/**), typed settings bound to the Lab panel (dev panel, Flight tab,
 * "feedback"). Every value is read live each frame. Presentation only: none of it reaches the room or the simulation.
 */
export type FeedbackSettings = {
  /** Red damage edge (not the g vignette): peak opacity for a heavy hit, 0 off. */
  edge: number
  /** The damage edge leans toward the attacker's side of the screen. */
  edgeDirectional: boolean
  /** Cracks and chips on the canopy glass in the cockpit view. */
  cracks: boolean
  /** Opacity of the crack lines. */
  crackOpacity: number
  /** Oil and hydraulic fluid streaking over the canopy below this health. */
  oilBelow: number
  /** Master caution chime repeats below this health (and sounds once on crossing the smoke threshold). */
  cautionBelow: number
  /** Seconds between caution chimes. */
  cautionEvery: number
  /** Level of the caution chime. */
  cautionGain: number
  /** Damage smoke and fire thicken toward this factor as health falls (1: the old fixed trail). */
  smokeScale: number
  /** Sparks off any jet's airframe when it is hit. */
  sparks: boolean
  /** Kill moment: the view punches in by this fraction of its field of view. */
  punchZoom: number
  /** Kill moment: its length (s). */
  punchTime: number
  /** Kill moment: the warm edge pulse, 0 off. */
  killPulse: number
  /** Debris tumbles past the canopy from kills within this range (m). */
  debrisRange: number
  /** Pieces flung past the canopy. */
  debrisCount: number
  /** How long a callout stays (s). */
  calloutTime: number
  /** Kills within this many seconds of the last make a double / triple / multi kill. */
  multiWindow: number
  /** Level of the callout stings. */
  stingGain: number
  /** CLOSE CALL: an enemy missile passes within this (m) without hurting us. */
  missMetres: number
  /** CLOSE CALL: an enemy missile decoyed by our flares within this range (m). */
  flareSave: number
  /** CLOSE CALL: skimming the sea, land, a deck or an island this low (m, below the jet's centre). */
  clearance: number
  /** CLOSE CALL: only this fast or faster (m/s). */
  scrapeSpeed: number
  /** At most one CLOSE CALL this often (s). */
  closeEvery: number
}

export const FEEDBACK_DEFAULTS: Readonly<FeedbackSettings> = {
  edge: 0.9,
  edgeDirectional: true,
  cracks: true,
  crackOpacity: 0.7,
  oilBelow: 50,
  cautionBelow: 25,
  cautionEvery: 2.6,
  cautionGain: 0.5,
  smokeScale: 2.2,
  sparks: true,
  punchZoom: 0.07,
  punchTime: 0.7,
  killPulse: 0.55,
  debrisRange: 260,
  debrisCount: 12,
  calloutTime: 1.7,
  multiWindow: 10,
  stingGain: 1,
  missMetres: 30,
  flareSave: 600,
  clearance: 8,
  scrapeSpeed: 90,
  closeEvery: 6,
}
export const FEEDBACK: FeedbackSettings = { ...FEEDBACK_DEFAULTS }

/** The kill punch-in's fov scale `t` seconds into it (1 at rest, before 0 or after `punchTime`, and under reduced
 *  motion): snap in over the first 12%, hold, ease back out. Shared by the pilot's view and the gunner's sight. */
export function punchScale(t: number, reduced: boolean): number {
  const u = t / Math.max(1e-3, FEEDBACK.punchTime)
  if (reduced || t < 0 || u >= 1) return 1
  const e = u < 0.12 ? u / 0.12 : u < 0.4 ? 1 : 1 - ((u - 0.4) / 0.6) ** 2 * (3 - 2 * ((u - 0.4) / 0.6))
  return 1 - FEEDBACK.punchZoom * Math.max(0, Math.min(1, e))
}

export const FEEDBACK_CONTROLS: LabControl[] = [
  { key: "edge", label: "Damage edge", group: "Taking damage", min: 0, max: 1.5, step: 0.05, unit: "" },
  { key: "edgeDirectional", label: "Edge toward attacker", group: "Taking damage", type: "toggle" },
  { key: "cracks", label: "Canopy cracks (cockpit)", group: "Taking damage", type: "toggle" },
  { key: "crackOpacity", label: "Crack opacity", group: "Taking damage", min: 0.1, max: 1, step: 0.05, unit: "" },
  { key: "oilBelow", label: "Oil streaks below", group: "Taking damage", min: 0, max: 100, step: 5, unit: "hp" },
  { key: "cautionBelow", label: "Master caution below", group: "Taking damage", min: 0, max: 60, step: 5, unit: "hp" },
  { key: "cautionEvery", label: "Caution repeat", group: "Taking damage", min: 1, max: 6, step: 0.1, unit: "s" },
  { key: "cautionGain", label: "Caution level", group: "Taking damage", min: 0, max: 1.5, step: 0.05, unit: "" },
  { key: "smokeScale", label: "Smoke thickening", group: "Taking damage", min: 1, max: 4, step: 0.1, unit: "×" },
  { key: "sparks", label: "Airframe sparks", group: "Taking damage", type: "toggle" },
  { key: "punchZoom", label: "Punch-in", group: "Kill moment", min: 0, max: 0.2, step: 0.005, unit: "" },
  { key: "punchTime", label: "Length", group: "Kill moment", min: 0.2, max: 1.5, step: 0.05, unit: "s" },
  { key: "killPulse", label: "Edge pulse", group: "Kill moment", min: 0, max: 1, step: 0.05, unit: "" },
  { key: "debrisRange", label: "Debris past canopy within", group: "Kill moment", min: 0, max: 600, step: 10, unit: "m" },
  { key: "debrisCount", label: "Debris pieces", group: "Kill moment", min: 0, max: 30, step: 1, unit: "" },
  { key: "calloutTime", label: "Callout time", group: "Callouts", min: 0.8, max: 3, step: 0.1, unit: "s" },
  { key: "multiWindow", label: "Multi-kill window", group: "Callouts", min: 3, max: 30, step: 1, unit: "s" },
  { key: "stingGain", label: "Sting level", group: "Callouts", min: 0, max: 1.5, step: 0.05, unit: "" },
  { key: "missMetres", label: "Missile miss within", group: "Close call", min: 13, max: 80, step: 1, unit: "m" },
  { key: "flareSave", label: "Flare save within", group: "Close call", min: 0, max: 2000, step: 50, unit: "m" },
  { key: "clearance", label: "Terrain clearance", group: "Close call", min: 2, max: 20, step: 0.5, unit: "m" },
  { key: "scrapeSpeed", label: "Min speed", group: "Close call", min: 40, max: 250, step: 5, unit: "m/s" },
  { key: "closeEvery", label: "Cooldown", group: "Close call", min: 1, max: 20, step: 0.5, unit: "s" },
]
