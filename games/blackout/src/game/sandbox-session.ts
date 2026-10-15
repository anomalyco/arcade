import { DT, type Equip, type Gun } from "../../shared/config"
import { getMap } from "../../shared/maps"
import type { ClientMsg } from "../../shared/protocol"
import { gunKit } from "../../shared/sim/kit"
import type { ModeId } from "../../shared/sim/modes"
import { spellConfig } from "../../shared/sim/spell-config"
import { buildSnapshot, rosterOf, type RosterRow, type Snapshot } from "../../shared/sim/view"
import { NO_INTENT, World, type Brain, type SimEvent } from "../../shared/sim/world"
import type { MuxState } from "./input"
import type { Session } from "./session"

/** Local-only sandbox controls belong here rather than in the multiplayer simulation. */
export class SandboxSession implements Session {
  readonly room = null
  readonly myId = "you"
  readonly world: World
  passive = true
  private acc = 0
  private events: SimEvent[] = []
  private brains = new Map<string, Brain>()
  private dummySpawns = new Map<string, { x: number; y: number; aim: number }>()
  private snapshot!: { snap: Snapshot; at: number }

  constructor(name: string, gun: Gun, equip: Equip, seed: number, mode: ModeId = "ffa") {
    this.world = new World(seed, getMap("office", seed), mode)
    this.world.botFill = 4
    this.world.addHuman(this.myId, name, gun, equip)
    this.world.fill()
    for (const p of this.world.players.values()) if (p.brain) {
      this.brains.set(p.id, p.brain)
      this.dummySpawns.set(p.id, { x: p.x, y: p.y, aim: p.aim })
      p.brain = { think: () => ({ ...NO_INTENT, aim: p.aim }) }
    }
    this.publish()
  }

  toggleBots(): void {
    this.passive = !this.passive
    for (const [id, brain] of this.brains) {
      const p = this.world.players.get(id)
      if (!p) continue
      p.vx = p.vy = 0
      p.brain = this.passive ? { think: () => ({ ...NO_INTENT, aim: p.aim }) } : brain
    }
  }

  sync(state: MuxState): void {
    const p = this.world.players.get(this.myId)
    if (p) Object.assign(p, { x: state.x, y: state.y, vx: state.vx, vy: state.vy, aim: state.aim })
    this.publish()
  }

  latest() { return this.snapshot }
  roster(): RosterRow[] { return rosterOf(this.world) }
  drainEvents(): SimEvent[] { const e = this.events; this.events = []; return e }
  status(): string { return this.passive ? "PASSIVE DUMMIES · B" : "LIVE BOTS · B" }
  close(): void {}

  send(msg: ClientMsg): void {
    if (msg.type === "spells" && this.world.spells) this.world.spells.config = spellConfig(msg.config)
    if (this.world.spells && (msg.type === "gun" || msg.type === "equip")) return
    if (msg.type === "intent") this.world.push(this.myId, msg.seq, { ...msg.i, reload: false })
    if (msg.type === "gun") {
      this.world.pickGun(this.myId, msg.gun)
      const p = this.world.players.get(this.myId)
      if (p) this.world.arm(p, gunKit(msg.gun))
      this.publish()
    }
    if (msg.type === "equip") {
      const p = this.world.players.get(this.myId)
      if (p) { p.equip = p.equipPick = msg.equip; p.equipLeft = 99 }
    }
  }

  update(dt: number): void {
    this.acc = Math.min(this.acc + dt, DT * 6)
    while (this.acc >= DT) {
      this.acc -= DT
      this.world.phaseEnd = this.world.time + 3600
      const me = this.world.players.get(this.myId)!
      me.mag = me.kit.mag
      me.reloadUntil = 0
      if (!this.world.spells) me.equipLeft = 99
      this.world.step()
      if (this.passive && !this.world.spells) for (const [id, spawn] of this.dummySpawns) {
        const p = this.world.players.get(id)
        if (p?.alive) Object.assign(p, spawn, { vx: 0, vy: 0 })
      }
      const events = this.world.takeEvents()
      for (const e of events) if (e.k === "kill") {
        const victim = this.world.players.get(e.victim)
        if (victim) victim.respawnAt = this.world.time + 2
      }
      this.events.push(...events)
    }
    this.publish()
  }

  private publish(): void { this.snapshot = { snap: buildSnapshot(this.world, this.myId), at: performance.now() } }
}
