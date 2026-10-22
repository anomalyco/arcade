import type { LabControl } from "@arcade/kit/lab-panel"

/** Today: no clock on screen in the Diegetic HUD (its chrome hides the top-left summary that carries the hour). */
export const NIGHT_CLOCK_TODAY = 0
/** A small chip at the top left: the night, a bar of how much of it is left and the real time until dawn (default). */
export const NIGHT_CLOCK_COUNTDOWN = 1

/** The night clock (playtest Oct 21, 1:38:07: "I have no concept of how much time is left"); values live in the HUD settings. */
export const DEFAULT_NIGHT_CLOCK_SETTINGS = {
  nightClock: NIGHT_CLOCK_COUNTDOWN,
  /** Real seconds before dark that the chip appears as a warning ("Dark in 1:30"); 0 shows it only at night. */
  nightClockWarn: 90,
}

export type NightClockSettings = typeof DEFAULT_NIGHT_CLOCK_SETTINGS

export const nightClockControls: LabControl[] = [
  {
    key: "nightClock",
    label: "Night clock",
    group: "HUD",
    options: [
      { label: "Countdown to dawn", value: NIGHT_CLOCK_COUNTDOWN },
      { label: "Today (none)", value: NIGHT_CLOCK_TODAY },
    ],
  },
  { key: "nightClockWarn", label: "Warn before dark", group: "HUD", min: 0, max: 240, step: 5, unit: "s" },
]
