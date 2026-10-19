import { carSites } from "../../shared/discovery/verbs"
import type { Building, Lamp, Town } from "../../shared/map"
import { carPose } from "../discovery/verbs"
import type { OutbreakNightLightSettings } from "./settings"

/**
 * Where the coloured night practicals are: a pure function of the town and the Night lights settings, each site
 * rolled from its own key (`town.seed`, `nlSeed`, car or building id), so co-op clients and streamed-back chunks
 * agree. Car alarms that are actually wailing come from the ledger at draw time (`presenter.ts`); everything here is
 * fixed scenery: police cars, shop beacons, neon signs, armed alarm lights and dying street lamps.
 */

export type NeonColour = "green" | "pink" | "cyan" | "red"

export type NightSite =
  | { kind: "cruiser"; key: string; x: number; z: number; yaw: number; roof: number; phase: number }
  | { kind: "armed"; key: string; car: string; x: number; z: number; yaw: number; phase: number }
  | { kind: "beacon"; key: string; x: number; z: number; h: number; nx: number; nz: number; phase: number }
  | { kind: "neon"; key: string; x: number; z: number; h: number; nx: number; nz: number; colour: NeonColour; shape: "cross" | "bar"; broken: boolean; phase: number }

export type NightPlacementInput = Pick<OutbreakNightLightSettings, "nightLights" | "nlCruisers" | "nlBeacons" | "nlNeon" | "nlArmedLeds" | "nlSeed">

export function nightHash01(town: Pick<Town, "seed">, seed: number, key: string): number {
  let h = 2166136261
  const s = `${town.seed}:night:${seed}:${key}`
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return (h >>> 0) / 4294967296
}

const HOMES: readonly string[] = ["house", "ranch", "cottage", "cabin"]
const isShop = (b: Building) => !HOMES.includes(b.archetype ?? b.kind)

export function placeNightLights(town: Town, s: NightPlacementInput): NightSite[] {
  if (!s.nightLights) return []
  const out: NightSite[] = []
  const roll = (key: string) => nightHash01(town, s.nlSeed, key)
  for (const car of carSites(town)) {
    const pose = carPose(car.rect)
    const roof = pose.glassY < 0.98 ? 1.22 : 1.36
    if (roll(`cruiser:${car.key}`) < s.nlCruisers) {
      out.push({ kind: "cruiser", key: `cruiser:${car.key}`, x: pose.x, z: pose.z, yaw: pose.yaw, roof, phase: roll(`cruiser-phase:${car.key}`) })
    }
    if (car.alarm && s.nlArmedLeds) {
      // The dash light sits just behind the windscreen.
      const lx = pose.cabin[1] - 0.12
      const c = Math.cos(pose.yaw)
      const sn = Math.sin(pose.yaw)
      out.push({ kind: "armed", key: `armed:${car.key}`, car: car.key, x: pose.x + lx * c, z: pose.z + lx * sn, yaw: pose.yaw, phase: roll(`armed-phase:${car.key}`) })
    }
  }
  for (const b of town.buildings) {
    if (!isShop(b)) continue
    const front = town.doors.find((d) => d.id === `${b.id}-front`)
    const arch = b.archetype ?? b.kind
    const beaconChance = arch === "police" ? Math.min(1, s.nlBeacons * 2.5) : s.nlBeacons
    if (front && roll(`beacon:${b.id}`) < beaconChance) {
      const x = (front.rect[0] + front.rect[2]) / 2
      out.push({ kind: "beacon", key: `beacon:${b.id}`, x, z: front.rect[3] + 0.09, h: 2.52, nx: 0, nz: 1, phase: roll(`beacon-phase:${b.id}`) })
    }
    const win = town.windows.find((w) => w.id === `${b.id}-south-east`) ?? town.windows.find((w) => w.id === `${b.id}-south-west`)
    if (win && roll(`neon:${b.id}`) < s.nlNeon) {
      const medical = arch === "pharmacy" || arch === "clinic"
      const pick = roll(`neon-colour:${b.id}`)
      const colour: NeonColour = medical ? "green" : arch === "diner" ? "pink" : pick < 0.4 ? "red" : pick < 0.7 ? "cyan" : "pink"
      out.push({
        kind: "neon",
        key: `neon:${b.id}`,
        x: (win.rect[0] + win.rect[2]) / 2,
        z: win.rect[3] + 0.07,
        h: 2.28,
        nx: 0,
        nz: 1,
        colour,
        shape: medical ? "cross" : "bar",
        broken: roll(`neon-broken:${b.id}`) < 0.5,
        phase: roll(`neon-phase:${b.id}`),
      })
    }
  }
  return out
}

/** Stable key for a street lamp (streamed lamps change index but not position). */
export const lampKey = (lamp: Pick<Lamp, "x" | "y">) => `${lamp.x.toFixed(1)},${lamp.y.toFixed(1)}`

/** Phase in [0, 1) for a street lamp that stutters, or -1 for a steady one. */
export function lampFlickerPhase(town: Pick<Town, "seed">, s: Pick<OutbreakNightLightSettings, "nightLights" | "nlSodiumFlicker" | "nlSeed">, lamp: Lamp): number {
  if (!s.nightLights || lamp.kind !== "street" || s.nlSodiumFlicker <= 0) return -1
  const key = lampKey(lamp)
  return nightHash01(town, s.nlSeed, `sodium:${key}`) < s.nlSodiumFlicker ? nightHash01(town, s.nlSeed, `sodium-phase:${key}`) : -1
}

const fract = (v: number) => v - Math.floor(v)
const noise = (i: number, seed: number) => fract(Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453)

/**
 * Light level of a dying sodium lamp at `time` (0 off .. 1 full): long steady stretches, then it drops out and
 * stutters back. Deterministic in sim time, so every client sees the same stutter.
 */
export function sodiumLevel(phase: number, time: number): number {
  const period = 7 + phase * 9
  const u = fract(time / period + phase)
  if (u < 0.07) return 0.04
  if (u < 0.18) return noise(Math.floor(time * 16), phase * 97) > 0.45 ? 0.35 + 0.6 * noise(Math.floor(time * 16) + 7, phase) : 0.03
  if (u < 0.3) return 0.55 + 0.45 * ((u - 0.18) / 0.12)
  return 0.93 + 0.07 * noise(Math.floor(time * 6), phase * 31)
}

/** Brightness of a broken neon sign at `time`: mostly lit, dropping out in bursts. */
export function neonLevel(broken: boolean, phase: number, time: number): number {
  if (!broken) return 0.94 + 0.06 * noise(Math.floor(time * 30), phase * 13)
  const u = fract(time / (4 + phase * 5) + phase)
  if (u < 0.22) return noise(Math.floor(time * 22), phase * 41) > 0.5 ? 1 : 0.05
  if (u < 0.3) return 0.05
  return 0.92 + 0.08 * noise(Math.floor(time * 30), phase * 13)
}
