/**
 * Special zombies: which kinds exist, how rare each is and when, and their stats. Pure data and pure functions, so the
 * client (silhouettes, sounds) and the sim share one table.
 *
 * A zombie's kind lives in its seed: a special's seed carries the kind in its low four bits and a 12-bit check in its
 * top bits (`encodeSpecialSeed`), so the kind reaches co-op clients through the seed the wire already sends and needs
 * no new field. An ordinary seed passes the check about once in 11 000 zombies; the sim flips a check bit on those.
 */

export const SPECIAL_NONE = 0
export const SPECIAL_RUNNER = 1
export const SPECIAL_BRUTE = 2
export const SPECIAL_SCREAMER = 3
export const SPECIAL_BLOATER = 4
export const SPECIAL_RIOT = 5
export const SPECIAL_LURKER = 6

export type SpecialKind = 0 | 1 | 2 | 3 | 4 | 5 | 6
export const SPECIAL_KIND_IDS = ["runner", "brute", "screamer", "bloater", "riot", "lurker"] as const
export type SpecialKindId = (typeof SPECIAL_KIND_IDS)[number]

/** Where a kind may appear and when. `night`: only once it is dark. */
export type SpecialRule = {
  readonly id: SpecialKindId
  readonly kind: Exclude<SpecialKind, 0>
  readonly label: string
  /** How a player spots it, and the answer to it (Lab tooltips, docs). */
  readonly read: string
  readonly counter: string
  readonly phase: "any" | "night"
  /** `street`: wherever zombies spawn; `police`: near a police station or cruiser; `dark-room`: moved into an unlit room. */
  readonly placement: "street" | "police" | "dark-room"
}

export const SPECIAL_RULES: readonly SpecialRule[] = [
  {
    id: "runner",
    kind: SPECIAL_RUNNER,
    label: "Runner",
    read: "Lean, red track jacket, sprints the moment it sees you",
    counter: "Fragile: one pistol shot or a heavy swing; get a door between you",
    phase: "night",
    placement: "street",
  },
  {
    id: "brute",
    kind: SPECIAL_BRUTE,
    label: "Brute",
    read: "A head taller and broad across the shoulders, heavy footsteps",
    counter: "Shoves and light swings do nothing; keep moving, heavy blows and bullets",
    phase: "any",
    placement: "street",
  },
  {
    id: "screamer",
    kind: SPECIAL_SCREAMER,
    label: "Screamer",
    read: "Pale gown, hanging jaw; rears back before it shrieks",
    counter: "Kill it before the shriek lands, or break its line of sight",
    phase: "any",
    placement: "street",
  },
  {
    id: "bloater",
    kind: SPECIAL_BLOATER,
    label: "Bloater",
    read: "Swollen yellow-green belly, gurgles",
    counter: "Shoot it from range; never melee it, and stay out of the cloud",
    phase: "any",
    placement: "street",
  },
  {
    id: "riot",
    kind: SPECIAL_RIOT,
    label: "Riot cop",
    read: "Helmet and a riot shield held in front",
    counter: "Front is armoured and shoves bounce off; flank it or hit its back",
    phase: "any",
    placement: "police",
  },
  {
    id: "lurker",
    kind: SPECIAL_LURKER,
    label: "Lurker",
    read: "Black clothes, crouched still in an unlit room",
    counter: "Your light wakes it: check rooms with the light off, or be ready",
    phase: "any",
    placement: "dark-room",
  },
]

export function specialRule(kind: SpecialKind): SpecialRule | undefined {
  return kind === SPECIAL_NONE ? undefined : SPECIAL_RULES[kind - 1]
}

export function specialKindFromId(id: string): SpecialKind {
  const i = SPECIAL_KIND_IDS.indexOf(id as SpecialKindId)
  return i < 0 ? SPECIAL_NONE : ((i + 1) as SpecialKind)
}

