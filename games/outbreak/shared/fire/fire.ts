import type { StoreState } from "@arcade/kit/sim/ledger"

/**
 * Fire & explosives (Kit, Oct 19: "Add a flamethrower somewhere, or some way of making a flamethrower… dynamite or
 * firecrackers and flares, like more rare items, interesting one-off things").
 *
 * - **Flamethrower.** Hold the button to spray a short cone of fire. The dead in it catch fire; burning, they stagger
 *   in panic, take damage over time, light the dark round them, set alight whoever they brush against, and collapse
 *   charred. Fuel (its charge) drains fast and a gas can refills it. Loud and bright, so it draws the dead; it burns
 *   teammates too. Found in the hardware store's keyed back room in most towns and, very rarely, on a garage or
 *   warehouse shelf; made at a bench with a pressure tank installed.
 * - **Dynamite.** Thrown with a lit fuse: a big blast that throws the dead down (and kills the near ones), blows
 *   barricades and doors in, leaves a crater, flashes the street white and is heard across town.
 * - **Firecrackers.** A string of pops that skitters along the ground: a moving noise lure that drags the dead with it.
 * - **Molotov.** Crafted from a bottle and chem: it bursts into a pool of fire that burns whatever walks through.
 * - **Flare gun.** Three shots: a burning flare that sets the first of the dead it hits alight and then burns where it
 *   lands (a road flare's lure, from across the street).
 * - **Bear trap.** Set at your feet: it snaps shut on the first of the dead to step in, holding it and hurting it.
 *
 * Everything that has to be seen is a ledger store (shared, so every co-op seat gets it with the ledger deltas): no
 * wire fields. Stores come from fixed rings (`fire:0..`, `burn:0..`), reused oldest first, so the ledger never grows
 * and fire on the ground is bounded. Times are deciseconds (`ds`), offsets centimetres.
 *
 * | Store | Counts | Meaning |
 * | --- | --- | --- |
 * | `flamer:<seat>` | `on`, `t` | that survivor is spraying (since `t`) |
 * | `fire:<k>` | `t`, `until`, `r` (cm), `src` | fire on the ground at `at` (0 the stream, 1 a molotov, 2 spread) |
 * | `burn:<k>` | `z` (id + 1), `t`, `until`, `dead` | a zombie burning from `t` to `until`; `dead` when it fell (charred) |
 * | `scorch:<k>` | `t`, `r` (cm), `crater` | a scorch mark (or a blast crater) |
 * | `dyn:<k>` | `t`, `boom`, `fx`, `fy` (cm from `at`), `done` | dynamite thrown at `t` from `at + f`, blowing at `boom` |
 * | `crack:<k>` | `t`, `until`, `ex`, `ey` (cm from `at`) | firecrackers popping from `at` towards `at + e` |
 * | `trap:<k>` | `t`, `z` (id + 1), `snap`, `until` | a bear trap set at `t`; holding zombie `z` from `snap` to `until` |
 */

export type FireTuning = {
  /** How far the flamethrower's stream reaches, in metres. */
  flameRange: number
  /** Half-angle of the stream's cone, in degrees. */
  flameCone: number
  /** Seconds of spraying a full tank lasts. */
  flameFuelSeconds: number
  /** Damage per second to the dead in the stream. */
  flameDps: number
  /** Damage per second to a teammate in the stream (friendly fire). */
  flameFriendlyDps: number
  /** How far the stream's roar carries to the dead, in metres. */
  flameNoise: number
  /** How far away the dead see the stream at night and come to it (daylight shortens it), in metres. */
  flameReach: number
  /** Seconds a burning zombie burns before the fire goes out (if it is still standing). */
  burnSeconds: number
  /** Damage per second while burning. */
  burnDps: number
  /** How close the dead must brush against a burning one to catch, in metres. */
  burnSpread: number
  /** Chance per second that a burning zombie sets one it touches alight. */
  burnSpreadRate: number
  /** Seconds between a burning zombie's panicked lurches. */
  burnPanic: number
  /** Seconds a patch of fire the stream leaves on the ground burns. */
  groundFireSeconds: number
  /** Damage per second to a survivor standing in fire on the ground. */
  groundFireDps: number
  /** Lab only: chance per second that fire on the ground spreads beside itself (0: fire never spreads). */
  fireSpread: number
  /** How far dynamite can be thrown, in metres. */
  dynThrow: number
  /** Seconds of fuse. */
  dynFuse: number
  /** Blast radius, in metres (full damage at the centre, falling off to the edge). */
  dynRadius: number
  /** Damage at the centre of the blast. */
  dynDamage: number
  /** How hard the blast throws the dead (metres per second at the centre). */
  dynKnockback: number
  /** How far the blast carries, in metres. */
  dynNoise: number
  /** Damage to barricades and doors at the centre of the blast. */
  dynBreach: number
  /** How long the firecrackers pop, in seconds. */
  crackSeconds: number
  /** How far each burst of pops carries, in metres. */
  crackNoise: number
  /** How far the string skitters along the ground while it pops, in metres. */
  crackTravel: number
  /** How far a molotov can be thrown, in metres. */
  molotovThrow: number
  /** Radius of the pool of fire a molotov leaves, in metres. */
  molotovRadius: number
  /** Seconds a molotov's fire burns. */
  molotovSeconds: number
  /** How far the flare gun fires, in metres. */
  flareGunRange: number
  /** Damage a bear trap does as it snaps shut. */
  trapDamage: number
  /** Seconds a bear trap holds what it caught. */
  trapHold: number
}

