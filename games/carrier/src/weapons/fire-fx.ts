import { type Plane, quatRotate, type Vec3 } from "../../shared/plane"
import type { WeaponFx } from "../render/weapon-fx"

/** Body-frame point (from the jet's centre) where spent casings leave: under the gun, aft of the muzzle. */
const CASING_PORT: Vec3 = [0.3, 0.1, 6.4]

const rot = (p: Plane, x: number, y: number, z: number, out: Vec3): Vec3 => quatRotate(p.qx, p.qy, p.qz, p.qw, x, y, z, out)

/**
 * Your own jet's firing feel in the world: brass glints tumbling down from the casing port while the gun fires, and a
 * brief glare at the rail as a missile's motor lights. Cheap additive sprites on the weapon effects' pool.
 */
export class FireFx {
  private owed = 0
  private glare = 0
  private rail: Vec3 = [0, 0, 0]
  private a: Vec3 = [0, 0, 0]
  private b: Vec3 = [0, 0, 0]

  /** Rounds fired this step: about one glint for every three. */
  rounds(n: number): void {
    this.owed += n / 3
  }

  /** A missile left the rail at body point `r`. */
  missile(r: readonly number[]): void {
    this.rail[0] = r[0]!
    this.rail[1] = r[1]!
    this.rail[2] = r[2]!
    this.glare = 1
  }

  draw(fx: WeaponFx, p: Plane, dt: number): void {
    const port = rot(p, CASING_PORT[0], CASING_PORT[1], CASING_PORT[2], this.a)
    const down = rot(p, 0, -1, 0, this.b)
    while (this.owed >= 1) {
      this.owed -= 1
      const s = 6 + Math.random() * 5
      const side = (Math.random() - 0.5) * 6
      // Thrown down out of the port, then left behind by the airflow (drag) and falling.
      const vx = p.vx + down[0] * s + side
      const vy = p.vy + down[1] * s
      const vz = p.vz + down[2] * s + side
      const x = p.x + port[0]
      const y = p.y + port[1]
      const z = p.z + port[2]
      fx.spawn(0, x, y, z, x, y, z, vx, vy, vz, 0.45 + Math.random() * 0.35, 0.07, 0.05, 7, 5, 2, 1, 2.5, -9.81)
    }
    if (this.glare > 0) {
      const r = rot(p, this.rail[0], this.rail[1], this.rail[2] - 2, this.a)
      const k = this.glare * this.glare
      fx.glowAt(p.x + r[0] + p.vx * dt, p.y + r[1] + p.vy * dt, p.z + r[2] + p.vz * dt, 2.5 + 3.5 * k, 14 * k, 9 * k, 4.5 * k, k)
      this.glare = Math.max(0, this.glare - dt / 0.28)
    }
  }
}
