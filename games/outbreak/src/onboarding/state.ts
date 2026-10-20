import type { LabControl } from "@arcade/kit/lab-panel"

/** Today: no training room; Play Solo starts the run. */
export const TRAINING_OFF = 0
/** The first solo start in this browser begins in the training room (default). */
export const TRAINING_FIRST_TIME = 1
/** Every solo start from the lobby begins in the training room. */
export const TRAINING_ALWAYS = 2

/** Training room settings (AR-89); the values live in the HUD settings (Backquote › Onboarding). */
export const DEFAULT_TRAINING_SETTINGS = {
  /** 1 First time (default), 2 Every solo start, 0 Off (Today). */
  trainingRoom: TRAINING_FIRST_TIME,
}

export type TrainingSettings = typeof DEFAULT_TRAINING_SETTINGS

export const TRAINING_DONE_KEY = "arcade.outbreak.training"

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

/** Whether this browser has finished (or skipped) the training room. */
export function trainingDone(store: Storage | null = storage()): boolean {
  try {
    return store?.getItem(TRAINING_DONE_KEY) === "done"
  } catch {
    return false
  }
}

export function markTrainingDone(store: Storage | null = storage()): void {
  try {
    store?.setItem(TRAINING_DONE_KEY, "done")
  } catch {}
}

export function forgetTraining(store: Storage | null = storage()): void {
  try {
    store?.removeItem(TRAINING_DONE_KEY)
  } catch {}
}

let request: "auto" | "force" | null = null

/**
 * Asks for the training room on the next offline session: `force` from the lobby's Training room button or the Lab,
 * `auto` from Play Solo (honoured the first time, per the setting). Automation that never opens the lobby never asks.
 */
export function requestTraining(force = false): void {
  request = force ? "force" : "auto"
}

/** Consumes the pending request: whether the next session should be the training room. */
export function takeTrainingRequest(mode: number, store: Storage | null = storage()): boolean {
  const r = request
  request = null
  if (r === "force") return true
  if (r !== "auto" || mode === TRAINING_OFF) return false
  return mode === TRAINING_ALWAYS || !trainingDone(store)
}

export const trainingControls: LabControl[] = [
  {
    key: "trainingRoom",
    label: "Training room",
    group: "Onboarding",
    options: [
      { label: "First solo start", value: TRAINING_FIRST_TIME },
      { label: "Every solo start", value: TRAINING_ALWAYS },
      { label: "Off (Today)", value: TRAINING_OFF },
    ],
  },
]
