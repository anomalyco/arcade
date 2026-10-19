import type { ItemId, Rule } from "@arcade/kit/sim/ledger"
import { RECIPES } from "./catalog"

/** Metres of slack past interaction range before a timed action is cancelled for walking off. */
export const CHANNEL_SLACK = 0.65

export type ProgressionTuning = {
  /** Multiplies every loot roll's chance. */
  lootRate: number
  searchQuietTime: number
  searchQuietNoise: number
  searchSmashTime: number
  searchSmashNoise: number
  barricadeTime: number
  barricadeNoise: number
  reinforcedPlankHp: number
  healTime: number
  medkitHeal: number
  bandageHeal: number
  craftTime: number
  /** Light needed to make something at the workbench (daylight, the generator or flashlights; the key predates D-39). */
  researchLight: number
  /** Board-up time once fully practised, as a share of the first boards' (practice: ten boards nailed). */
  practiceTimeFloor: number
  /** Board-up noise once fully practised, as a share of the first boards'. */
  practiceNoiseFloor: number
  /** How close, in clear sight, a teammate picks up practice by watching someone board up. */
  watchRange: number
  /** Practice a watcher gains per board they see nailed (the nailer gains 1). */
  watchShare: number
  /** Seconds of looking closely at a reinforced barricade to see how it was done. */
  studyTime: number
  /** Walking speed while crouched, as a share of walking. */
  crouchSpeed: number
  /** How far a crouched survivor's footsteps carry. */
  crouchNoise: number
  /** How much of a crouched survivor the dead can see, as a share of a standing one. */
  crouchVisibility: number
  /** Seconds to re-nail a damaged barricade with a crowbar. */
  repairTime: number
  /** How far re-nailing carries. */
  repairNoise: number
  /** How far a bottle can be thrown. */
  bottleRange: number
  /** How far a bottle breaking carries. */
  bottleNoise: number
  /** Seconds to string a can tripwire across a doorway. */
  tripSetTime: number
  /** Seconds to take a can tripwire down without it rattling. */
  tripDisarmTime: number
  /** How far a sprung tripwire's rattle carries. */
  tripNoise: number
  /** How far a car alarm carries. */
  alarmNoise: number
  /** Seconds a car alarm wails before its battery gives out. */
  alarmTime: number
  /** How far stepping on broken glass upright carries (crouch to step softly). */
  glassStepNoise: number
  /** Multiplies every craft cost (rounded, at least 1). */
  costScale: number
  pryTime: number
  pryNoise: number
  lureNoise: number
  lureSeconds: number
  generatorNoise: number
}

