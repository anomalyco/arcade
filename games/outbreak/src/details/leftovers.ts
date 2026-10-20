import { instanceRotation } from "@arcade/kit/vehicle/body-pose"
import { evaluateWindGust } from "../ambient-motion"
import type { Building, Town } from "../../shared/map"
import { supportHeight } from "../../shared/terrain"
import { detailRng, isHome, outdoorFree, type DetailModel } from "./placement"
import type { OutbreakDetailSettings } from "./settings"

/**
 * Leftover life: what kept going after the people left. Washing on a line in the back yard that the wind still moves,
 * cars left with a door open whose dome light runs the battery down night by night, and the brass from every shot
 * fired, lying where it fell. Lines and doors are seeded from the town and the replicated vehicles (co-op clients
 * agree); a casing's flight is seeded from its shot.
 */

export type LaundryItem = { model: DetailModel; at: number; seed: number }
export type LaundryLine = { key: string; x: number; z: number; y: number; yaw: number; items: LaundryItem[] }

/** Half the distance between the two posts of a washing line (the posts model is built this wide). */
export const LINE_HALF = 1.6
/** Height of the cord the washing hangs from. */
export const CORD_Y = 1.82

const WIDTH: Partial<Record<DetailModel, number>> = { sheet: 0.92, shirt: 0.56, towel: 0.46 }

/** Washing lines in the back or side yards of a share (`lfLaundry`) of homes, clear of everything outdoors. */
export function placeLaundry(town: Town, b: Building, s: Pick<OutbreakDetailSettings, "lifeTouches" | "lfLaundry" | "dtSeed">): LaundryLine | null {
  if (!s.lifeTouches || s.lfLaundry <= 0 || !isHome(b)) return null
  const r = detailRng(town, s.dtSeed, `laundry:${b.id}`)
  if (r.next() >= s.lfLaundry) return null
  const [x0, z0, x1, z1] = b.rect
  for (let t = 0; t < 10; t++) {
    const side = t % 3
    // Behind the house along it, or down one side.
    const yaw = side === 0 ? 0 : Math.PI / 2
    const x = side === 0 ? (x0 + x1) / 2 + (r.next() - 0.5) * Math.max(0, x1 - x0 - 4) : side === 1 ? x1 + 2.2 + r.next() * 1.6 : x0 - 2.2 - r.next() * 1.6
    const z = side === 0 ? z0 - 2.4 - r.next() * 1.8 : (z0 + z1) / 2 + (r.next() - 0.5) * Math.max(0, z1 - z0 - 4)
    const c = Math.cos(yaw)
    const sn = Math.sin(yaw)
    const ends = [-LINE_HALF, 0, LINE_HALF]
    if (!ends.every((u) => outdoorFree(town, x + c * u, z + sn * u, u === 0 ? 0.55 : 0.2, []))) continue
    const items: LaundryItem[] = []
    let at = -LINE_HALF + 0.18
    while (items.length < 5) {
      const pick = r.next()
      const model: DetailModel = pick < 0.34 ? "sheet" : pick < 0.72 ? "shirt" : "towel"
      const w = WIDTH[model]!
      if (at + w > LINE_HALF - 0.12) break
      items.push({ model, at: at + w / 2, seed: r.next() })
      at += w + 0.06 + r.next() * 0.25
    }
    if (!items.length) continue
    return { key: `laundry:${b.id}`, x, z, y: supportHeight(town, x, z), yaw, items }
  }
  return null
}

export type Pose = { model: DetailModel; x: number; y: number; z: number; yaw: number; pitch: number; roll: number }

/**
 * The washing's poses at `time`: each piece swings about the cord with the gust at its spot, pushed downwind and
 * fluttering faster as the gust rises. `storm` (0..1) adds to the wind.
 */
export function laundryPoses(line: LaundryLine, time: number, storm: number, emit: (model: DetailModel, x: number, y: number, z: number, yaw: number, pitch: number, roll: number) => void): void {
  const c = Math.cos(line.yaw)
  const s = Math.sin(line.yaw)
  emit("linePosts", line.x, line.y, line.z, line.yaw, 0, 0)
  // Wind across the line (the gust field's direction, as the litter and leaves drift).
  const across = -0.88 * s + 0.47 * c
  for (const it of line.items) {
    const x = line.x + c * it.at
    const z = line.z + s * it.at
    const gust = evaluateWindGust(time + it.seed * 0.6, x, z, 1 + storm) * (1 + storm * 0.8)
    const swing = -across * (0.1 + 0.22 * gust)
    const flutter = (0.05 + 0.08 * gust) * Math.sin(time * (2.1 + it.seed * 1.7 + gust) + it.seed * 30)
    const twist = 0.04 * gust * Math.sin(time * 1.3 + it.seed * 11)
    emit(it.model, x, line.y + CORD_Y, z, line.yaw, twist, swing + flutter)
  }
}

