import type { FeedbackActor } from "../hud/actor-feedback"

/** One sound to play: a library id at a plan position (x, y), optionally later, quieter, filtered or pitch-shifted. */
export type SoundEvent = {
  id: string
  x: number
  y: number
  delay?: number
  gain?: number
  rate?: number
  cutoffHz?: number
  priority?: number
  source: string
}

/** The survivor fields the director diffs: `FeedbackActor` (the HUD's action feedback contract) plus position. */
export type SoundActor = Pick<
  FeedbackActor,
  | "health"
  | "equippedItem"
  | "meleeWeapon"
  | "meleeDurability"
  | "meleeMaxDurability"
  | "magAmmo"
  | "reserveAmmo"
  | "planks"
  | "reloadRemaining"
  | "shoveAnim"
  | "channel"
  | "lootMessage"
  | "lootMessageUntil"
  | "flashlightOn"
  | "battery"
  | "exhausted"
  | "vault"
> & { x: number; y: number; crouching?: boolean }