/** Rarity, phase ramp and stats. Flat numbers so the session tuning and the Lab panel carry them as they are. */
export type SpecialsTuning = {
  /** 1: specials appear. 0: every zombie is ordinary. */
  specials: number
  /** Multiplies every chance below. */
  specialRate: number
  /** Chance that a zombie appearing by day is special, on the first day. */
  specialDayChance: number
  /** Chance that a zombie appearing at night is special, on the first night. */
  specialNightChance: number
  /** Added to both chances for every night after the first. */
  specialRampPerNight: number
  /** The chance never passes this. */
  specialMaxChance: number
  /** Relative weights among the kinds allowed at that moment and place. */
  runnerWeight: number
  bruteWeight: number
  screamerWeight: number
  bloaterWeight: number
  riotWeight: number
  lurkerWeight: number
  /** Riot cops within this distance of a police station or cruiser; elsewhere their weight is scaled by `riotStray`. */
  riotPoliceRadius: number
  riotStray: number
  /** Runner: health, speed when chasing at night (× the zombie's own), and by day. */
  runnerHp: number
  runnerSprint: number
  runnerDaySpeed: number
  /** Brute: health, speed, how much faster it beats down barricades and doors. */
  bruteHp: number
  bruteSpeed: number
  bruteBash: number
  /** Screamer: health, shriek wind-up (s), shriek loudness (noise radius, m), cooldown (s). */
  screamerHp: number
  shriekTime: number
  shriekRadius: number
  shriekCooldown: number
  /** Bloater: health, speed, gas cloud radius (m), how long it hangs (s), damage per second to survivors and zombies. */
  bloaterHp: number
  bloaterSpeed: number
  gasRadius: number
  gasTime: number
  gasDamage: number
  gasZombieDamage: number
  /** How much of a step a zombie keeps inside the gas (0..1), and stamina a survivor loses per second in it. */
  gasSlow: number
  gasStamina: number
  /** Riot cop: health, frontal arc (degrees either side of facing), damage let through from the front. */
  riotHp: number
  riotArc: number
  riotFront: number
  /** Lurker: health, speed once awake, and how close a survivor can stand before it wakes in the dark (m). */
  lurkerHp: number
  lurkerSpeed: number
  lurkerWakeNear: number
  /** A room counts as dark below this light level (0..1.5; an unlit interior at night is ~0.12, by day ~0.47). */
  lurkerDark: number
}

export const DEFAULT_SPECIALS_TUNING: SpecialsTuning = {
  specials: 1,
  specialRate: 1,
  specialDayChance: 0.004,
  specialNightChance: 0.025,
  specialRampPerNight: 0.012,
  specialMaxChance: 0.08,
  runnerWeight: 30,
  bruteWeight: 16,
  screamerWeight: 16,
  bloaterWeight: 18,
  riotWeight: 14,
  lurkerWeight: 14,
  riotPoliceRadius: 32,
  riotStray: 0.1,
  runnerHp: 45,
  runnerSprint: 1.6,
  runnerDaySpeed: 1.0,
  bruteHp: 320,
  bruteSpeed: 0.72,
  bruteBash: 3.5,
  screamerHp: 70,
  shriekTime: 1.3,
  shriekRadius: 40,
  shriekCooldown: 14,
  bloaterHp: 150,
  bloaterSpeed: 0.62,
  gasRadius: 3.2,
  gasTime: 8,
  gasDamage: 7,
  gasZombieDamage: 4,
  gasSlow: 0.45,
  gasStamina: 0.22,
  riotHp: 150,
  riotArc: 70,
  riotFront: 0.12,
  lurkerHp: 110,
  lurkerSpeed: 1.3,
  lurkerWakeNear: 1.6,
  lurkerDark: 0.5,
}

type Control = {
  key: string
  field: keyof SpecialsTuning
  label: string
  group: "Specials"
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: readonly { label: string; value: number }[]
}

const c = (field: keyof SpecialsTuning, label: string, min: number, max: number, step: number, unit = ""): Control => ({
  key: `specials.${field}`,
  field,
  label,
  group: "Specials",
  min,
  max,
  step,
  unit,
})

