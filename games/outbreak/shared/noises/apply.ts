import { dayCycle } from "../day-cycle"
import { openingThreat } from "../pacing"
import type { OutbreakSim } from "../sim-types"
import type { NoisesSnapshot } from "./types"

/** The room's noise bus keeps 64; a client's copy keeps as many. */
const CLIENT_BUS_CAP = 64

/**
 * Writes a snapshot's new noises into a client sim's noise bus, as the room made them (same ids, so each becomes one
 * cue), with each survivor's noise under that survivor's id here. Returns the newest id applied, to pass back next
 * time: a resent noise is never added twice.
 */
export function applyNetNoises(sim: OutbreakSim, snap: NoisesSnapshot | undefined, appliedUpTo: number): number {
  if (!snap) return appliedUpTo
  const bus = sim.ai.noiseBus.events
  let upTo = appliedUpTo
  for (const n of snap.events) {
    if (n.id <= upTo) continue
    upTo = n.id
    const sourceId = n.seat >= 0 ? (sim.slots.find((s) => s.index === n.seat)?.id ?? `seat:${n.seat}`) : n.sourceId
    bus.push({ id: n.id, x: n.x, y: n.y, radius: n.radius, loudness: n.loudness, kind: n.kind, sourceId, time: n.time, ttl: n.ttl })
  }
  if (bus.length > CLIENT_BUS_CAP) bus.splice(0, bus.length - CLIENT_BUS_CAP)
  return upTo
}

/**
 * A client's frame: forget noises whose time is up, as the room's bus does, and keep the crowd's threat (how far
 * the dead hear, by the hour) at the room's, since the client never steps the crowd.
 */
export function syncClientHearing(sim: OutbreakSim): void {
  sim.ai.noiseBus.prune(sim.time)
  sim.ai.threat = openingThreat(dayCycle(sim.hour).threat, sim.time, sim.ai.config)
}
