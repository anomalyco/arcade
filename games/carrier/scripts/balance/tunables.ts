// Balance knobs: the game's own tunable objects, overridden at runtime by dotted path (`FLEET.bomb=60`,
// `WEAPONS.missile.maxG=30`, `OPS.hornet.recharge=20`) without editing source. Every value read while the game runs
// follows an override; a few constants are derived once when their module loads and do not (CREW.recharge and
// CREW.aircraft come from OPS, DECK_JET_ROUND_DAMAGE from WEAPONS/GUNNERY/BOAT_DAMAGE, the room's boat reach from the
// boat GUN): override their sources and they keep the shipped value.

import { BOAT, BOAT_ARMOR, BOAT_DAMAGE, BOAT_HEALTH, CRANE, GUN } from "../../shared/boat"
import { CREW } from "../../shared/crew"
import { DECK_JET } from "../../shared/deck-jets"
import { FLEET } from "../../shared/fleet"
import { GUNNERY } from "../../shared/gunnery"
import { LANDING } from "../../shared/landing"
import { LAUNCH } from "../../shared/launch"
import { OBJECTIVE_DEFAULTS, ZONE_AREA } from "../../shared/objective"
import { OPS } from "../../shared/ops"
import { PLANE } from "../../shared/plane"
import { COLLIDE } from "../../shared/ship-collide"
import { SHIP } from "../../shared/ship"
import { VEHICLES } from "../../shared/vehicles"
import { LOADOUTS, WEAPONS } from "../../shared/weapons"

/** Every overridable object by the name used on the command line. `OPS` is keyed by operation id. */
export const TUNABLES: Readonly<Record<string, object>> = {
  FLEET,
  WEAPONS,
  LOADOUTS,
  GUNNERY,
  OBJECTIVE: OBJECTIVE_DEFAULTS,
  ZONE_AREA,
  SHIP,
  COLLIDE,
  PLANE,
  VEHICLES,
  BOAT,
  BOAT_GUN: GUN,
  BOAT_HEALTH,
  BOAT_DAMAGE,
  BOAT_ARMOR,
  CRANE,
  DECK_JET,
  LANDING,
  LAUNCH,
  CREW,
  OPS: Object.fromEntries(OPS.map((o) => [o.id, o])),
}

/** One override: a dotted path and its new number. */
export type Override = { path: string; value: number }

/** Parses "PATH=NUMBER"; throws with a readable message when malformed. */
export function parseOverride(s: string): Override {
  const m = /^([A-Z_]+(?:\.[A-Za-z0-9_-]+)+)=(-?[0-9.]+(?:e-?[0-9]+)?)$/.exec(s.trim())
  if (!m) throw new Error(`bad override "${s}" (want PATH=NUMBER, e.g. FLEET.bomb=60)`)
  return { path: m[1]!, value: Number(m[2]) }
}

/** Parses "PATH=a,b,c" into one override per value (a sweep). */
export function parseSweep(s: string): Override[] {
  const eq = s.indexOf("=")
  if (eq < 0) throw new Error(`bad sweep "${s}" (want PATH=a,b,c)`)
  const path = s.slice(0, eq)
  return s
    .slice(eq + 1)
    .split(",")
    .map((v) => parseOverride(`${path}=${v}`))
}

/** The object and key a path names; throws unless it ends on an existing number. */
function locate(path: string): { obj: Record<string, unknown>; key: string; value: number } {
  const [root, ...rest] = path.split(".")
  let obj = TUNABLES[root!] as Record<string, unknown> | undefined
  if (!obj) throw new Error(`unknown tunable "${root}" (known: ${Object.keys(TUNABLES).join(", ")})`)
  for (let i = 0; i < rest.length - 1; i++) {
    const next = obj[rest[i]!]
    if (!next || typeof next !== "object") throw new Error(`"${path}": no object at "${rest.slice(0, i + 1).join(".")}"`)
    obj = next as Record<string, unknown>
  }
  const key = rest[rest.length - 1]!
  const value = obj[key]
  if (typeof value !== "number") throw new Error(`"${path}" is not a number (it is ${typeof value})`)
  return { obj, key, value }
}

/** Current value at a path (throws like `applyOverrides` for a bad one). */
export const tunableValue = (path: string): number => locate(path).value

/**
 * Applies overrides in order (later ones win) and returns a function that restores every touched value. Validates them
 * all first, so a bad path changes nothing.
 */
export function applyOverrides(list: readonly Override[]): () => void {
  const spots = list.map((o) => ({ ...locate(o.path), next: o.value }))
  const undo: { obj: Record<string, unknown>; key: string; value: number }[] = []
  for (const s of spots) {
    undo.push({ obj: s.obj, key: s.key, value: s.obj[s.key] as number })
    s.obj[s.key] = s.next
  }
  return () => {
    for (let i = undo.length - 1; i >= 0; i--) undo[i]!.obj[undo[i]!.key] = undo[i]!.value
  }
}

/** Overrides from a JSON file's object: nested objects or dotted keys, numbers at the leaves. */
export function overridesOfJson(v: unknown, prefix = ""): Override[] {
  if (typeof v === "number") {
    if (!prefix) throw new Error("override file: a number needs a path")
    return [{ path: prefix, value: v }]
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`override file: "${prefix || "root"}" must be an object or a number`)
  return Object.entries(v).flatMap(([k, x]) => overridesOfJson(x, prefix ? `${prefix}.${k}` : k))
}
