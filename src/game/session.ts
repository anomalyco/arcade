import { DT } from "../../shared/config"
import type { City } from "../../shared/sim/city"
import type { Input } from "../../shared/sim/vehicle"
import { type Participant, type SimEvent, World, type WorldView } from "../../shared/sim/world"
import { BOT_NAMES } from "../../shared/names"
import { lerpView } from "./interp"
import { applyStage } from "./stage"

export interface Session {
  readonly myId: string
  readonly city: City
  readonly room: string | null
  /** Advances time and returns the view to render this frame. */
  update(dt: number, input: Input): WorldView
  drainEvents(): SimEvent[]
  players(): { id: string; name: string; human: boolean }[]
  close(): void
  status(): string
}

/** Solo practice: the full simulation runs in the browser with bot cops. */
export class LocalSession implements Session {
  readonly myId = "me"
  readonly room = null
  private world: World
  private acc = 0
  private participants: Participant[]
  private prev: WorldView
  private curr: WorldView
  private frozen = false
  private freezeAt = -1
  private stageInput: Input | null = null

  constructor(name: string, picks: Participant["picks"], seed = 7) {
    this.participants = [{ id: this.myId, name, human: true, picks }]
    for (let i = 0; i < 4; i++) this.participants.push({ id: `bot${i}`, name: BOT_NAMES[i]!, human: false, picks: { robber: i % 2 ? "compact" : "muscle", cop: i === 1 ? "interceptor" : "cruiser" } })
    this.world = new World(seed, this.participants)
    this.curr = this.world.view(this.myId)
    this.prev = this.curr
    if (import.meta.env.DEV) {
      ;(globalThis as unknown as { __world: World }).__world = this.world
      const q = new URLSearchParams(location.search)
      const stage = q.get("stage")
      if (stage) {
        applyStage(this.world, stage)
        this.curr = this.prev = this.world.view(this.myId)
      }
      // freeze=<seconds>: play scripted input for that long, then stop the sim (smoke and skids get to trail).
      const f = q.get("freeze")
      if (f !== null) this.freezeAt = Number(f) || 0
      if (stage) this.stageInput = { throttle: 1, brake: 0, steer: 0.55, handbrake: true, boost: false }
    }
  }

  get city() {
    return this.world.city
  }

  update(dt: number, input: Input) {
    if (this.freezeAt >= 0 && this.world.t - 45 >= this.freezeAt) this.frozen = true
    if (this.frozen) return this.curr
    this.world.setInput(this.myId, this.stageInput ?? input)
    this.acc = Math.min(this.acc + dt, 0.25)
    while (this.acc >= DT) {
      this.world.step(DT)
      this.acc -= DT
      this.prev = this.curr
      this.curr = this.world.view(this.myId)
    }
    return lerpView(this.prev, this.curr, this.acc / DT)
  }

  drainEvents() {
    return this.world.drainEvents()
  }

  players() {
    return this.participants.map((p) => ({ id: p.id, name: p.name, human: p.human }))
  }

  close() {}

  status() {
    return "solo"
  }
}
