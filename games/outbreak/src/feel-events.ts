import { HitStop, attenuateShake, type Camera } from "@arcade/kit/client/camera"
import { MotionBlurBurst } from "@arcade/kit/gpu/motion-blur"
import type { LocalSession } from "../shared/session"
import { supportHeight } from "../shared/terrain"
import type { OutbreakCombatFX } from "./combat-fx"
import type { NetSession } from "./net-session"
import type { OutbreakSettings } from "./settings"
import type { ZombieCrowdRenderer } from "./zombies"

/**
 * Tracks presentation-only combat state transitions (shoves, hits taken, vault landings, portal bashes, and shots)
 * and drives local `Camera`, `HitStop`, `MotionBlurBurst`, and `OutbreakCombatFX` responses without mutating shared simulation state.
 */
export class OutbreakFeelTracker {
  readonly hitStop = new HitStop()
  readonly motionBurst = new MotionBlurBurst()
  private shotParity = 0
  private prevHealth = 100
  private prevShoveAnim = 0
  private wasVaulting = false
  private readonly prevPortalBashTime = new Map<string, number>()
  private readonly prevPortalPlanks = new Map<string, number>()
  private readonly prevDoorOpen = new Map<string, boolean>()
  private readonly processedVehicleHits = new Set<string>()

  constructor(
    private readonly cam: Camera,
    private readonly settings: OutbreakSettings,
    initialPlayer: { health: number; shoveAnim: number; vault: unknown },
  ) {
    this.reset(initialPlayer)
  }

  reset(player: { health: number; shoveAnim: number; vault: unknown }): void {
    this.cam.resetShake()
    this.hitStop.reset()
    this.motionBurst.reset()
    this.prevHealth = player.health
    this.prevShoveAnim = player.shoveAnim
    this.wasVaulting = Boolean(player.vault)
    this.prevPortalBashTime.clear()
    this.prevPortalPlanks.clear()
    this.prevDoorOpen.clear()
    this.processedVehicleHits.clear()
  }

  triggerShot(aim: number, power = 1): void {
    this.shotParity ^= 1
    this.cam.add(0.32 * power, aim + Math.PI, 2.2 * power)
    this.cam.punch(0.28 * power, (this.shotParity ? 1 : -1) * 0.008 * power)
    if (!this.cam.isReducedMotion()) {
      this.motionBurst.add(
        { dir: aim, directional: 0.006 * power, radial: 0.003 * power, boost: 0.45 * power },
        this.settings.motion.burst,
      )
    }
  }

  triggerShove(aim: number, hits = 1): void {
    const k = hits > 0 ? 1 + Math.min(2, hits - 1) * 0.3 : 0.45
    this.cam.add((hits > 0 ? 0.3 : 0.14) * k, aim, (hits > 0 ? 2.4 : 1.0) * k)
    this.cam.punch(hits > 0 ? -0.22 : -0.08, 0.009 * k)
    if (hits > 0) {
      this.hitStop.trigger(0.028, 0.08, !this.cam.isReducedMotion())
      if (!this.cam.isReducedMotion()) {
        this.motionBurst.add(
          { dir: aim, directional: 0.005 * k, radial: 0.004 * k, boost: 0.35 * k },
          this.settings.motion.burst,
        )
      }
    }
  }

  triggerHitTaken(atkDx: number, atkDz: number, damage = 25): void {
    const scale = Math.max(0.35, Math.min(1.6, damage / 20))
    const dir = Math.atan2(atkDz, atkDx)
    this.cam.add(0.52 * scale, dir, 3.2 * scale)
    this.cam.punch(0.38 * scale, 0.016 * scale)
    this.cam.addFlash(0.65 * scale)
    this.hitStop.trigger(0.026, 0.08, !this.cam.isReducedMotion())
    if (!this.cam.isReducedMotion()) {
      this.motionBurst.add(
        { dir, directional: 0.007 * scale, radial: 0.008 * scale, boost: 0.6 * scale },
        this.settings.motion.burst,
      )
    }
  }

