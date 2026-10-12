// Client-side terrain replay.
//
// Contract: start from the volley's `before` mask and apply terrain operations in
// order of *effect time*:
//   carve / fill  -> at ev.t
//   chunk remove  -> at ev.t
//   chunk land    -> at ev.t + ev.dur
// Ties are broken by the event's index in `result.events` (a landing therefore runs
// before any carve/fill/chunk emitted at the same timestamp, because its chunk event
// was emitted earlier). `terrainTimeline` produces exactly that order; applying it
// yields the volley's post-volley mask bit for bit.
import { WORLD_H, WORLD_W, carveCircle, fillRect, unpackBits, type Mask } from "./terrain"
import type { SimEvent } from "./protocol"

export type ChunkEvent = Extract<SimEvent, { type: "chunk" }>
export type CarveEvent = Extract<SimEvent, { type: "carve" }>
export type FillEvent = Extract<SimEvent, { type: "fill" }>

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export type TerrainOp =
  | { at: number; op: "carve"; ev: CarveEvent }
  | { at: number; op: "fill"; ev: FillEvent }
  | { at: number; op: "remove"; ev: ChunkEvent }
  | { at: number; op: "land"; ev: ChunkEvent }

function clip(x0: number, y0: number, x1: number, y1: number): Rect | null {
  const r = { x0: Math.max(0, Math.floor(x0)), y0: Math.max(0, Math.floor(y0)), x1: Math.min(WORLD_W - 1, Math.ceil(x1)), y1: Math.min(WORLD_H - 1, Math.ceil(y1)) }
  if (r.x1 < r.x0 || r.y1 < r.y0) return null
  return r
}

// carve/fill; returns the touched world rect (inclusive) or null for other events
export function applyTerrainEvent(mask: Mask, ev: SimEvent): Rect | null {
  if (ev.type === "carve") {
    carveCircle(mask, ev.x, ev.y, ev.r)
    return clip(ev.x - ev.r, ev.y - ev.r, ev.x + ev.r, ev.y + ev.r)
  }
  if (ev.type === "fill") {
    fillRect(mask, ev.x0, ev.y0, ev.x1, ev.y1)
    return clip(ev.x0, ev.y0, ev.x1, ev.y1)
  }
  return null
}

const cache = new WeakMap<ChunkEvent, Uint8Array>()

// w*h local bits, 1 = solid
export function decodeChunk(ev: ChunkEvent): Uint8Array {
  let bits = cache.get(ev)
  if (!bits) {
    bits = unpackBits(ev.bits, ev.w * ev.h)
    cache.set(ev, bits)
  }
  return bits
}

function stamp(mask: Mask, ev: ChunkEvent, offset: number, value: 0 | 1): Rect | null {
  const bits = decodeChunk(ev)
  for (let ly = 0; ly < ev.h; ly++) {
    const wy = ev.y + offset + ly
    if (wy < 0 || wy >= WORLD_H) continue
    for (let lx = 0; lx < ev.w; lx++) {
      if (bits[ly * ev.w + lx] !== 1) continue
      const wx = ev.x + lx
      if (wx < 0 || wx >= WORLD_W) continue
      mask[wy * WORLD_W + wx] = value
    }
  }
  return clip(ev.x, ev.y + offset, ev.x + ev.w - 1, ev.y + offset + ev.h - 1)
}

// clear the chunk's pixels at its original position (ev.t)
export function chunkRemove(mask: Mask, ev: ChunkEvent): Rect | null {
  return stamp(mask, ev, 0, 0)
}

// stamp the chunk at its landing position (ev.t + ev.dur); null when it fell off the map
export function chunkLand(mask: Mask, ev: ChunkEvent): Rect | null {
  return stamp(mask, ev, ev.dy, 1)
}

export function terrainTimeline(events: SimEvent[]): TerrainOp[] {
  const ops: Array<TerrainOp & { idx: number }> = []
  events.forEach((ev, idx) => {
    if (ev.type === "carve") ops.push({ at: ev.t, op: "carve", ev, idx })
    else if (ev.type === "fill") ops.push({ at: ev.t, op: "fill", ev, idx })
    else if (ev.type === "chunk") {
      ops.push({ at: ev.t, op: "remove", ev, idx })
      ops.push({ at: ev.t + ev.dur, op: "land", ev, idx })
    }
  })
  ops.sort((a, b) => a.at - b.at || a.idx - b.idx || (a.op === "remove" ? -1 : 1))
  return ops.map(({ idx: _idx, ...op }) => op as TerrainOp)
}

export function applyTerrainOp(mask: Mask, op: TerrainOp): Rect | null {
  if (op.op === "remove") return chunkRemove(mask, op.ev)
  if (op.op === "land") return chunkLand(mask, op.ev)
  return applyTerrainEvent(mask, op.ev)
}

// apply every terrain op with effect time <= `until` (default: all)
export function replayTerrain(mask: Mask, events: SimEvent[], until = Infinity): Mask {
  for (const op of terrainTimeline(events)) {
    if (op.at > until) break
    applyTerrainOp(mask, op)
  }
  return mask
}
