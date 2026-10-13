import { BOW_Z, DECK_Y, ISLAND, STERN_Z } from "../../shared/carrier-spec"
import { FLEET, type Hull, fireLit } from "../../shared/fleet"
import { shipToWorld, type ShipPoseLike, type Vec3 } from "../../shared/plane"
import type { WeaponAudio } from "../audio/weapon-audio"
import type { WeaponFx } from "../render/weapon-fx"

/** A carrier as drawn (settled), with its id; `u` its speed and heading for the fires to move with it. */
export type FxShip = ShipPoseLike & { id: number; u: number }

const at: Vec3 = [0, 0, 0]
const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo)

/**
 * Damaged carriers, drawn from their hulls (shared/fleet.ts) every frame in ship-local space, so everything rides the
 * hull: the fires where bombs and missiles struck (bigger and blacker as health falls), a black smoke column from the
 * island once badly hurt, a wide deck fire while the deck is closed, and the sinking: explosions along the hull,
 * everything burning, steam and spray at the waterline as it goes down.
 */
export class ShipFx {
  /** When the next sinking explosion goes off, by ship id (presentation clock). */
  private next = new Map<number, number>()
  private time = 0

  constructor(
    private fx: WeaponFx,
    private audio: WeaponAudio,
    private ear: () => ArrayLike<number>,
  ) {}

  draw(dt: number, t: number, ships: readonly FxShip[], hulls: ReadonlyMap<number, Hull> | null): void {
    this.time += dt
    if (!hulls) return
    for (const s of ships) {
      const h = hulls.get(s.id)
      if (!h) continue
      const lost = 1 - h.hp / FLEET.hp
      const sinking = h.sinkAt !== -1
      if (lost <= 0.001 && !h.fires.length && !sinking) continue
      const vx = Math.sin(s.heading) * s.u
      const vz = -Math.cos(s.heading) * s.u
      // Fires at the hits: taller and blacker as the ship weakens.
      for (const f of h.fires) {
        if (!fireLit(h, f, t)) continue
        const p = shipToWorld(s, f.x, f.y, f.z, at)
        this.fx.fire(p[0], p[1], p[2], vx, vz, 5 + 9 * lost + (sinking ? 6 : 0), 3 + 4 * lost, 0.6 + 0.4 * lost)
      }
      // A closed deck burns across the runway.
      if (!sinking && t < h.deckFire && h.fires.length) {
        const f = h.fires[h.fires.length - 1]!
        for (const dz of [-12, 12]) {
          const p = shipToWorld(s, f.x + rnd(-6, 6), DECK_Y, f.z + dz, at)
          this.fx.fire(p[0], p[1], p[2], vx, vz, 4, 1.5, 0.8)
        }
      }
      // Badly hurt: a black column from the island.
      if (lost > 0.5 || sinking) {
        const p = shipToWorld(s, (ISLAND.x0 + ISLAND.x1) / 2, ISLAND.y1 - 6, (ISLAND.z0 + ISLAND.z1) / 2, at)
        this.fx.fire(p[0], p[1], p[2], vx, vz, 0, 4 + 6 * lost, 1)
      }
      if (sinking) this.sinking(s, h, t, vx, vz)
    }
  }

  /** Explosions walking along the hull, fire everywhere, and spray where the sea closes over it. */
  private sinking(s: FxShip, h: Hull, t: number, vx: number, vz: number): void {
    const u = h.sinkAt < 0 ? 1 : Math.min(1, (t - h.sinkAt) / FLEET.sinkTime)
    const due = this.next.get(s.id) ?? 0
    if (this.time >= due && u < 0.8) {
      this.next.set(s.id, this.time + rnd(0.5, 1.6) * (u < 0.15 ? 0.5 : 1))
      const z = rnd(STERN_Z + 20, BOW_Z - 20)
      const p = shipToWorld(s, rnd(-25, 25), rnd(DECK_Y - 12, DECK_Y + 2), z, at)
      this.fx.explosion(p[0], p[1], p[2], vx, 0, vz, rnd(1.2, 2.2), false)
      const e = this.ear()
      this.audio.explosion(Math.hypot(p[0] - e[0]!, p[1] - e[1]!, p[2] - e[2]!), 1.6, "bomb-land")
    } else if (!this.next.has(s.id)) this.next.set(s.id, this.time)
    // Fires along the deck.
    for (let i = 0; i < 4; i++) {
      const p = shipToWorld(s, -20 + i * 14, DECK_Y, STERN_Z + 40 + i * 70, at)
      if (p[1] > -2) this.fx.fire(p[0], p[1], p[2], vx, vz, 10, 3, 1)
    }
    // Where the bow (going under first) meets the sea: spray and steam.
    if (u > 0.3) {
      const p = shipToWorld(s, rnd(-25, 25), DECK_Y, rnd(0, BOW_Z), at)
      if (Math.abs(p[1]) < 8 && Math.random() < 0.3) this.fx.splash(p[0], 0, p[2], 0.8)
    }
  }

  forget(id: number): void {
    this.next.delete(id)
  }
}
