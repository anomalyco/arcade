import { inInterestBubble } from "@arcade/kit/net/interest"
import type { NoiseEvent, NoiseKind } from "../ai"
import type { OutbreakNetSectionCodec } from "../feature-registry"
import type { OutbreakSim } from "../sim-types"
import type { NetNoise, NoisesSnapshot } from "./types"

export type { NetNoise, NoisesSnapshot } from "./types"

/** The noise section's bit in the snapshot header (64 vehicles, 128 melee, 256 death). */
export const SEC_NOISES = 512

/** Most noises one snapshot carries (the room's bus holds 64); the newest win. */
export const MAX_NET_NOISES = 24

/** Footsteps are continuous and coalesced in place on the bus; teammates' draw nothing, your own come from `personal`. */
const CONTINUOUS: ReadonlySet<string> = new Set(["footstep", "sprint"])

/** Every kind a noise can have, by wire index. Append only: the index is on the wire. */
const KINDS: readonly NoiseKind[] = [
  "gunshot", "glass", "bash", "vault", "shove", "door", "window", "search", "barricade", "groan", "alarm", "radio",
  "lure", "generator", "flare", "fuse", "explosion", "firecracker", "flamethrower", "trap", "crash", "horn", "bark",
  "shriek", "bloater", "cans", "reload", "engine", "footstep", "sprint", "thud",
]
const KIND_INDEX = new Map<string, number>(KINDS.map((k, i) => [k, i]))
const KIND_STRING = 255

const cm = (v: number) => Math.round(v * 100)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const fiftieths = (v: number) => Math.round(clamp(v, 0, 5.1) * 50)

/** Whether a noise made at (x, y) can matter to anyone in the bubble: the overlay draws arrows to 1.5× reach + 8 m. */
function audibleInBubble(n: NoiseEvent, cx: number, cy: number, halfExtent: number): boolean {
  return inInterestBubble(n.x, n.y, cx, cy, halfExtent + n.radius * 1.5 + 8)
}

function quantise(sim: OutbreakSim, n: NoiseEvent): NetNoise {
  const ageMs = clamp(Math.round((sim.time - n.time) * 1000), 0, 65535)
  const seat = sim.slots.find((s) => s.id === n.sourceId)?.index ?? -1
  return {
    id: n.id,
    time: Number((Math.fround(sim.time) - ageMs / 1000).toFixed(4)),
    kind: n.kind,
    x: cm(n.x) / 100,
    y: cm(n.y) / 100,
    radius: cm(n.radius) / 100,
    loudness: fiftieths(n.loudness) / 50,
    ttl: fiftieths(n.ttl) / 50,
    seat,
    sourceId: seat >= 0 ? "" : n.sourceId,
  }
}

/**
 * The noises the dead hear (`sim.ai.noiseBus`), so co-op clients draw the same sound cues, fog ripples and crow
 * scatters as the room: each noise once (a delta carries only ids past its base's `upTo`), footsteps never, only
 * those near enough the recipient's bubble to be heard, at most `MAX_NET_NOISES` a snapshot. Quiet: omitted when
 * nothing new was made, ~18 bytes per noise otherwise.
 */
export const noisesNetSection: OutbreakNetSectionCodec<undefined, NoisesSnapshot, NetNoise[]> = {
  bit: SEC_NOISES,
  key: "noises",
  collect: ({ sim, isDelta, baseSnap, viewerCenter, interest, bubbleCx, bubbleCy }) => {
    const bus = sim.ai.noiseBus.events
    const base = isDelta ? (baseSnap?.noises as NoisesSnapshot | undefined)?.upTo ?? 0 : 0
    let upTo = base
    const events: NetNoise[] = []
    for (const n of bus) {
      upTo = Math.max(upTo, n.id)
      if (n.id <= base || CONTINUOUS.has(n.kind)) continue
      if (viewerCenter && !audibleInBubble(n, bubbleCx, bubbleCy, interest.bubbleHalfExtent)) continue
      events.push(quantise(sim, n))
    }
    if (events.length > MAX_NET_NOISES) events.splice(0, events.length - MAX_NET_NOISES)
    return { snapshotValue: { upTo, events }, shouldWrite: events.length > 0, writePayload: events }
  },
  encode: (w, events, { sim }) => {
    const timeF32 = Math.fround(sim.time)
    w.u8(events.length)
    for (const n of events) {
      w.uvar(n.id)
      w.u16(clamp(Math.round((timeF32 - n.time) * 1000), 0, 65535))
      const k = KIND_INDEX.get(n.kind) ?? KIND_STRING
      w.u8(k)
      if (k === KIND_STRING) w.str(n.kind)
      w.i32(cm(n.x)).i32(cm(n.y))
      w.uvar(cm(n.radius))
      w.u8(fiftieths(n.loudness))
      w.u8(fiftieths(n.ttl))
      w.u8(n.seat >= 0 ? n.seat + 1 : 0)
      if (n.seat < 0) w.str(n.sourceId)
    }
  },
  decode: (r, { time }) => {
    const events: NetNoise[] = []
    let upTo = 0
    for (let count = r.u8(), i = 0; i < count; i++) {
      const id = r.uvar()
      const ageMs = r.u16()
      const k = r.u8()
      const kind = k === KIND_STRING ? r.str() : (KINDS[k] ?? "bash")
      const x = r.i32() / 100
      const y = r.i32() / 100
      const radius = r.uvar() / 100
      const loudness = r.u8() / 50
      const ttl = r.u8() / 50
      const seat = r.u8() - 1
      const sourceId = seat < 0 ? r.str() : ""
      upTo = Math.max(upTo, id)
      events.push({ id, time: Number((time - ageMs / 1000).toFixed(4)), kind, x, y, radius, loudness, ttl, seat, sourceId })
    }
    return { upTo, events }
  },
  // Events, not state: a delta without the section has no new noises (the base's were applied when they came).
  decodeOmitted: () => undefined,
}