  triggerBlast(x: number, z: number, listenerX: number, listenerZ: number, radius = 24, power = 1): void {
    const dist = Math.hypot(x - listenerX, z - listenerZ)
    const att = attenuateShake(dist, radius) * power
    if (att <= 0) return
    const dir = dist > 1e-3 ? Math.atan2(listenerZ - z, listenerX - x) : 0
    this.cam.add(0.62 * att, dir, 3.4 * att)
    this.cam.punch(0.45 * att, 0.018 * att)
    if (!this.cam.isReducedMotion()) {
      this.motionBurst.add(
        { dir, directional: 0.005 * att, radial: 0.009 * att, boost: 0.65 * att },
        this.settings.motion.burst,
      )
    }
  }

  triggerImpulse(
    kind: string,
    player: { x: number; y: number; aim: number },
    opts?: { power?: number; damage?: number },
  ) {
    const power = opts?.power ?? 1
    const damage = opts?.damage ?? 25
    if (kind === "shove") this.triggerShove(player.aim, 1)
    else if (kind === "hit-taken") this.triggerHitTaken(-Math.cos(player.aim), -Math.sin(player.aim), damage)
    else if (kind === "explosion") {
      this.triggerBlast(
        player.x + Math.cos(player.aim) * 4.5,
        player.y + Math.sin(player.aim) * 4.5,
        player.x,
        player.y,
        24,
        power,
      )
    } else {
      this.triggerShot(player.aim, power)
    }
    return this.inspect()
  }

  inspect() {
    return {
      trauma: this.cam.trauma,
      damageFlash: this.cam.damageFlash,
      hitStopRemaining: this.hitStop.remaining,
      offset: { ...this.cam.offset },
      burst: {
        dx: this.motionBurst.dx,
        dy: this.motionBurst.dy,
        radial: this.motionBurst.radial,
        shutterBoost: this.motionBurst.shutterBoost,
      },
    }
  }

