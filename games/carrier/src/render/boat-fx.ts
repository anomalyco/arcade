import { BOAT, type Boat, boatState } from "../../shared/boat"
import { type ShipPoseLike, type Vec3, shipToWorld } from "../../shared/plane"
import type { WeaponFx } from "./weapon-fx"

const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo)
const SPRAY: [number, number, number] = [0.93, 0.96, 0.99]

/** What the boat effects need per boat: its pose and motion (shared/boat.ts `Boat` has it all). */
export type FxBoat = ShipPoseLike & Pick<Boat, "u" | "v" | "power" | "wet" | "wetAft" | "slams" | "boosting">

type Seen = { slams: number; wet: number; t: number }

/**
 * Boat effects on a WeaponFx (src/render/weapon-fx.ts; its particles, smoke and fireballs): bow spray thrown off both
 * chines at speed, the waterjets' rooster tail, a white burst when the hull slams back into the water, damage smoke
 * and deck fire from its health, the launch splash, the 25 mm muzzle flash, tracers and strikes, and the kill.
 * Per frame after `wfx.begin`: `boat(id, pose, hp, dt)` for every boat drawn, plus the one-shots.
 */
export class BoatFx {
  private seen = new Map<number, Seen>()
  private p: Vec3 = [0, 0, 0]
  private q: Vec3 = [0, 0, 0]
  private frame = 0

  constructor(readonly wfx: WeaponFx) {}

  private world(b: ShipPoseLike, x: number, y: number, z: number, out: Vec3 = this.p): Vec3 {
    return shipToWorld(b, x, y, z, out)
  }

  /** One boat this frame: spray and wake splashes from its motion, smoke and fire from `hp`. `sinking` 0..1. */
  boat(id: number, b: FxBoat, hp: number, dt: number, sinking = 0): void {
    this.frame++
    let s = this.seen.get(id)
    if (!s) this.seen.set(id, (s = { slams: b.slams, wet: b.wet, t: 0 }))
    s.t = this.frame
    const fx = this.wfx
    const sh = Math.sin(b.heading)
    const ch = Math.cos(b.heading)
    const vx = b.u * sh + b.v * ch
    const vz = -b.u * ch + b.v * sh
    const speed = Math.max(0, b.u) / BOAT.topSpeed
    if (sinking <= 0) {
      // Bow spray: faceted white chunks off both chines where the bow wave peels away (the sea impacts' look), a
      // little mist with them; more, higher and wider with speed.
      const rate = 110 * speed * speed * b.wet
      for (const side of [-1, 1]) {
        let n = rate * dt
        while (n > 0) {
          if (n < 1 && Math.random() > n) break
          n--
          const f = rnd(2.5, 6.5)
          const p = this.world(b, side * -rnd(2.2, 2.7), rnd(0, 0.3), f)
          // Outward (starboard is boat-local −X: side +1) and up, carried back with the water.
          const out = (1.5 + 6.5 * speed) * rnd(0.6, 1.2)
          const ox = ch * side
          const oz = sh * side
          this.rock(p, vx * 0.6 + ox * out, rnd(1.5, 3) + 4.5 * speed, vz * 0.6 + oz * out, rnd(0.4, 0.75), rnd(0.15, 0.3), rnd(0.4, 0.8))
          if (Math.random() < 0.08) fx.spawn(1, p[0], p[1], p[2], p[0], p[1], p[2], vx * 0.5 + ox * out * 0.5, 1.5, vz * 0.5 + oz * out * 0.5, rnd(0.6, 1), 0.5, rnd(1.6, 2.4), SPRAY[0], SPRAY[1], SPRAY[2], 0.18, 0.9, -1)
        }
      }
      // Rooster tail from the waterjets.
      const jet = 40 * Math.max(0, b.power) * Math.min(1, speed * 2) * b.wetAft * (b.boosting ? 1.6 : 1)
      let n = jet * dt
      while (n > 0) {
        if (n < 1 && Math.random() > n) break
        n--
        const p = this.world(b, rnd(-1.3, 1.3), 0.4, -8.8)
        const back = 2 + 5 * speed
        this.rock(p, vx * 0.65 - sh * back, rnd(2.5, 5) * (0.5 + speed), vz * 0.65 + ch * back, rnd(0.5, 0.9), rnd(0.2, 0.35), rnd(0.5, 1))
        if (Math.random() < 0.1) fx.spawn(1, p[0], p[1], p[2], p[0], p[1], p[2], vx * 0.6 - sh * back, 2, vz * 0.6 + ch * back, rnd(0.7, 1.1), 0.6, rnd(2, 3), SPRAY[0], SPRAY[1], SPRAY[2], 0.16, 0.9, -1)
      }
      // Slam: the hull comes down hard: a burst of white along both sides.
      if (b.slams !== s.slams) {
        for (let i = 0; i < 28; i++) {
          const side = i % 2 ? 1 : -1
          const p = this.world(b, side * 2.8, 0.1, rnd(-6, 7))
          const out = rnd(3, 9)
          this.rock(p, vx * 0.45 - ch * side * out, rnd(3, 8), vz * 0.45 - sh * side * out, rnd(0.7, 1.2), rnd(0.4, 0.7), rnd(1.1, 1.8))
        }
        for (let i = 0; i < 6; i++) {
          const p = this.world(b, rnd(-2.5, 2.5) > 0 ? 3 : -3, 0.3, rnd(-6, 6))
          fx.spawn(1, p[0], p[1], p[2], p[0], p[1], p[2], vx * 0.4, rnd(2, 4), vz * 0.4, rnd(1, 1.6), 1, rnd(3, 5), SPRAY[0], SPRAY[1], SPRAY[2], 0.35, 0.9, -1)
        }
      }
    }
    s.slams = b.slams
    // Damage: grey smoke, then fire on the aft deck with black smoke.
    const st = sinking > 0 ? 2 : boatState(hp)
    if (st >= 1) {
      const p = this.world(b, 0, 3.2, -1.5)
      fx.damage(0x40000 + id, p[0], p[1], p[2], vx, 0, vz, st >= 2 ? 2 : 1)
      if (st >= 2) {
        const q = this.world(b, 0.6, 2.1, -5.5, this.q)
        fx.fire(q[0], q[1], q[2], vx, vz, 2.6, 9, 1)
      }
    }
  }

