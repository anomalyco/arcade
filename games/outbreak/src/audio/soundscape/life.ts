import { evaluateWindGust } from "../../ambient-motion"
import type { AnimalKind } from "../../details/eyeshine"
import { domeLevel, openDoorOf, placeLaundry, type LaundryLine, type OpenDoor } from "../../details/leftovers"
import type { OutbreakDetailSettings } from "../../details/settings"
import { placeSprinklers, sprinklerReach, SPRINKLER_OFF, SPRINKLER_ON, SPRINKLER_REACH, type Sprinkler } from "../../details/sprinkler"
import type { Town } from "../../../shared/map"
import { holdAmbientSound, playAmbientSound } from "./hooks"

/**
 * The sounds of the life touches (Details · Life, AR-87), heard from the same pure placements the details draw: the
 * dawn sprinkler ticking across a lawn, washing snapping on the line when a gust catches it, the door-open chime of a
 * car left open (sagging in pitch as the battery dies with its dome light), and animals bolting from their dens.
 * Presentation only, through the soundscape's hooks.
 */

type LifeVehicle = Parameters<typeof openDoorOf>[1]
type LifeSoundFrame = { time: number; town: Town; hour: number; night: number }

const BOLT: Readonly<Record<AnimalKind, string | null>> = {
  raccoon: "scape.life.rustle",
  cat: "scape.life.rustle",
  fox: "scape.life.scurry",
  deer: "scape.life.hooves",
  watcher: null,
}

/** How far each is worth asking the soundscape for (m); its own ranges fade them out before this. */
const SPRINKLER_HEAR = 24
const LINE_HEAR = 18
const DOOR_HEAR = 15
/** The gust (`evaluateWindGust` scale) that snaps the washing, and the least time between snaps on one line (s). */
const SNAP_GUST = 1.12
const SNAP_GAP = 1.4

export class LifeSounds {
  private planTown: Town | null = null
  /** What the plan was made for: window origin, building count, laundry share, sprinkler on, seed. */
  private readonly planFor = new Float64Array(6)
  private sprinklers: Sprinkler[] = []
  private lines: LaundryLine[] = []
  private readonly perBuilding = new Map<string, { key: string; line: LaundryLine | null }>()
  private gust = new Float32Array(0)
  private snapAt = new Float32Array(0)
  private doorTown = -1
  private doorShare = -1
  private doorSeed = -1
  private readonly doors = new Map<number, { sx: number; sy: number; door: OpenDoor | null; hold: string }>()

  /** For `touches.onBolt`: an animal startled out of its den. */
  readonly bolt = (x: number, z: number, kind: AnimalKind): void => {
    const id = BOLT[kind]
    if (id) playAmbientSound(id, x, z)
  }

  update(f: LifeSoundFrame, s: OutbreakDetailSettings, storm: number, vehicles: readonly LifeVehicle[] | undefined, listener: { x: number; y: number }): void {
    if (!s.lifeTouches) return
    const town = f.town
    this.plan(town, s)
    const lx = listener.x
    const lz = listener.y
    const reach = sprinklerReach(f.night, s.lfDecay)
    if (reach > 0 && f.hour >= SPRINKLER_ON && f.hour < SPRINKLER_OFF) {
      const ramp = Math.min(1, (f.hour - SPRINKLER_ON) / 0.02, (SPRINKLER_OFF - f.hour) / 0.02)
      const pressure = reach / SPRINKLER_REACH
      for (const k of this.sprinklers) {
        if (Math.abs(k.x - lx) > SPRINKLER_HEAR || Math.abs(k.z - lz) > SPRINKLER_HEAR) continue
        // Weaker pressure ticks quieter and a little slower.
        holdAmbientSound(k.key, "scape.sprinkler", k.x, k.z, ramp * (0.35 + 0.65 * pressure), 0.85 + 0.15 * pressure)
      }
    }
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i]!
      if (Math.abs(line.x - lx) > LINE_HEAR || Math.abs(line.z - lz) > LINE_HEAR) {
        this.gust[i] = 0
        continue
      }
      const g = evaluateWindGust(f.time + line.items[0]!.seed * 0.6, line.x, line.z, 1 + storm) * (1 + storm * 0.8)
      if (g >= SNAP_GUST && this.gust[i]! < SNAP_GUST && f.time - this.snapAt[i]! >= SNAP_GAP) {
        this.snapAt[i] = f.time
        playAmbientSound("scape.washing.flap", line.x, line.z, { gain: Math.min(1.4, 0.55 + 0.45 * g), rate: 0.92 + line.items.length * 0.03 })
      }
      this.gust[i] = g
    }
    if (town.seed !== this.doorTown || s.lfOpenDoors !== this.doorShare || s.dtSeed !== this.doorSeed) {
      this.doorTown = town.seed
      this.doorShare = s.lfOpenDoors
      this.doorSeed = s.dtSeed
      this.doors.clear()
    }
    const decay = s.lfDecay
    for (const v of vehicles ?? []) {
      if (Math.abs(v.x - lx) > DOOR_HEAR || Math.abs(v.y - lz) > DOOR_HEAR) continue
      let d = this.doors.get(v.id)
      if (!d || d.sx !== v.spawnX || d.sy !== v.spawnY) {
        d = { sx: v.spawnX, sy: v.spawnY, door: openDoorOf(town, v, s), hold: `life.door:${v.id}` }
        this.doors.set(v.id, d)
      }
      const door = d.door
      if (!door || Math.hypot(v.x - v.spawnX, v.y - v.spawnY) > 0.35 || v.seats.some(Boolean)) continue
      const level = domeLevel(f.night, f.time, door.phase, decay)
      if (level <= 0.01) continue
      const n = decay ? f.night : 1
      holdAmbientSound(d.hold, "scape.car.chime", v.x, v.y, Math.min(1, 0.4 + level), n <= 1 ? 1 : n === 2 ? 0.95 : 0.88)
    }
    if (this.doors.size > 256) this.doors.clear()
  }

  reset(): void {
    this.planTown = null
    this.doorTown = -1
    this.perBuilding.clear()
    this.doors.clear()
  }

  private plan(town: Town, s: OutbreakDetailSettings): void {
    const o = town.windowOrigin
    const p = this.planFor
    const ox = o ? o[0] : 0
    const oz = o ? o[1] : 0
    const sprinkle = s.lfSprinkler ? 1 : 0
    if (town === this.planTown && p[0] === ox && p[1] === oz && p[2] === town.buildings.length && p[3] === s.lfLaundry && p[4] === sprinkle && p[5] === s.dtSeed) return
    this.planTown = town
    p[0] = ox
    p[1] = oz
    p[2] = town.buildings.length
    p[3] = s.lfLaundry
    p[4] = sprinkle
    p[5] = s.dtSeed
    const sig = `${town.seed}:${town.houseSeed}:${s.lfLaundry}:${s.lfSprinkler}:${s.dtSeed}`
    this.sprinklers = placeSprinklers(town, s)
    const lines: LaundryLine[] = []
    for (const b of town.buildings) {
      const bk = `${sig}:${b.rect.join(",")}`
      let hit = this.perBuilding.get(b.id)
      if (!hit || hit.key !== bk) {
        hit = { key: bk, line: placeLaundry(town, b, s) }
        this.perBuilding.set(b.id, hit)
      }
      if (hit.line) lines.push(hit.line)
    }
    if (this.perBuilding.size > 128) this.perBuilding.clear()
    this.lines = lines
    this.gust = new Float32Array(lines.length)
    this.snapAt = new Float32Array(lines.length).fill(-1e9)
  }
}
