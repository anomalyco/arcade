import { pushOut } from "@arcade/kit/sim/geom"
import { advanceHour } from "./day-cycle"
import { makeTown, SIZE, solidRects, toggleDoor, type Town } from "./map"

export type Command = { mx: number; my: number; aim: number; interact: boolean }
export type Survivor = { x: number; y: number; vx: number; vy: number; aim: number }
export type SessionView = { town: Town; player: Survivor; hour: number; time: number; revision: number }
/** Transport boundary: M4 can implement the same update/view contract with snapshots. */
export interface Session { readonly view: SessionView; update(dt: number, command: Command, timeScale: number): void; close(): void }

export class LocalSession implements Session {
  readonly view: SessionView
  private solids
  constructor(seed: number) {
    const town = makeTown(seed)
    this.view = { town, player: { x: 27.7, y: 41, vx: 0, vy: 0, aim: -Math.PI / 2 }, hour: 18, time: 0, revision: 0 }
    this.solids = solidRects(town)
  }
  update(dt: number, command: Command, timeScale: number): void {
    const view = this.view, p = view.player
    dt = Math.max(0, Math.min(.1, dt))
    p.aim = command.aim
    if (command.interact && toggleDoor(view.town, p.x, p.y)) { view.revision++; this.solids = solidRects(view.town) }
    const length = Math.max(1, Math.hypot(command.mx, command.my))
    const x = p.x, y = p.y
    const steps = Math.max(1, Math.ceil(dt * 60))
    for (let i = 0; i < steps; i++) {
      p.x += command.mx / length * 3.4 * dt / steps
      p.y += command.my / length * 3.4 * dt / steps
      pushOut(p, .3, this.solids)
      p.x = Math.max(.4, Math.min(SIZE - .4, p.x)); p.y = Math.max(.4, Math.min(SIZE - .4, p.y))
    }
    p.vx = dt > 0 ? (p.x - x) / dt : 0; p.vy = dt > 0 ? (p.y - y) / dt : 0
    view.time += dt
    view.hour = advanceHour(view.hour, dt, timeScale)
  }
  close(): void {}
}
