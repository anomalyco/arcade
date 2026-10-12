import { DT } from "../../shared/config"
import type { Rect } from "../../shared/geom"
import { stepBody } from "../../shared/sim/move"
import type { Intent } from "../../shared/sim/world"
import type { YouView } from "../../shared/sim/view"

type Body = { x: number; y: number; vx: number; vy: number }

/**
 * Client-side prediction for the local body. Each tick the same movement code the server runs is applied immediately.
 * When a snapshot arrives the body snaps to the server's state and the intents the server hasn't acknowledged are replayed.
 */
export class Predictor {
  body: Body | null = null
  private seq = 0
  private pending: { seq: number; i: Intent }[] = []
  private lastStance: Intent["stance"] = "walk"

  reset(): void {
    this.body = null
    this.pending = []
  }

  /** Advances one tick. Returns the intent to send. */
  step(i: Intent, walls: readonly Rect[]): { seq: number; i: Intent } {
    const seq = ++this.seq
    this.pending.push({ seq, i })
    if (this.pending.length > 64) this.pending.splice(0, this.pending.length - 64)
    if (this.body) stepBody(this.body, i.mx, i.my, i.stance, walls, DT)
    this.lastStance = i.stance
    return { seq, i }
  }

  /** Adopts the server's body for the local player and replays the intents it hasn't processed yet. */
  reconcile(you: YouView, ack: number, walls: readonly Rect[]): void {
    this.pending = this.pending.filter((p) => p.seq > ack)
    const body: Body = { x: you.x, y: you.y, vx: you.vx, vy: you.vy }
    if (you.alive) for (const p of this.pending) stepBody(body, p.i.mx, p.i.my, p.i.stance, walls, DT)
    this.body = body
  }

  get stance(): Intent["stance"] {
    return this.lastStance
  }
}
