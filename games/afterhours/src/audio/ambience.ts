import type { Lamp, WorldContext } from "../world/context"
import { interiorRooms, type RoomEntry } from "../world/interior/registry"
import { NIGHT_ROOMS } from "../world/interior/lighting-state"
import { BUILDING, FREIGHT, RISER, SUBLEVEL_Y, storeyY } from "../world/layout"
import type { LoopVoice, Sfx } from "./engine"

// The world's steady sounds and weather.
//  Outdoors: rain on asphalt as the base bed with the rain-and-distant-thunder bed layered on it, plus single thunder
//   events every 30–120 s (panned anywhere, now and then a loud close crack). Indoors all of it is muffled by the
//   building (low-passed and quieter) rather than cut.
//  Indoors: the building's HVAC (one take on even storeys, the other on odd) and the corridor's room tone as beds;
//   fluorescent hum from the lit tubes nearest the listener (four positional voices that follow the nearest fixtures,
//   not one per tube), the flicker take now and then from a flickering tube; the machine room (3-04), the radio static
//   in the listening room (3-08) and the off-hook phone on the Chief's desk (1-07) as positional loops; a CRT's
//   whine when passing a lit terminal; and the low drone near the Sublevel's ways in (FL-1, the W-1 risers).
// Positional voices are occluded by walls (engine.ts). The forest-night bed is not shipped yet (its pick sounded like
// a highway); `forest` is the slot for it. `?thunder=<s>` (automation only) sets when the first thunder comes.

const HUM_VOICES = 4
const HUM_RANGE = 10

type Spot = { id: string; storey: number; voice: LoopVoice; level: number; room?: RoomEntry; y: number }

export class Ambience {
  private rain: LoopVoice
  private rainThunder: LoopVoice
  private hvac: [LoopVoice, LoopVoice]
  private tone: LoopVoice
  private drone: LoopVoice
  /** Slot for the forest-night bed once a usable take exists (`amb-forest-night` ships no files). */
  readonly forest: LoopVoice | null = null
  private hums: { voice: LoopVoice; lamp: Lamp | null }[] = []
  private spots: Spot[]
  private nextHum = 0
  private nextThunder: number
  private cool = new Map<unknown, number>()
  private time = 0

  constructor(
    private ctx: WorldContext,
    private sfx: Sfx,
  ) {
    // `?thunder=<s>` (automation only): when the first thunder comes.
    const first = Number(ctx.params.get("thunder"))
    this.nextThunder = ctx.params.has("thunder") && Number.isFinite(first) ? first : 25 + Math.random() * 40
    const bed = (id: Parameters<Sfx["loop"]>[0], variant = 0) => sfx.loop(id, { bus: "ambience", variant })
    this.rain = bed("amb-rain-asphalt")
    this.rainThunder = bed("amb-rain-thunder")
    this.hvac = [bed("amb-hvac", 0), bed("amb-hvac", 1)]
    this.tone = bed("amb-corridor-tone")
    this.drone = sfx.loop("hor-drone", { bus: "horror" })
    for (let i = 0; i < HUM_VOICES; i++) this.hums.push({ voice: sfx.loop("light-fluoro-hum", { bus: "ambience", positional: true, ref: 1.1, rolloff: 1.6 }), lamp: null })
    const spot = (id: string, storey: number, sound: Parameters<Sfx["loop"]>[0], level: number, ref: number, rolloff: number, y: number): Spot => ({
      id,
      storey,
      level,
      y,
      voice: sfx.loop(sound, { bus: "ambience", positional: true, ref, rolloff }),
    })
    this.spots = [
      spot("3-04", 3, "amb-machine-room", 0.9, 3, 1, 1.2),
      spot("3-08", 3, "amb-radio-static", 0.55, 1.4, 1.3, 1.0),
      spot("1-07", 1, "int-phone-offhook", 0.45, 0.5, 1.5, 0.8),
    ]
  }

