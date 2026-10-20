import type { Rect } from "@arcade/kit/sim/geom"
import type { Building } from "../map"
import { generateWorldChunk, type WorldMode } from "../world"
import { SECRETS, secretHash, secretRoll, type SecretId, type SecretSeeds } from "./catalog"

/** The homes secrets live in. */
export const HOME_ARCHETYPES: readonly string[] = ["house", "ranch", "cottage", "cabin"]
export const isSecretHome = (b: Pick<Building, "kind" | "archetype">) => HOME_ARCHETYPES.includes(b.archetype ?? b.kind)

/** The house a one-house secret picked for a run. */
export type SecretHost = { readonly id: SecretId; readonly buildingId: string; readonly rect: Rect; readonly cx: number; readonly cy: number }

/** Chunks a one-house secret may pick from: a ring round the start (about 60–200 m out), the origin block in the classic town. */
const RING = { min: -3, max: 5 }
const TRIES = 24
/** Never the start house. */
const SPARED = new Set(["ash"])

const cache = new Map<string, ReadonlyMap<SecretId, SecretHost>>()

/**
 * Where each one-house secret in `picked` lives: a seeded chunk near the start, generated with the world generator,
 * and its first home in seeded order not already taken. The footprints share the cellar's house when both are in the
 * run (they lead to it). Pure and cached, so it is fixed before anyone walks there and the same on every client.
 */
export function secretHosts(seeds: SecretSeeds, mode: WorldMode, picked: ReadonlySet<SecretId>): ReadonlyMap<SecretId, SecretHost> {
  const ids = SECRETS.filter((s) => "oneHouse" in s && s.oneHouse && picked.has(s.id)).map((s) => s.id)
  const key = `${seeds.seed}:${seeds.houseSeed}:${mode}:${ids.join(",")}`
  const hit = cache.get(key)
  if (hit) return hit
  const out = new Map<SecretId, SecretHost>()
  const taken = new Set<string>()
  const chunks = new Map<string, Building[]>()
  const homesIn = (cx: number, cy: number) => {
    const k = `${cx},${cy}`
    let homes = chunks.get(k)
    if (!homes) {
      homes = generateWorldChunk(seeds.seed, seeds.houseSeed, cx, cy, mode).buildings.filter(isSecretHome)
      chunks.set(k, homes)
    }
    return homes
  }
  const classic = mode === "classic"
  const lo = classic ? 0 : RING.min
  const span = classic ? 3 : RING.max - RING.min + 1
  // The cellar first, so the footprints can follow it in.
  const order = [...ids].sort((a, b) => (a === "cellar" ? -1 : b === "cellar" ? 1 : 0))
  for (const id of order) {
    if (id === "footprints" && out.has("cellar")) {
      out.set(id, { ...out.get("cellar")!, id })
      continue
    }
    // Seeded chunks first, then every chunk of the ring in a seeded rotation, so a home is found if the ring has one.
    const offset = Math.floor(secretRoll(seeds, `host:${id}:sweep`) * span * span)
    for (let t = 0; t < TRIES + span * span; t++) {
      const sweep = (t - TRIES + offset) % (span * span)
      const cx = lo + (t < TRIES ? Math.floor(secretRoll(seeds, `host:${id}:${t}:x`) * span) : sweep % span)
      const cy = lo + (t < TRIES ? Math.floor(secretRoll(seeds, `host:${id}:${t}:y`) * span) : Math.floor(sweep / span))
      const homes = homesIn(cx, cy)
        .filter((b) => !taken.has(b.id) && !SPARED.has(b.id))
        .sort((a, b) => secretHash(`${seeds.seed}:${id}:${a.id}`) - secretHash(`${seeds.seed}:${id}:${b.id}`))
      const b = homes[0]
      if (!b) continue
      taken.add(b.id)
      out.set(id, { id, buildingId: b.id, rect: [...b.rect] as Rect, cx, cy })
      break
    }
  }
  if (cache.size > 32) cache.clear()
  cache.set(key, out)
  return out
}

/** The one-house secrets living in building `id`. */
export function hostedIn(hosts: ReadonlyMap<SecretId, SecretHost>, buildingId: string): SecretId[] {
  const out: SecretId[] = []
  for (const h of hosts.values()) if (h.buildingId === buildingId) out.push(h.id)
  return out
}
