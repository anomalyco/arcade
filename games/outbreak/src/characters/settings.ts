import type { LabControl } from "@arcade/kit/lab-panel"
import { DEFAULT_CHARACTERS_TUNING, type CharactersTuning } from "../../shared/characters/habits"

/**
 * Lab › Characters (AR-88): the dead hint at who they were. `chStyle` 0 is Today (the six Former Townsfolk outfits,
 * no habits, no new body language); the sim reads `chStyle`, `chHabits` and the habit numbers through the
 * `characters` tuning namespace, everything else is presentation.
 */
export type OutbreakCharacterSettings = CharactersTuning & {
  /** Mail carriers, joggers, bathrobes, guards, couriers, brides and grooms among the six old outfits. */
  chCallings: boolean
  /** Clothes and skin by days since turning (fresh this morning to weeks gone). */
  chWear: boolean
  /** A few still hold a dog's lead, with nothing on the end. */
  chLeash: boolean
  /** Heads turn and tilt toward noises they hear. */
  chNoiseTurn: boolean
  /** A brief flinch from the torch beam. */
  chTorchFlinch: boolean
}

export const DEFAULT_CHARACTER_SETTINGS: OutbreakCharacterSettings = {
  ...DEFAULT_CHARACTERS_TUNING,
  chCallings: true,
  chWear: true,
  chLeash: true,
  chNoiseTurn: true,
  chTorchFlinch: true,
}

const GROUP = "Characters"

export const characterControls: LabControl[] = [
  {
    key: "chStyle",
    label: "Characters",
    group: GROUP,
    options: [
      { label: "Today", value: 0 },
      { label: "Who they were", value: 1 },
    ],
  },
  { key: "chCallings", label: "Callings (mail carrier, jogger, bathrobe…)", group: GROUP, type: "toggle" },
  { key: "chWear", label: "Wear by days since turning", group: GROUP, type: "toggle" },
  {
    key: "chHabits",
    label: "Habit loops",
    group: GROUP,
    options: [
      { label: "Off", value: 0 },
      { label: "On", value: 1 },
    ],
  },
  { key: "chHabitShare", label: "Habit sites in use", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "chHabitSenses", label: "Senses while lost in a habit", group: GROUP, min: 0, max: 1, step: 0.05, unit: "×" },
  { key: "chHabitLetGo", label: "Letting go of a habit", group: GROUP, min: 0, max: 3, step: 0.1, unit: "s" },
  { key: "chLeash", label: "Empty dog leads", group: GROUP, type: "toggle" },
  { key: "chNoiseTurn", label: "Heads turn to noises", group: GROUP, type: "toggle" },
  { key: "chTorchFlinch", label: "Flinch from the torch", group: GROUP, type: "toggle" },
] as LabControl[]
