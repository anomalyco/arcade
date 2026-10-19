import type { WorldContext } from "../world/context"
import { BUILDING, CORE, FREIGHT } from "../world/layout"
import type { Sfx } from "./engine"

// The horror layer: now and then, something in the building that isn't you. Never in the first two minutes, then at
// most one event every 45–90 s, chosen from what is plausible where the listener stands:
//  - a heavy metal bang somewhere far off and below (heard through floors and walls, so muffled),
//  - knocking on a closed door 4–12 m away,
//  - someone else's footsteps on the floor above (or down another corridor on the top floor),
//  - a sub-rumble from below when near the core or the freight lift FL-1.
// (The listening room's radio voices are the interior's story beat: storeys/s3/listening.ts.)
// Off by default in play mode: `level` (Lab "Horror layer") 0 fires nothing; above 0 it scales every event.
// Every event is positional and occluded like any other sound. `?horror=<s>` (automation only) sets the first delay.

type Event = { kind: string; weight: number; fire: () => void }

export class Horror {
  private time = 0
  private next: number
  /** Automation: events fired. */
  readonly log: { t: number; kind: string }[] = []

  constructor(
    private ctx: WorldContext,
    private sfx: Sfx,
  ) {
    const first = Number(ctx.params.get("horror"))
    this.next = Number.isFinite(first) && ctx.params.has("horror") ? first : 120 + Math.random() * 30
  }

  /** 0 (off) .. 1: set every frame from the Lab's "Horror layer". */
  level = 0

  update(dt: number, ear: { x: number; y: number; z: number }, indoor: number) {
    this.time += dt
    if (this.level <= 0 || this.time < this.next) return
    const events = this.options(ear, indoor)
    const total = events.reduce((s, e) => s + e.weight, 0)
    let r = Math.random() * total
    const e = events.find((ev) => (r -= ev.weight) <= 0) ?? events[0]
    if (e) {
      e.fire()
      this.log.push({ t: +this.time.toFixed(1), kind: e.kind })
    }
    this.next = this.time + 45 + Math.random() * 45
  }

  private options(ear: { x: number; y: number; z: number }, indoor: number): Event[] {
    const out: Event[] = []
    const play = (id: Parameters<Sfx["play"]>[0], pos: { x: number; y: number; z: number }, gain: number, ref: number) =>
      this.sfx.play(id, { bus: "horror", pos, gain: gain * this.level, ref, rolloff: 1, jitter: 0.04 })
    const a = Math.random() * Math.PI * 2
    out.push({
      kind: "metal-bang",
      weight: 1,
      fire: () => play("hor-metal-bang", { x: ear.x + Math.cos(a) * 30, y: ear.y - 8, z: ear.z + Math.sin(a) * 30 }, 1, 8),
    })
    if (indoor > 0.5) {
      // Knocks on a closed door nearby.
      const doors = this.ctx.doors
      const cands = doors
        .all()
        .filter((d) => d.amount < 0.02)
        .map((d) => ({ d, c: doors.centreOf(d.id)! }))
        .filter(({ c }) => c && Math.abs(c.y - ear.y) < 2.5 && Math.hypot(c.x - ear.x, c.z - ear.z) > 4 && Math.hypot(c.x - ear.x, c.z - ear.z) < 12)
      if (cands.length) {
        const { c } = cands[Math.floor(Math.random() * cands.length)]!
        out.push({ kind: "knock", weight: 1.5, fire: () => play("hor-knock", c, 0.8, 2) })
      }
      // Footsteps above (or along another corridor on the top floor).
      const M = BUILDING.main
      const storey = Math.round((ear.y - 1.6 - BUILDING.floorY) / M.storeyHeight)
      const b = Math.random() * Math.PI * 2
      const r = 6 + Math.random() * 4
      const above = storey < M.storeys - 1
      out.push({
        kind: above ? "footsteps-above" : "footsteps-corridor",
        weight: 1.5,
        fire: () => play("hor-footsteps-other", above ? { x: ear.x + Math.cos(b) * r, y: ear.y + M.storeyHeight, z: ear.z + Math.sin(b) * r } : { x: ear.x + 15 * Math.sign(Math.cos(b)), y: ear.y, z: ear.z }, 0.9, 3),
      })
    }
    const near = (rect: { min: readonly [number, number]; max: readonly [number, number] }, d: number) =>
      Math.hypot(ear.x - (rect.min[0] + rect.max[0]) / 2, ear.z - (rect.min[1] + rect.max[1]) / 2) < d
    if (near(CORE.stair, 15) || near(CORE.lift, 15) || near(FREIGHT.car, 15)) {
      out.push({ kind: "sub-rumble", weight: 2, fire: () => play("hor-sub-rumble", { x: ear.x, y: ear.y - 6, z: ear.z }, 1, 10) })
    }
    return out
  }
}