export const DEFAULT_FIRE_TUNING: FireTuning = {
  flameRange: 6.5,
  flameCone: 16,
  flameFuelSeconds: 9,
  flameDps: 34,
  flameFriendlyDps: 22,
  flameNoise: 22,
  flameReach: 18,
  burnSeconds: 6,
  burnDps: 15,
  burnSpread: 0.9,
  burnSpreadRate: 0.8,
  burnPanic: 1.3,
  groundFireSeconds: 2.4,
  groundFireDps: 12,
  fireSpread: 0,
  dynThrow: 10,
  dynFuse: 2.6,
  dynRadius: 4.8,
  dynDamage: 240,
  dynKnockback: 9,
  dynNoise: 60,
  dynBreach: 400,
  crackSeconds: 7,
  crackNoise: 20,
  crackTravel: 6,
  molotovThrow: 11,
  molotovRadius: 2.3,
  molotovSeconds: 7,
  flareGunRange: 26,
  trapDamage: 45,
  trapHold: 8,
}

const G = "Fire & explosives"

/** Lab controls (Backquote › Fire & explosives). */
export const fireControls = [
  { key: "flameRange", label: "Flamethrower reach", group: G, min: 2, max: 14, step: 0.25, unit: "m" },
  { key: "flameCone", label: "Flame cone (half-angle)", group: G, min: 4, max: 40, step: 1, unit: "°" },
  { key: "flameFuelSeconds", label: "Full tank lasts", group: G, min: 2, max: 40, step: 0.5, unit: "s" },
  { key: "flameDps", label: "Flame damage", group: G, min: 0, max: 150, step: 1, unit: "/s" },
  { key: "flameFriendlyDps", label: "Friendly fire damage", group: G, min: 0, max: 100, step: 1, unit: "/s" },
  { key: "flameNoise", label: "Flamethrower roar", group: G, min: 0, max: 60, step: 1, unit: "m" },
  { key: "flameReach", label: "Dead see the flames within", group: G, min: 0, max: 50, step: 1, unit: "m" },
  { key: "burnSeconds", label: "Burns for", group: G, min: 0.5, max: 20, step: 0.5, unit: "s" },
  { key: "burnDps", label: "Burn damage", group: G, min: 0, max: 80, step: 1, unit: "/s" },
  { key: "burnSpread", label: "Catches from a burning one within", group: G, min: 0, max: 3, step: 0.05, unit: "m" },
  { key: "burnSpreadRate", label: "Catching chance", group: G, min: 0, max: 5, step: 0.05, unit: "/s" },
  { key: "burnPanic", label: "Panicked lurch every", group: G, min: 0.2, max: 5, step: 0.1, unit: "s" },
  { key: "groundFireSeconds", label: "Fire on the ground burns", group: G, min: 0.2, max: 10, step: 0.1, unit: "s" },
  { key: "groundFireDps", label: "Ground fire damage (survivors)", group: G, min: 0, max: 60, step: 1, unit: "/s" },
  { key: "fireSpread", label: "Fire spreads on the ground (Lab)", group: G, min: 0, max: 2, step: 0.05, unit: "/s" },
  { key: "dynThrow", label: "Dynamite throw", group: G, min: 2, max: 20, step: 0.5, unit: "m" },
  { key: "dynFuse", label: "Dynamite fuse", group: G, min: 0.5, max: 8, step: 0.1, unit: "s" },
  { key: "dynRadius", label: "Blast radius", group: G, min: 1, max: 12, step: 0.1, unit: "m" },
  { key: "dynDamage", label: "Blast damage (centre)", group: G, min: 0, max: 600, step: 10, unit: "HP" },
  { key: "dynKnockback", label: "Blast knockback", group: G, min: 0, max: 20, step: 0.5, unit: "m/s" },
  { key: "dynNoise", label: "Blast heard within", group: G, min: 0, max: 120, step: 1, unit: "m" },
  { key: "dynBreach", label: "Blast damage to barricades", group: G, min: 0, max: 1000, step: 10, unit: "HP" },
  { key: "crackSeconds", label: "Firecrackers pop for", group: G, min: 1, max: 20, step: 0.5, unit: "s" },
  { key: "crackNoise", label: "Firecracker pops carry", group: G, min: 0, max: 50, step: 1, unit: "m" },
  { key: "crackTravel", label: "Firecrackers skitter", group: G, min: 0, max: 15, step: 0.5, unit: "m" },
  { key: "molotovThrow", label: "Molotov throw", group: G, min: 2, max: 20, step: 0.5, unit: "m" },
  { key: "molotovRadius", label: "Molotov fire radius", group: G, min: 0.5, max: 5, step: 0.1, unit: "m" },
  { key: "molotovSeconds", label: "Molotov burns", group: G, min: 1, max: 20, step: 0.5, unit: "s" },
  { key: "flareGunRange", label: "Flare gun range", group: G, min: 5, max: 50, step: 1, unit: "m" },
  { key: "trapDamage", label: "Bear trap damage", group: G, min: 0, max: 200, step: 5, unit: "HP" },
  { key: "trapHold", label: "Bear trap holds for", group: G, min: 1, max: 30, step: 0.5, unit: "s" },
] as const satisfies readonly { key: keyof FireTuning; label: string; group: string; min: number; max: number; step: number; unit: string }[]