/** Lab controls for every progression tunable (bound to the shared LabPanel by `src/progression/lab.ts`). */
export const progressionControls = [
  { key: "lootRate", label: "Loot rate", group: "Progression", min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "searchQuietTime", label: "Quiet search time", group: "Progression", min: 0.2, max: 4, step: 0.05, unit: "s" },
  { key: "searchQuietNoise", label: "Quiet search noise", group: "Progression", min: 0, max: 20, step: 0.5, unit: "m" },
  { key: "searchSmashTime", label: "Smash time", group: "Progression", min: 0.1, max: 2, step: 0.05, unit: "s" },
  { key: "searchSmashNoise", label: "Smash noise", group: "Progression", min: 2, max: 40, step: 1, unit: "m" },
  { key: "barricadeTime", label: "Board-up time", group: "Progression", min: 0.2, max: 3, step: 0.05, unit: "s" },
  { key: "barricadeNoise", label: "Board-up noise", group: "Progression", min: 0, max: 30, step: 0.5, unit: "m" },
  { key: "reinforcedPlankHp", label: "Reinforced plank HP", group: "Progression", min: 100, max: 400, step: 10, unit: "HP" },
  { key: "healTime", label: "Medkit time", group: "Progression", min: 0.3, max: 5, step: 0.1, unit: "s" },
  { key: "medkitHeal", label: "Medkit heal", group: "Progression", min: 5, max: 100, step: 5, unit: "HP" },
  { key: "bandageHeal", label: "Bandage heal", group: "Progression", min: 5, max: 100, step: 5, unit: "HP" },
  { key: "craftTime", label: "Craft time", group: "Progression", min: 0.2, max: 6, step: 0.1, unit: "s" },
  { key: "researchLight", label: "Light needed at the bench", group: "Progression", min: 0, max: 1.2, step: 0.05, unit: "" },
  { key: "practiceTimeFloor", label: "Practised board-up time", group: "Progression", min: 0.2, max: 1, step: 0.05, unit: "×" },
  { key: "practiceNoiseFloor", label: "Practised board-up noise", group: "Progression", min: 0.2, max: 1, step: 0.05, unit: "×" },
  { key: "watchRange", label: "Learn by watching within", group: "Progression", min: 0, max: 20, step: 0.5, unit: "m" },
  { key: "watchShare", label: "Practice from watching", group: "Progression", min: 0, max: 1, step: 0.05, unit: "×" },
  { key: "studyTime", label: "Study a reinforced barricade", group: "Progression", min: 0.2, max: 6, step: 0.1, unit: "s" },
  { key: "crouchSpeed", label: "Crouched speed", group: "Verbs", min: 0.2, max: 1, step: 0.05, unit: "×" },
  { key: "crouchNoise", label: "Crouched footsteps", group: "Verbs", min: 0, max: 6, step: 0.1, unit: "m" },
  { key: "crouchVisibility", label: "Crouched visibility", group: "Verbs", min: 0.1, max: 1, step: 0.05, unit: "×" },
  { key: "repairTime", label: "Re-nail time", group: "Verbs", min: 0.2, max: 5, step: 0.1, unit: "s" },
  { key: "repairNoise", label: "Re-nail noise", group: "Verbs", min: 0, max: 20, step: 0.5, unit: "m" },
  { key: "bottleRange", label: "Bottle throw", group: "Verbs", min: 2, max: 20, step: 0.5, unit: "m" },
  { key: "bottleNoise", label: "Bottle breaking", group: "Verbs", min: 0, max: 30, step: 0.5, unit: "m" },
  { key: "tripSetTime", label: "String a tripwire", group: "Verbs", min: 0.2, max: 5, step: 0.1, unit: "s" },
  { key: "tripDisarmTime", label: "Disarm a tripwire", group: "Verbs", min: 0.2, max: 5, step: 0.1, unit: "s" },
  { key: "tripNoise", label: "Tripwire rattle", group: "Verbs", min: 0, max: 30, step: 0.5, unit: "m" },
  { key: "alarmNoise", label: "Car alarm", group: "Verbs", min: 0, max: 50, step: 1, unit: "m" },
  { key: "alarmTime", label: "Car alarm length", group: "Verbs", min: 2, max: 60, step: 1, unit: "s" },
  { key: "glassStepNoise", label: "Glass underfoot", group: "Verbs", min: 0, max: 20, step: 0.5, unit: "m" },
  { key: "costScale", label: "Craft cost", group: "Progression", min: 0.25, max: 3, step: 0.25, unit: "×" },
  { key: "pryTime", label: "Pry time", group: "Progression", min: 0.2, max: 4, step: 0.1, unit: "s" },
  { key: "pryNoise", label: "Pry noise", group: "Progression", min: 0, max: 30, step: 0.5, unit: "m" },
  { key: "lureNoise", label: "Noisemaker radius", group: "Progression", min: 5, max: 60, step: 1, unit: "m" },
  { key: "lureSeconds", label: "Noisemaker duration", group: "Progression", min: 1, max: 30, step: 0.5, unit: "s" },
  { key: "generatorNoise", label: "Generator hum", group: "Progression", min: 0, max: 40, step: 1, unit: "m" },
] as const satisfies readonly { key: keyof ProgressionTuning; label: string; group: string; min: number; max: number; step: number; unit: string }[]

