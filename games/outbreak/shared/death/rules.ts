/**
 * Death (AR-61): at 0 HP a survivor goes down instead of fighting on. Down, they crawl and can do nothing else while
 * the dead keep feeding; a teammate holds E beside them to bring them back with a little health. If nobody does
 * before they bleed out, or nobody is left standing to do it, they die. A dead survivor's body keeps what they
 * carried for the squad to take; in co-op they watch a teammate until the squad's next dawn and then wake at the
 * safehouse with a starting kit. When every survivor is dead the run is over.
 *
 * `deathMode: 0` (Lab › Death › "Today") is the game as it was: health stops at 0 and nothing else happens.
 * Plain types and pure helpers only; the rules run in `runtime.ts`.
 */

export type DeathTuning = {
  /** 1: survivors go down and die. 0: Today, nobody dies (health stops at 0). */
  deathMode: number
  /** Seconds a downed survivor lasts with a teammate standing who could revive them. */
  bleedOut: number
  /** Seconds a downed survivor lasts alone (solo, or when no teammate is standing). */
  soloBleedOut: number
  /** Seconds of bleed-out each point of damage takes while the dead feed on a downed survivor. */
  feedBleed: number
  /** Seconds a teammate holds E to revive. */
  reviveTime: number
  /** Health a revived survivor comes back with. */
  reviveHealth: number
  /** How close a teammate must kneel to revive (m). */
  reviveRange: number
  /** How fast a downed survivor drags themselves (m/s). */
  crawlSpeed: number
  /** 0: the dead come back at the safehouse at the squad's next dawn. 1: never; the run ends when everyone is dead. */
  respawnRule: number
}

export const DEFAULT_DEATH_TUNING: DeathTuning = {
  deathMode: 1,
  bleedOut: 30,
  soloBleedOut: 6,
  feedBleed: 0.12,
  reviveTime: 4,
  reviveHealth: 30,
  reviveRange: 1.6,
  crawlSpeed: 0.45,
  respawnRule: 0,
}

export const RESPAWN_AT_DAWN = 0
export const RESPAWN_NEVER = 1

export function deathTuning(features: Readonly<Record<string, Record<string, unknown>>> | undefined): DeathTuning {
  return (features?.death as DeathTuning | undefined) ?? DEFAULT_DEATH_TUNING
}

/** Lab controls (Backquote › Death). Lab tuning only changes the offline session; co-op rooms use the defaults. */
export const deathControls = [
  {
    key: "death.deathMode",
    field: "deathMode",
    label: "Death",
    group: "Death",
    options: [
      { label: "Today (nobody dies)", value: 0 },
      { label: "Down, revive, die", value: 1 },
    ],
  },
  { key: "death.bleedOut", field: "bleedOut", label: "Bleed-out (co-op)", group: "Death", min: 5, max: 120, step: 1, unit: "s" },
  { key: "death.soloBleedOut", field: "soloBleedOut", label: "Bleed-out alone", group: "Death", min: 0, max: 30, step: 0.5, unit: "s" },
  { key: "death.feedBleed", field: "feedBleed", label: "Feeding speeds bleed-out", group: "Death", min: 0, max: 1, step: 0.01, unit: "s/HP" },
  { key: "death.reviveTime", field: "reviveTime", label: "Revive hold", group: "Death", min: 0.5, max: 12, step: 0.25, unit: "s" },
  { key: "death.reviveHealth", field: "reviveHealth", label: "Revived with", group: "Death", min: 1, max: 100, step: 1, unit: "HP" },
  { key: "death.reviveRange", field: "reviveRange", label: "Revive reach", group: "Death", min: 0.8, max: 3, step: 0.1, unit: "m" },
  { key: "death.crawlSpeed", field: "crawlSpeed", label: "Crawl speed", group: "Death", min: 0, max: 1.5, step: 0.05, unit: "m/s" },
  {
    key: "death.respawnRule",
    field: "respawnRule",
    label: "The dead come back",
    group: "Death",
    options: [
      { label: "At the squad's next dawn", value: RESPAWN_AT_DAWN },
      { label: "Never", value: RESPAWN_NEVER },
    ],
  },
] as const

export type LifeState = "alive" | "down" | "dead"

/** What took a survivor: 0 the dead, 1–6 a special zombie's kind (`shared/specials/kinds.ts`), or one of these. */
export const CAUSE_DEAD = 0
export const CAUSE_LAB = 62
export const CAUSE_UNKNOWN = 63

/** One survivor's life, keyed by slot index. Plain JSON. */
export type LifeRecord = {
  index: number
  state: LifeState
  /** Sim time the state began. */
  since: number
  /** Seconds of bleed-out left while down. */
  bleed: number
  /** Revive progress 0..1, the reviving teammate's slot index (-1 none) and when they last held E. */
  revive: number
  reviver: number
  reviveAt: number
  cause: number
  /** Night count when taken, and whether it was dark. */
  night: number
  dark: boolean
  kills: number
  /** Times this survivor has died. Body IDs also account for earlier occupants of the seat. */
  deaths: number
}

/** A dead survivor's body: where it lies and the ledger store holding what they carried (`fallenStoreId`). */
export type FallenBody = { index: number; n: number; x: number; y: number; yaw: number }

export const fallenStoreId = (b: Pick<FallenBody, "index" | "n">) => `fallen:${b.index}:${b.n}`

/** Bodies kept in the world at once; the oldest goes first. */
export const MAX_FALLEN = 12

export type DeathState = {
  records: Record<number, LifeRecord>
  bodies: FallenBody[]
  /** Night count (1 from the first dusk) and dawns seen, counted like the night ramp's. */
  night: number
  dawns: number
  wasDark: boolean
  /** True for the tick the night ended. */
  dawn: boolean
  runOver: boolean
  runOverAt: number
  /** Damage dealt to downed survivors this tick, by slot index (feeds bleed-out). */
  feeding: Record<number, number>
  /** Zombies whose death has been credited to a survivor. */
  counted: Record<number, 1>
  /** The tuning `stepWorld` last resolved, for the interaction handlers (which are not given the session tuning). */
  tuning: DeathTuning
}

/** The death section of a co-op snapshot, quantised exactly as decoded. */
export type DeathSnapshot = {
  survivors: { index: number; state: "down" | "dead"; cause: number; night: number; dark: boolean; bleed: number; revive: number; reviver: number }[]
  bodies: FallenBody[]
  over: { dawns: number; kills: { index: number; kills: number }[] } | null
}

const SPECIAL_LABELS = ["the dead", "a Runner", "a Brute", "a Screamer", "a Bloater", "a Riot cop", "a Lurker"]

/** "Taken by a Brute on Night 3". Day `n + 1` is the day after night `n` (Day 1 is the first evening). */
export function causeText(rec: Pick<LifeRecord, "cause" | "night" | "dark">): string {
  const when = rec.dark && rec.night > 0 ? `on Night ${rec.night}` : `on Day ${rec.night + 1}`
  if (rec.cause === CAUSE_LAB) return `Struck down in the Lab ${when}`
  const who = SPECIAL_LABELS[rec.cause] ?? "the dead"
  return `Taken by ${who} ${when}`
}

/** "Survived 2 nights" for the run-over card. */
export function nightsText(dawns: number): string {
  if (dawns <= 0) return "Did not see a dawn"
  return dawns === 1 ? "Survived 1 night" : `Survived ${dawns} nights`
}