/** A parked car left with a door open: which side, how far it swung, and its dome light's own flicker phase. */
export type OpenDoor = { id: number; side: 1 | -1; angle: number; phase: number }

type DoorVehicle = { id: number; kind: string; x: number; y: number; h: number; spawnX: number; spawnY: number; wreck: boolean; seats: readonly string[]; spec: { length: number; width: number } }

const doorRoll = (town: Pick<Town, "seed">, seed: number, v: DoorVehicle) => detailRng(town, seed, `door:${v.spawnX.toFixed(1)},${v.spawnY.toFixed(1)}`)

/**
 * The open door of a vehicle, or null: a share (`lfOpenDoors`) of parked cars, while the car still stands where it was
 * left (once someone has driven or pushed it, the door was shut). Keyed on the spawn spot, so every client agrees.
 */
export function openDoorOf(town: Pick<Town, "seed">, v: DoorVehicle, s: Pick<OutbreakDetailSettings, "lifeTouches" | "lfOpenDoors" | "dtSeed">): OpenDoor | null {
  if (!s.lifeTouches || s.lfOpenDoors <= 0 || v.wreck) return null
  if (Math.hypot(v.x - v.spawnX, v.y - v.spawnY) > 0.35) return null
  for (const seat of v.seats) if (seat) return null
  const r = doorRoll(town, s.dtSeed, v)
  if (r.next() >= s.lfOpenDoors) return null
  return { id: v.id, side: r.next() < 0.5 ? 1 : -1, angle: 0.75 + r.next() * 0.45, phase: r.next() }
}

/** The door model for each vehicle kind (painted as `vehicle-mesh.ts` paints the body). */
export const DOOR_MODEL: Readonly<Record<string, DetailModel>> = { sedan: "carDoorSedan", cruiser: "carDoorCruiser", pickup: "carDoorPickup", van: "carDoorVan" }

const rot = { yaw: 0, pitch: 0, roll: 0 }

/** The door's pose: hinged at the front of the cabin on its side, swung out by `angle`. Also the dome light's spot. */
export function doorPose(v: DoorVehicle, d: OpenDoor, town: Town, out: Pose, light: { x: number; y: number; z: number }): void {
  instanceRotation(rot, Math.PI / 2 - v.h, 0, 0)
  const c = Math.cos(rot.yaw)
  const s = Math.sin(rot.yaw)
  const hx = v.spec.length * 0.16
  const hz = d.side * (v.spec.width / 2 - 0.03)
  const x = v.x + hx * c - hz * s
  const z = v.y + hx * s + hz * c
  out.model = DOOR_MODEL[v.kind] ?? "carDoorSedan"
  out.x = x
  out.y = supportHeight(town, v.x, v.y)
  out.z = z
  out.yaw = rot.yaw - d.side * d.angle
  out.pitch = 0
  out.roll = 0
  // The dome light sits mid-cabin, a little toward the open side, so its pool spills out of the doorway.
  const lx = -0.25
  const lz = d.side * 0.25
  light.x = v.x + lx * c - lz * s
  light.y = out.y + 1.12
  light.z = v.y + lx * s + lz * c
}

const fract = (v: number) => v - Math.floor(v)
const noise = (i: number, seed: number) => fract(Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453)

/**
 * How bright a dome light left on is (0..1) on `night` at `time`: full on the first night, weaker and flickering on
 * the second, sputtering on the third, a flat battery after. With `decay` off it stays as on the first night.
 */
export function domeLevel(night: number, time: number, phase: number, decay: boolean): number {
  const n = decay ? night : 1
  if (n >= 4) return 0
  if (n <= 1) return 1
  // Dips: smooth, a few per minute on night 2; on night 3 mostly out with brief catches.
  const t = time * (n === 2 ? 0.7 : 2.4) + phase * 50
  const i = Math.floor(t)
  const f = t - i
  const v = noise(i, phase * 9) * (1 - f) + noise(i + 1, phase * 9) * f
  return n === 2 ? 0.55 * (v < 0.18 ? v / 0.18 : 1) : 0.22 * (v > 0.72 ? (v - 0.72) / 0.28 : 0)
}