export const DEFAULT_PROGRESSION_TUNING: ProgressionTuning = {
  // D-22 Balanced Curve (was 1 before D-22).
  lootRate: 1.05,
  searchQuietTime: 1.2,
  searchQuietNoise: 3.5,
  searchSmashTime: 0.35,
  searchSmashNoise: 14,
  barricadeTime: 0.7,
  barricadeNoise: 9.5,
  reinforcedPlankHp: 180,
  healTime: 1.5,
  medkitHeal: 45,
  bandageHeal: 25,
  craftTime: 2,
  researchLight: 0.35,
  practiceTimeFloor: 0.6,
  practiceNoiseFloor: 0.63,
  watchRange: 8,
  watchShare: 0.5,
  studyTime: 1.5,
  crouchSpeed: 0.5,
  crouchNoise: 1.2,
  crouchVisibility: 0.55,
  repairTime: 1.6,
  repairNoise: 6,
  bottleRange: 12,
  bottleNoise: 15,
  tripSetTime: 1.2,
  tripDisarmTime: 1.8,
  tripNoise: 13,
  alarmNoise: 30,
  alarmTime: 20,
  glassStepNoise: 9.5,
  costScale: 1,
  pryTime: 1.2,
  pryNoise: 12,
  lureNoise: 30,
  lureSeconds: 8,
  generatorNoise: 18,
}

/** The progression tunables in `src` (a Lab settings object may hold many other keys), over `base`. */
export function pickProgressionTuning(src: object, base: ProgressionTuning = DEFAULT_PROGRESSION_TUNING): ProgressionTuning {
  const out = { ...base }
  const from = src as Record<string, unknown>
  for (const key of Object.keys(out) as (keyof ProgressionTuning)[]) if (typeof from[key] === "number") out[key] = from[key] as number
  return out
}

const scaleCost = (cost: Readonly<Record<ItemId, number>>, k: number) =>
  Object.fromEntries(Object.entries(cost).map(([item, n]) => [item, Math.max(1, Math.round(n * k))]))

/** The rule table for a tuning. Rebuilt when the Lab changes a tunable. */
export function progressionRules(t: ProgressionTuning): Rule[] {
  const rules: Rule[] = [
    { id: "barricade", label: "Boarding up", duration: t.barricadeTime, noise: t.barricadeNoise, consume: { plank: 1 } },
    { id: "barricade:reinforced", label: "Boarding up", duration: t.barricadeTime, noise: t.barricadeNoise, requires: { "learned:reinforced": 1 }, consume: { plank: 1, scrap: 1 } },
    { id: "heal:medkit", label: "Patching up", duration: t.healTime, consume: { medkit: 1 } },
    { id: "heal:bandage", label: "Bandaging", duration: t.healTime * 0.66, consume: { bandage: 1 } },
    { id: "throw:lure", label: "Throw", consume: { noisemaker: 1 } },
    { id: "throw:bottle", label: "Throw", consume: { bottle: 1 } },
    { id: "throw:flare", label: "Throw", consume: { flare: 1 } },
    { id: "feed:dog", label: "Feed", consume: { food: 1 } },
    { id: "set:tripwire", label: "Stringing cans", duration: t.tripSetTime, consume: { cans: 1 } },
    { id: "disarm:tripwire", label: "Disarming", duration: t.tripDisarmTime },
    { id: "arm:tripwire", label: "Stringing cans", duration: t.tripSetTime },
    { id: "repair", label: "Re-nailing", duration: t.repairTime, noise: t.repairNoise, requires: { crowbar: 1 } },
    { id: "swap:battery", label: "Fresh battery", consume: { battery: 1 } },
    { id: "unlock", label: "Unlocking", consume: { key: 1 } },
    { id: "pry", label: "Prying the door", duration: t.pryTime, noise: t.pryNoise, requires: { crowbar: 1 } },
  ]
  for (const r of RECIPES) {
    if (!r.produces || !r.craft) continue
    rules.push({
      id: `craft:${r.id}`,
      label: `Crafting ${r.label}`,
      duration: t.craftTime,
      requires: { [`learned:${r.id}`]: 1 },
      consume: scaleCost(r.craft, t.costScale),
      produce: { [r.produces]: 1 },
      // Bench recipes are made at a lit workbench, from the bench's stock first, with their part installed.
      ...(r.bench ? { station: "bench", lightMin: t.researchLight } : {}),
      ...(r.part ? { installed: { [r.part]: 1 } } : {}),
    })
  }
  return rules
}