/** The Lab's Specials group (Backquote › Specials). */
export const specialsControls: readonly Control[] = [
  {
    key: "specials.specials",
    field: "specials",
    label: "Special zombies",
    group: "Specials",
    options: [
      { label: "Off", value: 0 },
      { label: "On", value: 1 },
    ],
  },
  c("specialRate", "Rarity scale", 0, 5, 0.05, "×"),
  c("specialDayChance", "Day chance", 0, 0.2, 0.001),
  c("specialNightChance", "Night 1 chance", 0, 0.3, 0.001),
  c("specialRampPerNight", "Added per night", 0, 0.1, 0.001),
  c("specialMaxChance", "Chance cap", 0, 0.5, 0.005),
  c("runnerWeight", "Runner weight", 0, 100, 1),
  c("bruteWeight", "Brute weight", 0, 100, 1),
  c("screamerWeight", "Screamer weight", 0, 100, 1),
  c("bloaterWeight", "Bloater weight", 0, 100, 1),
  c("riotWeight", "Riot cop weight", 0, 100, 1),
  c("lurkerWeight", "Lurker weight", 0, 100, 1),
  c("riotPoliceRadius", "Riot cop near police", 0, 80, 1, "m"),
  c("riotStray", "Riot cop elsewhere", 0, 1, 0.01, "×"),
  c("runnerHp", "Runner health", 10, 200, 5),
  c("runnerSprint", "Runner sprint", 1, 2.5, 0.05, "×"),
  c("runnerDaySpeed", "Runner by day", 0.5, 2, 0.05, "×"),
  c("bruteHp", "Brute health", 100, 800, 10),
  c("bruteSpeed", "Brute speed", 0.4, 1.2, 0.02, "×"),
  c("bruteBash", "Brute bash rate", 1, 8, 0.1, "×"),
  c("screamerHp", "Screamer health", 20, 200, 5),
  c("shriekTime", "Shriek wind-up", 0.3, 3, 0.05, "s"),
  c("shriekRadius", "Shriek loudness", 10, 80, 1, "m"),
  c("shriekCooldown", "Shriek cooldown", 3, 60, 1, "s"),
  c("bloaterHp", "Bloater health", 40, 400, 5),
  c("bloaterSpeed", "Bloater speed", 0.3, 1.2, 0.02, "×"),
  c("gasRadius", "Gas radius", 1, 6, 0.1, "m"),
  c("gasTime", "Gas lasts", 1, 20, 0.5, "s"),
  c("gasDamage", "Gas damage", 0, 30, 0.5, "/s"),
  c("gasZombieDamage", "Gas damage to dead", 0, 30, 0.5, "/s"),
  c("gasSlow", "Zombie step in gas", 0.1, 1, 0.05, "×"),
  c("gasStamina", "Stamina loss in gas", 0, 1, 0.01, "/s"),
  c("riotHp", "Riot cop health", 40, 400, 5),
  c("riotArc", "Shield arc", 20, 120, 1, "°"),
  c("riotFront", "Through the shield", 0, 1, 0.01, "×"),
  c("lurkerHp", "Lurker health", 40, 300, 5),
  c("lurkerSpeed", "Lurker speed", 0.6, 2, 0.05, "×"),
  c("lurkerWakeNear", "Lurker wakes within", 0, 4, 0.1, "m"),
  c("lurkerDark", "Dark room below", 0.1, 1.2, 0.01),
]

export function specialsTuning(resolved?: { features?: Readonly<Record<string, Record<string, unknown>>> }): SpecialsTuning {
  const src = resolved?.features?.specials as Partial<SpecialsTuning> | undefined
  return src ? { ...DEFAULT_SPECIALS_TUNING, ...src } : DEFAULT_SPECIALS_TUNING
}

export function specialWeight(t: SpecialsTuning, kind: SpecialKind): number {
  switch (kind) {
    case SPECIAL_RUNNER:
      return t.runnerWeight
    case SPECIAL_BRUTE:
      return t.bruteWeight
    case SPECIAL_SCREAMER:
      return t.screamerWeight
    case SPECIAL_BLOATER:
      return t.bloaterWeight
    case SPECIAL_RIOT:
      return t.riotWeight
    case SPECIAL_LURKER:
      return t.lurkerWeight
    default:
      return 0
  }
}