  update(dt: number, ear: { x: number; y: number; z: number }, indoor: number) {
    this.time += dt
    const now = this.time
    const M = BUILDING.main
    const storey = Math.max(0, Math.min(M.storeys, Math.round((ear.y - 1.6 - BUILDING.floorY) / M.storeyHeight)))

    // Weather, muffled by the building indoors.
    const out = 1 - 0.8 * indoor
    const cut = 20000 * (1 - indoor) + 650 * indoor
    this.rain.set(0.6 * out, cut)
    this.rainThunder.set(0.32 * out, cut)
    this.thunder(dt, indoor)

    // Building beds.
    this.hvac[0].set(storey % 2 === 0 ? 0.32 * indoor : 0)
    this.hvac[1].set(storey % 2 === 1 ? 0.32 * indoor : 0)
    this.tone.set(0.55 * indoor)

    // The drone near the Sublevel's ways in: FL-1 (ground floor) and the W-1 risers, and below ground.
    const fl = { x: (FREIGHT.car.min[0] + FREIGHT.car.max[0]) / 2, z: (FREIGHT.car.min[1] + FREIGHT.car.max[1]) / 2 }
    const w1 = { x: (RISER.min[0] + RISER.max[0]) / 2, z: (RISER.min[1] + RISER.max[1]) / 2 }
    const near = (p: { x: number; z: number }, r: number) => Math.max(0, 1 - Math.hypot(ear.x - p.x, ear.z - p.z) / r)
    const below = ear.y < SUBLEVEL_Y + 4 ? 1 : 0
    const drone = Math.max(storey === 0 ? near(fl, 12) : 0, near(w1, 8), below)
    this.drone.set(0.22 * drone * Math.max(indoor, below))

    // Fluorescent hum from the nearest lit tubes on this storey.
    if (now >= this.nextHum) {
      this.nextHum = now + 0.5
      this.assignHums(ear, storey, indoor)
    }
    for (const h of this.hums) {
      if (h.lamp) h.voice.at(h.lamp.position[0], h.lamp.position[1], h.lamp.position[2])
      h.voice.set(h.lamp ? 0.45 : 0)
      h.voice.update(dt, now)
    }

    // Rooms with their own sound.
    for (const s of this.spots) {
      s.room ??= interiorRooms.find((r) => r.storey === s.storey && r.id === s.id)
      const r = s.room
      if (!r) continue
      const x = (r.rect.x0 + r.rect.x1) / 2
      const z = (r.rect.z0 + r.rect.z1) / 2
      const y = storeyY(s.storey) + s.y
      s.voice.at(x, y, z)
      const d = Math.hypot(ear.x - x, ear.y - y, ear.z - z)
      s.voice.set(d < 28 ? s.level : 0)
      s.voice.update(dt, now)
    }

    // A lit CRT's whine as you pass it.
    for (const room of NIGHT_ROOMS) {
      if (room.lit !== "crt" || room.storey !== storey) continue
      for (const src of room.sources) {
        const y = storeyY(room.storey) + 1.0
        if (Math.hypot(ear.x - src.x, ear.z - src.z) > 3 || Math.abs(ear.y - y) > 2.5) continue
        if ((this.cool.get(src) ?? -1e9) > now) continue
        this.cool.set(src, now + 45)
        this.sfx.play("int-crt-whine", { bus: "ambience", pos: { x: src.x, y, z: src.z }, ref: 0.8, rolloff: 1.4, gain: 0.35 })
      }
    }

    for (const v of [this.rain, this.rainThunder, ...this.hvac, this.tone, this.drone]) v.update(dt, now)
  }

  private assignHums(ear: { x: number; y: number; z: number }, storey: number, indoor: number) {
    const zone = `interior:${storey}`
    const lit: { lamp: Lamp; d: number }[] = []
    if (indoor > 0.3) {
      for (const l of this.ctx.lamps) {
        if (l.kind !== "fluorescent" || l.intensity <= 0 || (l.zone && l.zone !== zone)) continue
        const d = Math.hypot(ear.x - l.position[0], ear.y - l.position[1], ear.z - l.position[2])
        if (d < HUM_RANGE) lit.push({ lamp: l, d })
        // A flickering tube nearby pops and ticks now and then.
        if (d < 8 && (l.flicker ?? 0) > 0.2 && (this.cool.get(l) ?? -1e9) < this.time && Math.random() < 0.5 / 15) {
          this.cool.set(l, this.time + 25)
          this.sfx.play("light-fluoro-flicker", { bus: "ambience", pos: { x: l.position[0], y: l.position[1], z: l.position[2] }, ref: 1.2, rolloff: 1.4, gain: 0.5 })
        }
      }
    }
    lit.sort((a, b) => a.d - b.d)
    const want = lit.slice(0, HUM_VOICES).map((e) => e.lamp)
    // Keep voices on lamps that are still wanted; move the others to the new ones.
    const free = this.hums.filter((h) => !h.lamp || !want.includes(h.lamp))
    for (const l of want) {
      if (this.hums.some((h) => h.lamp === l)) continue
      const h = free.shift()
      if (h) h.lamp = l
    }
    for (const h of free) h.lamp = null
  }

  private thunder(dt: number, indoor: number) {
    this.nextThunder -= dt
    if (this.nextThunder > 0) return
    this.nextThunder = 30 + Math.random() * 90
    // Variants: v2, v4 (the loud close crack), v5, v6.
    const close = Math.random() < 0.15
    const variant = close ? 1 : [0, 2, 3][Math.floor(Math.random() * 3)]!
    const gain = (close ? 1 : 0.45 + Math.random() * 0.3) * (1 - 0.55 * indoor)
    this.sfx.play("amb-thunder", { bus: "ambience", variant, gain, pan: (Math.random() * 2 - 1) * 0.7, lowpass: indoor > 0.5 ? 450 : close ? 20000 : 6000, jitter: 0.05 })
  }
}