  /** Forgets boats not drawn for a while (their slam counters). */
  prune(): void {
    for (const [id, s] of this.seen) if (this.frame - s.t > 600) this.seen.delete(id)
  }

  /** The hull let go by the crane and meeting the water. */
  splash(b: ShipPoseLike): void {
    for (let i = 0; i < 30; i++) {
      const side = i % 2 ? 1 : -1
      const p = this.world(b, side * rnd(2, 2.9), 0, rnd(-8, 8))
      this.rock(p, -Math.cos(b.heading) * side * rnd(-2, -6), rnd(3, 7), -Math.sin(b.heading) * side * rnd(-2, -6), rnd(0.7, 1.2), rnd(0.4, 0.7), rnd(1, 1.7))
    }
    for (let i = 0; i < 6; i++) {
      const p = this.world(b, rnd(-3, 3), 0.5, rnd(-7, 7))
      this.wfx.spawn(1, p[0], p[1], p[2], p[0], p[1], p[2], 0, 2, 0, rnd(1.2, 1.8), 1.2, rnd(3.5, 5), SPRAY[0], SPRAY[1], SPRAY[2], 0.3, 0.8, -1)
    }
  }

  /** A faceted white spray chunk (weapon-fx's sea-spray particle), falling at 1 g. */
  private rock(p: Vec3, vx: number, vy: number, vz: number, life: number, s0: number, s1: number): void {
    this.wfx.spray(p[0], p[1], p[2], vx, vy, vz, life, s0, s1, rnd(1.1, 1.6))
  }

  /** A 25 mm round leaving the muzzle at `pos` along unit `dir`. */
  muzzle(pos: Vec3, dir: Vec3): void {
    this.wfx.muzzle(pos[0], pos[1], pos[2], dir[0], dir[1], dir[2])
  }

  /** A 25 mm tracer at its head (x, y, z), flying at v. */
  tracer(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    this.wfx.tracer(x, y, z, vx, vy, vz, 0.03)
  }

  /** Where a 25 mm round struck. */
  impact(kind: "sea" | "land" | "ship" | "jet" | "boat", x: number, y: number, z: number): void {
    this.wfx.impact(kind === "boat" ? "jet" : kind, x, y, z)
  }

  /** The boat destroyed: a fireball over the water. */
  explode(b: ShipPoseLike & { u: number; v: number }): void {
    const sh = Math.sin(b.heading)
    const ch = Math.cos(b.heading)
    const p = this.world(b, 0, 2, 0)
    this.wfx.explosion(p[0], p[1], p[2], (b.u * sh + b.v * ch) * 0.5, 2, (-b.u * ch + b.v * sh) * 0.5, 1.15, true, "car")
  }
}