/**
 * Share of the lit houses still lit on `night` when the town runs down (`look/lit-windows.ts` keeps the lowest rolls,
 * so the lights go out house by house): all of them the first night, about a third by the fifth.
 */
export function windowPowerLeft(night: number): number {
  return [1, 0.8, 0.62, 0.48][Math.max(1, night) - 1] ?? 0.36
}

/** Most casings kept per town (oldest go first). */
export const CASINGS_MAX = 256

type Casing = { x: number; z: number; y: number; vx: number; vz: number; vy: number; yaw: number; spin: number; t: number; landed: boolean }

export type ShotLike = { id: number; time: number; fromX: number; fromY: number; aim: number; seed: number }

/**
 * Brass from every shot: ejected up and out to the shooter's right, a short tumble to the ground, then it stays where
 * it fell (until the run restarts or `CASINGS_MAX` newer ones push it out). Seeded from the shot, so a co-op client
 * sees the same brass in the same place.
 */
export class Casings {
  private readonly ring: Casing[] = []
  private head = 0
  private readonly seen: number[] = []
  private readonly recent: { x: number; y: number; t: number }[] = []
  /** Called when a casing first hits the ground (for the audio layer: a brass tink on the surface below). */
  onLand: ((x: number, z: number) => void) | null = null

  get count(): number {
    return this.ring.length
  }

  reset(): void {
    this.ring.length = 0
    this.head = 0
    this.seen.length = 0
    this.recent.length = 0
  }

  observe(shots: readonly ShotLike[], ground: (x: number, z: number) => number): void {
    for (const s of shots) {
      if (this.seen.includes(s.id)) continue
      this.seen.push(s.id)
      if (this.seen.length > 96) this.seen.shift()
      // A predicted shot and its confirmation can both arrive: one casing per pull of the trigger.
      if (this.recent.some((r) => Math.abs(r.t - s.time) < 0.06 && Math.hypot(r.x - s.fromX, r.y - s.fromY) < 0.6)) continue
      this.recent.push({ x: s.fromX, y: s.fromY, t: s.time })
      if (this.recent.length > 12) this.recent.shift()
      const u = (k: number) => fract(Math.sin((s.seed % 100000) * 0.731 + k * 12.9898) * 43758.5453)
      const rx = -Math.sin(s.aim)
      const rz = Math.cos(s.aim)
      const out = 1.6 + u(1) * 1.2
      const back = -0.4 - u(2) * 0.5
      const c: Casing = {
        x: s.fromX + rx * 0.18,
        z: s.fromY + rz * 0.18,
        y: ground(s.fromX, s.fromY) + 1.2,
        vx: rx * out + Math.cos(s.aim) * back,
        vz: rz * out + Math.sin(s.aim) * back,
        vy: 1.4 + u(3) * 0.8,
        yaw: u(4) * Math.PI * 2,
        spin: 18 + u(5) * 14,
        t: 0,
        landed: false,
      }
      if (this.ring.length < CASINGS_MAX) this.ring.push(c)
      else {
        this.ring[this.head] = c
        this.head = (this.head + 1) % CASINGS_MAX
      }
    }
  }

  step(dt: number, ground: (x: number, z: number) => number): void {
    for (const c of this.ring) {
      if (c.landed) continue
      c.t += dt
      c.vy -= 9.8 * dt
      c.x += c.vx * dt
      c.z += c.vz * dt
      c.y += c.vy * dt
      c.yaw += c.spin * dt
      const g = ground(c.x, c.z)
      if (c.y <= g) {
        c.y = g
        // One small bounce, then it lies still.
        if (c.t < 0.6 && c.vy < -2) this.onLand?.(c.x, c.z)
        if (c.vy < -2 && c.t < 0.6) {
          c.vy *= -0.25
          c.vx *= 0.4
          c.vz *= 0.4
          c.spin *= 0.5
        } else c.landed = true
      }
    }
  }

  poses(view: readonly [number, number, number, number], emit: (x: number, y: number, z: number, yaw: number, roll: number) => void): void {
    const [x0, z0, x1, z1] = view
    for (const c of this.ring) {
      if (c.x < x0 - 1 || c.x > x1 + 1 || c.z < z0 - 1 || c.z > z1 + 1) continue
      emit(c.x, c.y, c.z, c.yaw, c.landed ? 0 : c.yaw * 0.7)
    }
  }
}
