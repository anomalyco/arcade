import { DT } from "../../shared/config"
import type { City } from "../../shared/sim/city"
import type { Input } from "../../shared/sim/vehicle"
import { type Participant, type SimEvent, World, type WorldView } from "../../shared/sim/world"
import { BOT_NAMES } from "../../shared/names"
import { lerpView } from "./interp"

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

  constructor(name: string, picks: Participant["picks"], seed = 7) {
    this.participants = [{ id: this.myId, name, human: true, picks }]
    for (let i = 0; i < 4; i++) this.participants.push({ id: `bot${i}`, name: BOT_NAMES[i]!, human: false, picks: { robber: i % 2 ? "compact" : "muscle", cop: i === 1 ? "interceptor" : "cruiser" } })
    this.world = new World(seed, this.participants)
    this.curr = this.world.view(this.myId)
    this.prev = this.curr
  }

  get city() {
    return this.world.city
  }

  update(dt: number, input: Input) {
    this.world.setInput(this.myId, input)
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
