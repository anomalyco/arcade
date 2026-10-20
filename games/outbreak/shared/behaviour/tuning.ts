/**
 * Zombie behaviour tuning (Backquote › Zombie behaviour). `zbMode: 0` is Today: the crowd steps exactly as it did
 * before this feature (no hooks, no activities, nothing on the wire). Each behaviour has a strength, 0 off, 1 the
 * default, up to 2; the sim ones are authoritative (co-op rooms use the defaults), the gait ones are presentation.
 */
export type BehaviourTuning = {
  /** 0 Today, 1 Alive. */
  zbMode: number
  /** Stop, turn and listen to sounds; heads turn toward what they notice. */
  zbListen: number
  /** Follow another zombie that noticed something (chains of attention). */
  zbFollow: number
  /** Remember where they last had you and the house you went into; search, sniff, peer in, give up slowly. */
  zbSearch: number
  /** Go still by day (sit, slump, stand), wake to noise, restless at dusk. */
  zbRest: number
  /** Drift in loose herds along the streets at night. */
  zbHerds: number
  /** Feed on bodies, distracted until disturbed; shoulder each other off. */
  zbFeed: number
  /** Climb fences and car bonnets after a survivor they can see; sometimes snag. */
  zbClimb: number
  /** Drawn to lamps at night; flinch from a torch beam in the face. */
  zbLight: number
  /** A lightning flash freezes them for a beat. */
  zbLightning: number
  /** Shamblers pause, sway and set off again. */
  zbPause: number
  /** Walk from each zombie's personality: cadence, stride, hunch, lean, limp, arms out (presentation). */
  zbGait: number
  /** Head and torso track what they notice; eyes on the torch (presentation). */
  zbLook: number
  /** 1 labels each zombie with its state, activity and attention (presentation). */
  zbOverlay: number
}

export const DEFAULT_BEHAVIOUR_TUNING: BehaviourTuning = {
  zbMode: 1,
  zbListen: 1,
  zbFollow: 1,
  zbSearch: 1,
  zbRest: 1,
  zbHerds: 1,
  zbFeed: 1,
  zbClimb: 1,
  zbLight: 1,
  zbLightning: 1,
  zbPause: 1,
  zbGait: 1,
  zbLook: 1,
  zbOverlay: 0,
}

/** Everything off: what "Today" means, and what a test passes to compare. */
export const TODAY_BEHAVIOUR_TUNING: BehaviourTuning = { ...DEFAULT_BEHAVIOUR_TUNING, zbMode: 0 }

const strength = (key: keyof BehaviourTuning, label: string) =>
  ({ key: `behaviour.${key}`, field: key, label, group: "Zombie behaviour", min: 0, max: 2, step: 0.05, unit: "×" }) as const

export const behaviourControls = [
  {
    key: "behaviour.zbMode",
    field: "zbMode",
    label: "Zombie behaviour",
    group: "Zombie behaviour",
    options: [
      { label: "Today", value: 0 },
      { label: "Alive", value: 1 },
    ],
  },
  strength("zbListen", "Stop and listen"),
  strength("zbFollow", "Follow the one that noticed"),
  strength("zbSearch", "Search, remember, give up slowly"),
  strength("zbRest", "Still by day"),
  strength("zbHerds", "Night herds"),
  strength("zbFeed", "Feed on bodies"),
  strength("zbClimb", "Climb fences and cars"),
  strength("zbLight", "Drawn to light, flinch from the beam"),
  strength("zbLightning", "Lightning freezes them"),
  strength("zbPause", "Shamble pauses"),
  strength("zbGait", "Walk from personality"),
  strength("zbLook", "Heads track what they notice"),
  {
    key: "behaviour.zbOverlay",
    field: "zbOverlay",
    label: "Behaviour overlay",
    group: "Zombie behaviour",
    options: [
      { label: "Off", value: 0 },
      { label: "On", value: 1 },
    ],
  },
] as const

export function behaviourTuning(features: Readonly<Record<string, Record<string, unknown>>> | undefined): BehaviourTuning {
  const src = features?.behaviour as Partial<BehaviourTuning> | undefined
  return src ? { ...DEFAULT_BEHAVIOUR_TUNING, ...src } : DEFAULT_BEHAVIOUR_TUNING
}

export const behaviourOn = (t: BehaviourTuning) => t.zbMode >= 1