/** Ring sizes: the most of each that can exist at once (oldest reused first). */
export const FIRE_RING = 24
export const BURN_RING = 24
export const SCORCH_RING = 48
export const DYN_RING = 6
export const CRACK_RING = 4
export const TRAP_RING = 8

/** Items whose primary button this feature runs. */
export const FIRE_ITEMS = ["flamethrower", "dynamite", "firecrackers", "molotov", "flare-gun", "bear-trap"] as const
export type FireItem = (typeof FIRE_ITEMS)[number]

export const ds = (seconds: number) => Math.round(seconds * 10)
export const cm = (metres: number) => Math.round(metres * 100)

export const flamerId = (seat: string) => `flamer:${seat}`
export const ringId = (prefix: string, k: number) => `${prefix}:${k}`

/** Burning, at `time`. */
export function fireLit(st: StoreState | undefined, time: number): boolean {
  return Boolean(st?.at) && ds(time) < (st!.counts.until ?? 0)
}

/** 0 lit .. 1 out, through a timed store's life. */
export function lifeAge(st: StoreState, time: number): number {
  const t = (st.counts.t ?? 0) / 10
  const until = (st.counts.until ?? 0) / 10
  return Math.max(0, Math.min(1, (time - t) / Math.max(0.1, until - t)))
}

/** The zombie a burn store is on, or -1. */
export const burnZombie = (st: StoreState) => (st.counts.z ?? 0) - 1

/** A burn store's zombie is on fire (not out, not yet fallen). */
export function burning(st: StoreState | undefined, time: number): boolean {
  return Boolean(st) && (st!.counts.z ?? 0) > 0 && !st!.counts.dead && ds(time) < (st!.counts.until ?? 0)
}

/** Where a firecracker string is at `time`: from `at` towards `at + e`, slowing as it goes, with a little hop. */
export function crackerAt(st: StoreState, time: number): { x: number; y: number; u: number } {
  const t = (st.counts.t ?? 0) / 10
  const until = (st.counts.until ?? 0) / 10
  const u = Math.max(0, Math.min(1, (time - t) / Math.max(0.1, until - t)))
  const k = 1 - (1 - u) * (1 - u)
  const ex = (st.counts.ex ?? 0) / 100
  const ey = (st.counts.ey ?? 0) / 100
  const wob = Math.sin(time * 11 + (st.counts.t ?? 0)) * 0.12 * (1 - u)
  const len = Math.hypot(ex, ey) || 1
  return { x: st.at!.x + ex * k - (ey / len) * wob, y: st.at!.y + ey * k + (ex / len) * wob, u }
}

/** A thrown stick of dynamite's flight: where it is at `time` (lying at `at` once landed) and its height. */
export function dynamiteAt(st: StoreState, time: number): { x: number; y: number; h: number; flying: boolean } {
  const t = (st.counts.t ?? 0) / 10
  const fx = (st.counts.fx ?? 0) / 100
  const fy = (st.counts.fy ?? 0) / 100
  const dist = Math.hypot(fx, fy)
  const flight = Math.max(0.15, Math.min(0.7, dist / 16))
  const u = Math.max(0, Math.min(1, (time - t) / flight))
  const x = st.at!.x + fx * (1 - u)
  const y = st.at!.y + fy * (1 - u)
  return { x, y, h: 1.1 * (1 - u) + 4 * u * (1 - u) * Math.min(1, dist / 8), flying: u < 1 }
}

/** Seconds since a dynamite store blew, or -1 if it has not. */
export function blastAge(st: StoreState, time: number): number {
  return st.counts.done ? time - (st.counts.boom ?? 0) / 10 : -1
}