  processFrame(
    session: LocalSession | NetSession,
    combatFx: OutbreakCombatFX,
    zombieCrowd: ZombieCrowdRenderer,
    addSprites: Float32Array,
    playerGroundY: number,
    dt: number,
  ): number {
    const { player: p, town, time, zombies, shots } = session.view
    const { settings, cam } = this

    if (p.shoveAnim > this.prevShoveAnim + 0.05) {
      let shovedHits = 0
      for (const z of zombies) {
        if (z.state === "stagger" && z.hitFlash > 0.45 && Math.hypot(z.x - p.x, z.y - p.y) < 2.2) {
          shovedHits++
        }
      }
      this.triggerShove(p.aim, shovedHits)
      if (shovedHits > 0 && settings.combat.bloodStyle !== 0) {
        combatFx.legacyMode = settings.combat.bloodStyle === 2
        combatFx.emitShoveHit(p.x, p.y, p.aim, playerGroundY, shovedHits, Math.floor(time * 1000) + 17)
      }
    }
    this.prevShoveAnim = p.shoveAnim

    if (p.health < this.prevHealth - 0.1 && time > 0.02) {
      const damage = this.prevHealth - p.health
      let atkDx = -Math.cos(p.aim)
      let atkDz = -Math.sin(p.aim)
      let bestDist = 2.5
      for (const z of zombies) {
        if (z.state === "dead") continue
        const d = Math.hypot(p.x - z.x, p.y - z.y)
        if (d < bestDist && d > 0.01) {
          bestDist = d
          atkDx = (p.x - z.x) / d
          atkDz = (p.y - z.y) / d
        }
      }
      this.triggerHitTaken(atkDx, atkDz, damage)
      if (settings.combat.bloodStyle !== 0) {
        combatFx.legacyMode = settings.combat.bloodStyle === 2
        combatFx.emitSurvivorHit(p.x, p.y, atkDx, atkDz, playerGroundY, damage, Math.floor(time * 1000) + 31)
      }
    }
    this.prevHealth = p.health

    const nowVaulting = Boolean(p.vault)
    if (this.wasVaulting && !nowVaulting) {
      cam.add(0.14, p.aim, 0.7)
      cam.punch(0.1, 0)
    }
    this.wasVaulting = nowVaulting

    for (const d of town.doors) {
      const st = session.ai.portalStates.get(d.id)
      if (!st) continue
      const lastBash = this.prevPortalBashTime.get(d.id) ?? -Infinity
      const prevPlanks = this.prevPortalPlanks.get(d.id) ?? st.barricadePlanks
      const wasOpen = this.prevDoorOpen.get(d.id) ?? d.open
      if (st.lastBashTime > lastBash && time - st.lastBashTime < 0.12) {
        const cx = (d.rect[0] + d.rect[2]) * 0.5
        const cz = (d.rect[1] + d.rect[3]) * 0.5
        const broke = st.barricadePlanks < prevPlanks || (d.open && !wasOpen)
        const dist = Math.hypot(cx - p.x, cz - p.y)
        const att = attenuateShake(dist, 16)
        if (att > 0) {
          cam.add((broke ? 0.34 : 0.18) * att, Math.atan2(p.y - cz, p.x - cx), (broke ? 1.5 : 0.7) * att)
        }
      }
      this.prevPortalBashTime.set(d.id, st.lastBashTime)
      this.prevPortalPlanks.set(d.id, st.barricadePlanks)
      this.prevDoorOpen.set(d.id, d.open)
    }
    for (const win of town.windows) {
      const st = session.ai.portalStates.get(win.id)
      if (!st) continue
      const lastBash = this.prevPortalBashTime.get(win.id) ?? -Infinity
      const prevPlanks = this.prevPortalPlanks.get(win.id) ?? st.barricadePlanks
      if (st.lastBashTime > lastBash && time - st.lastBashTime < 0.12) {
        const cx = (win.rect[0] + win.rect[2]) * 0.5
        const cz = (win.rect[1] + win.rect[3]) * 0.5
        const broke = st.barricadePlanks < prevPlanks
        const dist = Math.hypot(cx - p.x, cz - p.y)
        const att = attenuateShake(dist, 16)
        if (att > 0) {
          cam.add((broke ? 0.34 : 0.18) * att, Math.atan2(p.y - cz, p.x - cx), (broke ? 1.5 : 0.7) * att)
        }
      }
      this.prevPortalBashTime.set(win.id, st.lastBashTime)
      this.prevPortalPlanks.set(win.id, st.barricadePlanks)
    }

    combatFx.legacyMode = settings.combat.bloodStyle === 2
    for (const hit of session.sim.vehicles.recentHits) {
      const hitKey = `${hit.vehicleId}:${hit.zombieId}:${hit.time.toFixed(3)}`
      if (this.processedVehicleHits.has(hitKey)) continue
      this.processedVehicleHits.add(hitKey)
      if (this.processedVehicleHits.size > 128) {
        this.processedVehicleHits.delete(this.processedVehicleHits.keys().next().value!)
      }
      if (settings.combat.bloodStyle !== 0) {
        combatFx.emitShoveHit(
          hit.x,
          hit.y,
          Math.atan2(hit.dirY, hit.dirX),
          supportHeight(town, hit.x, hit.y),
          hit.killed ? 3 : 1,
          Math.floor(hit.time * 1000) + hit.zombieId,
        )
      }
      if (hit.vehicleId === p.vehicleId) {
        const pwr = Math.min(1.4, 0.65 + hit.speed * 0.08)
        const dir = Math.atan2(hit.dirY, hit.dirX)
        cam.add((hit.killed ? 0.24 : 0.14) * pwr, dir, (hit.killed ? 0.9 : 0.5) * pwr)
        if (hit.killed) {
          cam.punch(-0.16 * pwr, 0)
        }
      }
    }
    return combatFx.processShots(
      shots,
      time,
      dt,
      session.ai,
      zombieCrowd,
      (x, z) => supportHeight(town, x, z),
      addSprites,
      0,
      (shot) => {
        const distFromMe = Math.hypot(shot.fromX - p.x, shot.fromY - p.y)
        const isLocalShot = distFromMe < 1.8
        if (isLocalShot) {
          this.triggerShot(shot.aim, 1)
          if (shot.hitZombieId !== null) {
            const pwr = shot.detachBone ? 1.25 : 1.0
            cam.add((shot.killed ? 0.22 : 0.12) * pwr, shot.aim, (shot.killed ? 0.85 : 0.45) * pwr)
            if (shot.killed) {
              cam.punch(-0.18 * pwr, 0)
              this.hitStop.trigger(0.022 * pwr, 0.08, !cam.isReducedMotion())
            }
          }
        } else if (distFromMe < 16) {
          const peerAtt = attenuateShake(distFromMe, 16) * 0.35
          this.triggerShot(shot.aim, peerAtt)
        }
      },
    )
  }
}
