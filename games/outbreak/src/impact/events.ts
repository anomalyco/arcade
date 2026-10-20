import { attenuateShake } from "@arcade/kit/client/camera"
import type { AIAgent } from "../../shared/ai"
import { blastAge, DYN_RING, ringId } from "../../shared/fire/fire"
import { solidRects } from "../../shared/map"
import { supportHeight } from "../../shared/terrain"
import { halfOf } from "../../shared/vehicles"
import type { OutbreakFeelFrameContext } from "../feel-events"
import { hitStopSeconds } from "../feel-tuning"
import type { ImpactBodies } from "./bodies"
import { blastBlow, meleeBlow, shotBlow, shoveBlow, vehicleBlow } from "./causes"
import { impactOn } from "./settings"

/**
 * Watches the replicated combat events a client already has (shots, melee swings, shoves, vehicle hits, dynamite
 * blasts) and turns each into body physics and the extra feel layers: no new wire fields, and every client derives
 * the same blows from the same events.
 */
export class ImpactEvents {
  private readonly seenShots = new Set<number>()
  private readonly seenHits = new Set<string>()
  private readonly seenVehicleHits = new Set<string>()
  private readonly feltBlasts = new Map<string, number>()
  private prevShove = 0
  private frame = 0
  private solidsDigest: readonly unknown[] | null = null
  readonly stats = { shots: 0, melee: 0, shoves: 0, vehicles: 0, blasts: 0, corpsePushes: 0 }

  constructor(readonly bodies: ImpactBodies) {}

  reset(player: { shoveAnim: number }): void {
    this.seenShots.clear()
    this.seenHits.clear()
    this.seenVehicleHits.clear()
    this.feltBlasts.clear()
    this.prevShove = player.shoveAnim
    this.bodies.reset()
    for (const k of Object.keys(this.stats) as (keyof typeof this.stats)[]) this.stats[k] = 0
  }