/** Where the world stands when a zombie appears: how dark (0..1) and which night it is (0 before the first). */
export type SpecialPhase = { darkness: number; night: number }

/** Chance that a zombie appearing now is special. */
export function specialChance(t: SpecialsTuning, phase: SpecialPhase): number {
  if (t.specials <= 0) return 0
  const d = Math.max(0, Math.min(1, phase.darkness))
  const base = t.specialDayChance + (t.specialNightChance - t.specialDayChance) * d
  const ramp = t.specialRampPerNight * Math.max(0, phase.night - 1)
  return Math.max(0, Math.min(t.specialMaxChance, base + ramp) * Math.max(0, t.specialRate))
}

/** Whether `kind` may appear now: Runners only after dark. */
export function specialAllowed(kind: SpecialKind, phase: SpecialPhase): boolean {
  const rule = specialRule(kind)
  if (!rule) return false
  return rule.phase === "any" || phase.darkness >= 0.5
}

/** 32-bit mix (murmur3 finaliser). */
export function mix32(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/** A zombie's two independent rolls, from the town seed, its id and its seed: [is it special, which kind]. */
export function specialRolls(townSeed: number, id: number, seed: number): [number, number] {
  const a = mix32((townSeed ^ Math.imul(id + 0x51, 0x9e3779b1) ^ mix32(seed)) >>> 0)
  const b = mix32((a ^ 0x2545f491) >>> 0)
  return [a / 4294967296, b / 4294967296]
}

/**
 * Picks a kind from `weights` (index = kind - 1) with the uniform roll `u`, or `SPECIAL_NONE` when every weight is 0.
 */
export function pickSpecialKind(weights: readonly number[], u: number): SpecialKind {
  let total = 0
  for (const w of weights) total += Math.max(0, w)
  if (total <= 0) return SPECIAL_NONE
  let r = u * total
  for (let i = 0; i < weights.length; i++) {
    const w = Math.max(0, weights[i]!)
    if (r < w) return (i + 1) as SpecialKind
    r -= w
  }
  for (let i = weights.length - 1; i >= 0; i--) if (weights[i]! > 0) return (i + 1) as SpecialKind
  return SPECIAL_NONE
}

const CHECK_SHIFT = 20
const LOW_MASK = 0xfffff

function seedCheck(low: number): number {
  return mix32((low ^ 0x5bd1e995) >>> 0) & 0xfff
}

/** The seed a zombie of `kind` carries: its own seed's middle bits, the kind in the low nibble and a check on top. */
export function encodeSpecialSeed(seed: number, kind: Exclude<SpecialKind, 0>): number {
  const low = ((seed & 0xffff0) | kind) & LOW_MASK
  return ((seedCheck(low) << CHECK_SHIFT) | low) >>> 0
}

/** A zombie's kind, read from its seed (0 for an ordinary zombie). */
export function specialKindOf(seed: number): SpecialKind {
  const s = seed >>> 0
  const k = s & 0xf
  if (k < SPECIAL_RUNNER || k > SPECIAL_LURKER) return SPECIAL_NONE
  return s >>> CHECK_SHIFT === seedCheck(s & LOW_MASK) ? (k as SpecialKind) : SPECIAL_NONE
}

/** An ordinary seed that happens to read as special, with one check bit flipped so it no longer does. */
export function ordinarySeed(seed: number): number {
  return specialKindOf(seed) === SPECIAL_NONE ? seed >>> 0 : (seed ^ (1 << CHECK_SHIFT)) >>> 0
}

/** Whether a hit from `(fromX, fromY)` lands on the front of a zombie at `(x, y)` facing `aim`, within `arcDeg`. */
export function hitFromFront(x: number, y: number, aim: number, fromX: number, fromY: number, arcDeg: number): boolean {
  const dx = fromX - x
  const dy = fromY - y
  if (dx * dx + dy * dy < 1e-8) return true
  let d = Math.atan2(dy, dx) - aim
  d = Math.atan2(Math.sin(d), Math.cos(d))
  return Math.abs(d) <= (arcDeg * Math.PI) / 180
}
