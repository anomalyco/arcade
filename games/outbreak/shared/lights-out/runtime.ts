import { distToRect } from "@arcade/kit/sim/geom"
import type { InteractAction, InteractionHandler, RawInteractCandidate } from "../interact"
import type { Lamp } from "../map"
import { buildingAt } from "../progression/loot"
import { ds } from "../radios/radios"
import type { OutbreakSim } from "../sim-types"
import { DEFAULT_LIGHTS_TUNING, lampDark, lampHeads, lampOnShot, lampStoreId, porchSwitch, type LightsTuning } from "./lights"

/**
 * Per-sim Lights Out state: each lamp's own power (a dark lamp's is set to 0 on the town, so `samplePointLightLevel`
 * and everything else that reads lamps sees it dark), the shots already looked at, and the tuning last stepped with.
 */
export type LightsState = { base: Record<string, number>; seenShots: number[]; tuning: LightsTuning }

export function createLightsState(): LightsState {
  return { base: {}, seenShots: [], tuning: DEFAULT_LIGHTS_TUNING }
}

export function lightsTuning(features: Readonly<Record<string, Record<string, unknown>>> | undefined): LightsTuning {
  return (features?.lights as LightsTuning | undefined) ?? DEFAULT_LIGHTS_TUNING
}

/**
 * Puts every dark lamp's power to 0 on the town (and gives a relit porch light its own back). Every tick: a restored or
 * forked sim, or a chunk streamed back, brings its lamps back lit, and a lamp is one map lookup.
 */
export function applyDarkLamps(sim: OutbreakSim, state: LightsState): void {
  const ledger = sim.progression.ledger
  for (const lamp of sim.town.lamps) {
    if (lamp.kind !== "street" && lamp.kind !== "porch") continue
    const id = lampStoreId(lamp)
    let base = state.base[id]
    if (base === undefined) state.base[id] = base = lamp.power
    lamp.power = lampDark(ledger.store(id)) ? 0 : base
  }
}

/** Shoots a lamp out: dark for good, its glass on the ground under it, and a pop the dead hear. */
export function breakLamp(sim: OutbreakSim, state: LightsState, lamp: Lamp, time: number): void {
  const ledger = sim.progression.ledger
  const id = lampStoreId(lamp)
  const head = lampHeads(lamp)[0]!
  let st = ledger.store(id)
  if (!st) st = ledger.createStore({ id, mode: "counters", scope: "shared", at: { x: lamp.x, y: lamp.y }, initial: { broken: 0, off: 0 } })
  if (st.counts.broken) return
  st.counts.broken = 1
  st.counts.t = ds(time)
  st.rev = ++ledger.rev
  // The glass lands on the pavement under the head, or on the porch step in front of the door.
  const glass = lamp.kind === "street" ? { x: head.x, y: head.y + 0.2 } : { x: lamp.x + 0.6, y: lamp.y }
  const gid = `glass:${id}`
  if (!ledger.store(gid)) ledger.createStore({ id: gid, mode: "counters", scope: "shared", at: { x: Number(glass.x.toFixed(2)), y: Number(glass.y.toFixed(2)) }, initial: { t: ds(time) } })
  sim.ai.emitNoise(head.x, head.y, state.tuning.lampPopNoise, "glass", time, "lamp", 1.2)
  applyDarkLamps(sim, state)
}

/** Once per tick: every new pistol shot that passes a lit lamp's glass before it hits anything puts that lamp out. */
export function stepLights(sim: OutbreakSim, state: LightsState): void {
  applyDarkLamps(sim, state)
  const shots = sim.combat.shots
  if (!shots.length && !state.seenShots.length) return
  const ledger = sim.progression.ledger
  for (const shot of shots) {
    if (state.seenShots.includes(shot.id)) continue
    const hit = lampOnShot(sim.town, shot.fromX, shot.fromY, shot.toX, shot.toY, state.tuning.lampHitRadius, (lamp) => Boolean(ledger.store(lampStoreId(lamp))?.counts.broken))
    if (hit) breakLamp(sim, state, hit.lamp, shot.time)
  }
  state.seenShots = shots.map((s) => s.id)
}

/** E at a porch light's switch, beside its front door: switch it off, or on again. A shot-out one offers nothing. */
export function porchSwitchHandler(sim: OutbreakSim, id: string): InteractionHandler {
  const of = () => sim.getFeatureState<LightsState>(id)
  const near = (actor: { x: number; y: number }, lamp: Lamp) => lamp.kind === "porch" && Math.abs(lamp.x - actor.x) < 3 && Math.abs(lamp.y - actor.y) < 3
  return {
    kind: "lamp",
    candidates: (town, actor) => {
      if (actor.peekingWindowId || !of()) return []
      // The switch is outside, on the step: from indoors the front door is what a survivor is reaching for.
      if (buildingAt(town, actor.x, actor.y)) return []
      const out: RawInteractCandidate[] = []
      for (const lamp of town.lamps) {
        if (!near(actor, lamp)) continue
        const sw = porchSwitch(lamp)
        if (distToRect(actor.x, actor.y, sw.rect) > 0.9) continue
        const st = sim.progression.ledger.store(lampStoreId(lamp))
        if (st?.counts.broken) continue
        const off = Boolean(st?.counts.off)
        const primary: InteractAction = { id: "toggle", label: off ? "Switch on" : "Switch off" }
        // Right beside the front door: it takes the prompt only when the survivor faces it, else the door keeps it.
        const facing = Math.cos(actor.aim - Math.atan2(sw.y - actor.y, sw.x - actor.x))
        out.push({ kind: "lamp", id: lampStoreId(lamp), label: "Porch light", rect: sw.rect, worldX: sw.x, worldY: sw.y, primary, actions: [primary], priority: facing > 0.3 ? 0.5 : -1.5 })
      }
      return out
    },
    execute: (town, actor, targetId, action) => {
      const state = of()
      const lamp = town.lamps.find((l) => l.kind === "porch" && lampStoreId(l) === targetId)
      if (!state || !lamp || action !== "toggle" || distToRect(actor.x, actor.y, porchSwitch(lamp).rect) > 1.4) return { handled: false }
      const ledger = sim.progression.ledger
      let st = ledger.store(targetId)
      if (st?.counts.broken) return { handled: false }
      if (!st) st = ledger.createStore({ id: targetId, mode: "counters", scope: "shared", at: { x: lamp.x, y: lamp.y }, initial: { broken: 0, off: 0 } })
      st.counts.off = st.counts.off ? 0 : 1
      st.rev = ++ledger.rev
      applyDarkLamps(sim, state)
      return { handled: true, kind: "lamp", targetId, action, noise: 1.2, noiseKind: "switch" }
    },
  }
}