  process(ctx: OutbreakFeelFrameContext): void {
    const { session, settings, zombieCrowd, tracker, cam } = ctx
    const s = settings.impact
    const bodies = this.bodies
    bodies.settings = s
    if (zombieCrowd.physics !== bodies) zombieCrowd.physics = bodies
    const view = session.view
    const { player: p, town, time, zombies } = view
    const on = impactOn(s)
    this.frame++
    const byId = (id: number): AIAgent | undefined => {
      for (const z of zombies) if (z.id === id) return z
      return undefined
    }
    if (this.frame % 30 === 1) {
      const rects = solidRects(town)
      if (rects !== this.solidsDigest) {
        this.solidsDigest = rects
        bodies.solids = rects
      }
      const live = new Set<number>()
      const dead = new Set<number>()
      for (const z of zombies) (z.state === "dead" ? dead : live).add(z.id)
      bodies.prune((id) => dead.has(id), (id) => live.has(id) || dead.has(id))
    }

    // Shots.
    for (const shot of view.shots) {
      if (this.seenShots.has(shot.id)) continue
      this.seenShots.add(shot.id)
      if (this.seenShots.size > 256) this.seenShots.delete(this.seenShots.values().next().value!)
      if (!on || shot.hitZombieId === null || shot.predicted) continue
      const z = byId(shot.hitZombieId)
      if (!z) continue
      const blow = shotBlow(shot)
      if (shot.killed) bodies.killed(z.id, blow.dead)
      else bodies.hitLiving(z, blow.living)
      this.stats.shots++
      const local = Math.hypot(shot.fromX - p.x, shot.fromY - p.y) < 1.8
      if (local && !shot.killed && s.impactShotHitStop > 0) {
        tracker.hitStop.trigger(hitStopSeconds(s.impactShotHitStop), 0.08, !cam.isReducedMotion())
      }
    }

    // Melee swings (yours and your teammates').
    for (const swing of view.meleeSwings) {
      if (!on) break
      for (const hit of swing.hits) {
        const key = `${swing.id}:${hit.zombieId}`
        if (this.seenHits.has(key)) continue
        this.seenHits.add(key)
        if (this.seenHits.size > 512) this.seenHits.delete(this.seenHits.values().next().value!)
        const z = byId(hit.zombieId)
        if (!z) continue
        const blow = meleeBlow(swing, hit, z.x, z.y)
        if (hit.killed) bodies.killed(z.id, blow.dead)
        else bodies.hitLiving(z, blow.living)
        this.stats.melee++
      }
    }

    // Your shove: the zombies it staggered rock back.
    if (p.shoveAnim > this.prevShove + 0.05 && on) {
      for (const z of zombies) {
        if (z.state === "stagger" && z.hitFlash > 0.45 && Math.hypot(z.x - p.x, z.y - p.y) < 2.2) {
          bodies.hitLiving(z, shoveBlow(p.aim, p.x, p.y, z.x, z.y, z.id))
          this.stats.shoves++
        }
      }
    }
    this.prevShove = p.shoveAnim

    // Cars: blows on the ones they hit, and bodies already down thrown from under the wheels.
    const vehicles = session.sim.vehicles
    for (const hit of vehicles.recentHits) {
      const key = `${hit.vehicleId}:${hit.zombieId}:${hit.time.toFixed(3)}`
      if (this.seenVehicleHits.has(key)) continue
      this.seenVehicleHits.add(key)
      if (this.seenVehicleHits.size > 128) this.seenVehicleHits.delete(this.seenVehicleHits.values().next().value!)
      if (!on) continue
      const v = vehicles.byId(hit.vehicleId)
      const blow = vehicleBlow(hit.dirX, hit.dirY, hit.speed, v?.vx ?? 0, v?.vy ?? 0, hit.zombieId, hit.time)
      const z = byId(hit.zombieId)
      if (hit.killed) bodies.killed(hit.zombieId, blow.dead)
      else if (z) bodies.hitLiving(z, blow.living)
      this.stats.vehicles++
      if (hit.vehicleId === p.vehicleId && hit.killed && s.impactCarHit > 0) {
        tracker.hitStop.trigger(hitStopSeconds(30 * s.impactCarHit), 0.1, !cam.isReducedMotion())
        cam.punch(-0.12 * s.impactCarHit, 0.01 * s.impactCarHit)
      }
    }
    if (on) {
      for (const v of view.vehicles) {
        const speed = Math.hypot(v.vx, v.vy)
        if (speed < 1.5) continue
        const [hl, hw] = halfOf(v.spec)
        const n = bodies.sweep({ x: v.x, z: v.y, yaw: v.h, halfLength: hl + 0.15, halfWidth: hw + 0.1 }, v.vx, v.vy, supportHeight(town, v.x, v.y))
        this.stats.corpsePushes += n
      }
    }

    // Dynamite: the caught are thrown, the dead already down are blown along the ground, and you feel it.
    for (let k = 0; k < DYN_RING; k++) {
      const st = view.progression.ledger.store(ringId("dyn", k))
      if (!st?.at || !st.counts.t) continue
      const age = blastAge(st, time)
      const key = ringId("dyn", k)
      if (age < 0 || age > 0.5 || this.feltBlasts.get(key) === st.counts.t) continue
      this.feltBlasts.set(key, st.counts.t)
      if (!on) continue
      const { x, y } = st.at
      const R = Math.max(0.5, settings.fire.dynRadius)
      for (const z of zombies) {
        const d = Math.hypot(z.x - x, z.y - y)
        if (d > R * 1.15) continue
        const f = Math.max(0, 1 - d / R)
        const dirX = d > 0.05 ? (z.x - x) / d : 1
        const dirZ = d > 0.05 ? (z.y - y) / d : 0
        const blow = blastBlow(dirX, dirZ, f, z.id, k)
        if (z.state === "dead") bodies.killed(z.id, blow.dead)
        else bodies.hitLiving(z, blow.living)
      }
      this.stats.corpsePushes += bodies.blast(x, y, supportHeight(town, x, y), 9, R * 1.6)
      this.stats.blasts++
      const dist = Math.hypot(x - p.x, y - p.y)
      const att = attenuateShake(dist, 30)
      if (att > 0) {
        const dir = dist > 1e-3 ? Math.atan2(p.y - y, p.x - x) : p.aim + Math.PI
        const kick = s.impactBlastKick * att
        cam.add(0.18 * kick, dir, 3.6 * kick)
        cam.punch(0.55 * kick, (k % 2 ? 1 : -1) * 0.02 * kick)
        tracker.hitStop.trigger(hitStopSeconds(s.impactBlastHitStop * att), 0.12, !cam.isReducedMotion())
      }
    }
  }
}
