import { DT, VEHICLE_BY_ID } from "../../shared/config"
import { mulberry32 } from "../../shared/sim/rng"
import type { City } from "../../shared/sim/city"
import type { Input } from "../../shared/sim/vehicle"
import { type Participant, type SimEvent, World, type WorldView } from "../../shared/sim/world"
import type { ChatMsg } from "../../shared/protocol"
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
  /** Online only: seconds until an idle kick while the warning is up. */
  idleIn?(): number | null
  /** Online only: why the server removed us for good (an idle kick), once it has. */
  kicked?(): string | null
  /** Online only: send a chat line, and take the lines received since the last call. */
  chat?(text: string): void
  drainChat?(): ChatMsg[]
}

/** Solo practice: the full simulation runs in the browser with bot cops. */
export class LocalSession implements Session {
  readonly myId = "me"
  readonly room = null
  readonly world: World
  private acc = 0
  private participants: Participant[]
  private prev: WorldView
  private curr: WorldView
  private frozen = false
  private freezeAt = -1
  private stageInput: Input | null = null
  readonly peaceful: boolean
  private following = false

  constructor(name: string, picks: Participant["picks"], seed = 7) {
    const q = new URLSearchParams(location.search)
    const requestedSeed = Number(q.get("seed"))
    if (q.has("seed") && Number.isFinite(requestedSeed)) seed = requestedSeed >>> 0
    this.peaceful = q.get("peaceful") === "1"
    if (this.peaceful) Math.random = mulberry32(seed)
    this.participants = [{ id: this.myId, name, human: true, picks }]
    if (!this.peaceful) for (let i = 0; i < 4; i++) this.participants.push({ id: `bot${i}`, name: BOT_NAMES[i]!, human: false, picks: { robber: i % 2 ? "compact" : "muscle", cop: i === 1 ? "interceptor" : "cruiser" } })
    this.world = new World(seed, this.participants)
    if (this.peaceful) {
      // Waiting advances driving/collisions, but never runs pursuit, reinforcement or round-end rules.
      this.world.phase = "waiting"
      this.world.robberId = this.myId
      this.world.heli.active = false
      const car = this.world.carOf(this.myId)!
      car.role = "robber"
      car.vehicle = VEHICLE_BY_ID.get(picks.robber)!
      Object.assign(car.body, { x: this.world.site.x, z: this.world.site.z - 10, h: 0 })
    }
    this.curr = this.snapshot()
    this.prev = this.curr
    if (import.meta.env.DEV) {
      ;(globalThis as unknown as { __world: World }).__world = this.world
      const stage = q.get("stage")
      if (stage && !this.peaceful) {
        applyStage(this.world, stage)
        this.curr = this.prev = this.world.view(this.myId)
      }
      // freeze=<seconds>: play scripted input for that long, then stop the sim (smoke and skids get to trail).
      const f = q.get("freeze")
      if (f !== null) this.freezeAt = Number(f) || 0
      if (stage && !this.peaceful) this.stageInput = stage.startsWith("spike") ? { throttle: 1, brake: 0, steer: 0, handbrake: false, boost: false } : { throttle: 1, brake: 0, steer: 0.55, handbrake: true, boost: false }
    }
  }

  get city() {
    return this.world.city
  }

  update(dt: number, input: Input) {
    if (this.following) return this.curr
    if (this.freezeAt >= 0 && this.world.t - 45 >= this.freezeAt) this.frozen = true
    if (this.frozen) return this.curr
    this.world.setInput(this.myId, this.stageInput ?? input)
    this.acc = Math.min(this.acc + dt, 0.25)
    while (this.acc >= DT) {
      this.world.step(DT)
      this.acc -= DT
      this.prev = this.curr
      this.curr = this.snapshot()
    }
    return lerpView(this.prev, this.curr, this.acc / DT)
  }

  private snapshot() {
    const view = this.world.view(this.myId)
    // Free driving uses the chase HUD without enabling any chase rules in the simulation.
    if (this.peaceful) Object.assign(view, { phase: "chase", phaseT: this.world.t, survived: this.world.t })
    return view
  }

  /** A comparison follower presents the authority's exact tick, including lighting time and vehicle state. */
  syncView(view: WorldView) {
    const mine = view.cars.find((c) => c.ownerId === this.myId)
    const car = this.world.carOf(this.myId)
    if (mine && car) Object.assign(car.body, { x: mine.x, z: mine.z, vx: mine.vx, vz: mine.vz, h: mine.h, yaw: mine.yaw })
    this.world.t = view.t
    this.acc = 0
    this.following = true
    this.curr = this.prev = view
  }

  /** The comparison's BEFORE follows the authoritative AFTER pose instead of integrating it twice. */
  syncCar(pose: { x: number; z: number; vx: number; vz: number; h: number; yaw: number; speed: number }) {
    if (!Object.values(pose).every(Number.isFinite)) return
    const car = this.world.carOf(this.myId)
    if (!car) return
    const { x, z, vx, vz, h, yaw, speed } = pose
    Object.assign(car.body, { x, z, vx, vz, h, yaw })
    this.following = true
    this.acc = 0
    this.curr = this.prev = this.snapshot()
    const mine = this.curr.cars.find((c) => c.ownerId === this.myId)
    if (mine) mine.speed = speed
  }

  drainEvents() {
    return this.world.drainEvents().filter((e) => e.to === undefined || e.to === this.myId)
  }

  players() {
    return this.participants.map((p) => ({ id: p.id, name: p.name, human: p.human }))
  }

  close() {}

  status() {
    return "solo"
  }

  syncBench() {
    this.stageInput = null
    this.acc = 0
    this.frozen = false
    this.following = false
    this.curr = this.prev = this.snapshot()
  }
}
