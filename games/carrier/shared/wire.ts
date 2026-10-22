// Binary frames for the high-rate messages (shared/protocol.ts sends everything else as JSON text). One socket carries
// both: a text frame is JSON, a binary frame starts with a kind byte. Little-endian, @arcade/kit/net/bytes.
//
// This layer only maps bytes to the same message objects JSON would give: decodeClient/decodeServer validate them with
// the same checks either way. Quantization (each value is sent as round(v × k), read back as n / k):
//   jets (plane, planes): sea time 1 ms; position 1 cm (world, or ship-local on the deck and landing); quaternion
//     1/32767 (i16, modes 0-2); landing yaw/pitch/bank 1e-4 rad and the carrier id (mode 3); velocity 0.1 m/s;
//     throttle, burner, gear and bay doors 1/100 in 0..1; stick 1/100. `compactPlane` is exactly this grid.
//   ships: the room's own rounding (time 1 ms, position 1 cm, heading and yaw rate 1e-5, speeds and controls 1e-3).
//   boats: shared/boat.ts packBoat's (time 1 ms, position and speeds 1 cm, angles 1e-3), so lossless.
//   turrets, aims, boat orders, triggers and hit counts are integers (or 1/100 orders) already: lossless.
// Times are one f64 of whole milliseconds per frame plus a signed varint offset per entry.

import { ByteReader, ByteWriter } from "@arcade/kit/net/bytes"

/** First byte of a binary frame. Client → room and room → client codes never overlap. */
export const WIRE = {
  plane: 1,
  aim: 2,
  boat: 3,
  gun: 4,
  hits: 5,
  shiphits: 6,
  thits: 7,
  tshiphits: 8,
  bhits: 9,
  deckhits: 10,
  planes: 64,
  ships: 65,
  turrets: 66,
  boats: 67,
  gunRelay: 68,
} as const

/** The base jet tuple's length (shared/protocol.ts PLANE_TUPLE_LENGTH). */
const PLANE_BASE = 17
const LANDING = 3
/** Plan coordinates and speeds beyond this are nonsense (shared/protocol.ts POSE_LIMIT). */
export const WIRE_LIMIT = 1e6
const INT_MAX = 2 ** 31 - 1

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
/** round(v × k) clamped to ±lim × k (lim × k stays inside int32 for every caller). */
const q = (v: number, k: number, lim: number) => Math.round(clamp(v, -lim, lim) * k)
/** The value a receiver reads for v on grid k (no negative zero). */
export const grid = (v: number, k: number, lim = WIRE_LIMIT) => q(v, k, lim) / k + 0
const unit = (v: number) => Math.round(clamp(v, 0, 1) * 100)
const ms = (t: number) => Math.round(t * 1000)

/** Jets: the exact values a receiver decodes for a tuple (shared/protocol.ts compactPlane). */
export function quantizePlane(p: number[]): number[] {
  p[0] = ms(p[0]!) / 1000 + 0
  for (const i of [2, 3, 4]) p[i] = grid(p[i]!, 100)
  if (p[1] === LANDING) {
    for (const i of [5, 6, 7]) p[i] = grid(p[i]!, 1e4, 1e5)
    p[8] = Math.round(clamp(p[8]!, 0, INT_MAX))
  } else for (const i of [5, 6, 7, 8]) p[i] = Math.round(clamp(p[i]!, -1, 1) * 32767) / 32767 + 0
  for (const i of [9, 10, 11]) p[i] = grid(p[i]!, 10)
  for (const i of [12, 13, 14]) p[i] = unit(p[i]!) / 100
  for (const i of [15, 16]) p[i] = grid(p[i]!, 100)
  if (p.length > 18) p[18] = unit(p[18]!) / 100
  return p
}

function writePlane(w: ByteWriter, p: readonly number[], base: number): void {
  const tail = p.length - PLANE_BASE
  const mode = p[1]!
  w.u8((mode & 3) | ((tail & 3) << 2) | (tail > 0 ? (p[17]! & 15) << 4 : 0))
  w.ivar(ms(p[0]!) - base)
  for (const i of [2, 3, 4]) w.ivar(q(p[i]!, 100, WIRE_LIMIT))
  if (mode === LANDING) {
    for (const i of [5, 6, 7]) w.ivar(q(p[i]!, 1e4, 1e5))
    w.uvar(Math.round(clamp(p[8]!, 0, INT_MAX)))
  } else for (const i of [5, 6, 7, 8]) w.i16(Math.round(clamp(p[i]!, -1, 1) * 32767))
  for (const i of [9, 10, 11]) w.ivar(q(p[i]!, 10, WIRE_LIMIT))
  for (const i of [12, 13, 14]) w.u8(unit(p[i]!))
  for (const i of [15, 16]) w.ivar(q(p[i]!, 100, WIRE_LIMIT))
  if (tail > 1) w.u8(unit(p[18]!))
}

/** A jet tuple, or null when the header is malformed (decodeClient/decodeServer check the values). */
function readPlane(r: ByteReader, base: number): number[] | null {
  const h = r.u8()
  const mode = h & 3
  const tail = (h >> 2) & 3
  const vehicle = h >> 4
  if (tail > 2 || (tail === 0 && vehicle !== 0)) return null
  const p: number[] = [(base + r.ivar()) / 1000, mode]
  for (let i = 0; i < 3; i++) p.push(r.ivar() / 100)
  if (mode === LANDING) {
    for (let i = 0; i < 3; i++) p.push(r.ivar() / 1e4)
    p.push(r.uvar())
  } else for (let i = 0; i < 4; i++) p.push(r.i16() / 32767)
  for (let i = 0; i < 3; i++) p.push(r.ivar() / 10)
  for (let i = 0; i < 3; i++) p.push(r.u8() / 100)
  for (let i = 0; i < 2; i++) p.push(r.ivar() / 100)
  if (tail > 0) p.push(vehicle)
  if (tail > 1) p.push(r.u8() / 100)
  return p
}

type Msg = { type: string; [k: string]: unknown }
const writer = new ByteWriter(4096)
const bool = (b: number) => (b === 1 ? true : b === 0 ? false : null)
const u8i = (v: number) => clamp(Math.round(v) + 128, 0, 255)

/** Frames with a list of timed entries: count, then (if any) the first entry's time as whole ms. */
function timed<T>(w: ByteWriter, list: readonly T[], t: (e: T) => number, each: (e: T, base: number) => void): void {
  w.uvar(list.length)
  if (!list.length) return
  const base = ms(t(list[0]!))
  w.f64(base)
  for (const e of list) each(e, base)
}

function readTimed(r: ByteReader, max: number, each: (base: number) => unknown): unknown[] | null {
  const n = r.uvar()
  if (n > max) return null
  if (!n) return []
  const base = r.f64()
  if (!Number.isSafeInteger(base)) return null
  const out: unknown[] = []
  for (let i = 0; i < n; i++) {
    const e = each(base)
    if (e === null) return null
    out.push(e)
  }
  return out
}

/**
 * A binary frame for a high-rate message, or null for one that travels as JSON. `msg` must already be valid (the
 * sender's own message types); values outside the grid's range are clamped.
 */
export function encodeWire(msg: Msg): Uint8Array | null {
  const w = writer.reset()
  const m = msg as Record<string, any>
  switch (msg.type) {
    case "plane": {
      const p = m.p as number[]
      const base = ms(p[0]!)
      w.u8(WIRE.plane).f64(base)
      writePlane(w, p, base)
      break
    }
    case "planes":
      w.u8(WIRE.planes)
      timed(w, m.p as number[][], (e) => e[1]!, (e, base) => {
        w.uvar(e[0]!)
        writePlane(w, e.slice(1), base)
      })
      break
    case "ships":
      w.u8(WIRE.ships)
      timed(w, m.s as number[][], (e) => e[1]!, (s, base) => {
        w.uvar(s[0]!).ivar(ms(s[1]!) - base)
        w.ivar(q(s[2]!, 100, WIRE_LIMIT)).ivar(q(s[3]!, 100, WIRE_LIMIT))
        w.ivar(q(s[4]!, 1e5, 1e4)).ivar(q(s[5]!, 1e3, WIRE_LIMIT)).ivar(q(s[6]!, 1e3, WIRE_LIMIT)).ivar(q(s[7]!, 1e5, 1e4))
        for (let i = 8; i < 11; i++) w.ivar(q(s[i]!, 1e3, WIRE_LIMIT))
      })
      break
    case "boats":
      w.u8(WIRE.boats)
      timed(w, m.b as number[][], (e) => e[1]!, (b, base) => {
        const from = b[15] !== 0 || b[16] !== 0 || b[17] !== 0
        w.uvar(b[0]!).ivar(ms(b[1]!) - base)
        w.ivar(q(b[2]!, 100, WIRE_LIMIT)).ivar(q(b[3]!, 100, WIRE_LIMIT)).ivar(q(b[4]!, 1e3, WIRE_LIMIT))
        w.ivar(q(b[5]!, 100, WIRE_LIMIT)).ivar(q(b[6]!, 100, WIRE_LIMIT)).ivar(q(b[7]!, 1e3, WIRE_LIMIT))
        w.ivar(q(b[8]!, 100, WIRE_LIMIT)).ivar(q(b[9]!, 100, WIRE_LIMIT)).ivar(q(b[10]!, 1e3, WIRE_LIMIT)).ivar(q(b[11]!, 1e3, WIRE_LIMIT))
        w.u8((b[12]! & 3) | (b[18] === 1 ? 4 : 0) | (b[19] === 1 ? 8 : 0) | (from ? 16 : 0))
        w.ivar(clamp(ms(b[13]!) - base, -INT_MAX, INT_MAX)).uvar(b[14]!)
        if (from) w.ivar(q(b[15]!, 100, WIRE_LIMIT)).ivar(q(b[16]!, 100, WIRE_LIMIT)).ivar(q(b[17]!, 1e3, WIRE_LIMIT))
      })
      break
    case "turrets": {
      const list = m.t as number[][]
      w.u8(WIRE.turrets).uvar(list.length)
      for (const t of list) w.uvar(t[0]!).u8((t[1]! & 127) | (t[4] === 1 ? 128 : 0)).ivar(t[2]!).ivar(t[3]!).uvar(t[5]!)
      break
    }
    case "gun":
      if ("id" in m) w.u8(WIRE.gunRelay).uvar(m.id).u8(m.on ? 1 : 0)
      else w.u8(WIRE.gun).u8(m.on ? 1 : 0)
      break
    case "aim": {
      const a = m.a as number[]
      w.u8(WIRE.aim).ivar(a[0]!).ivar(a[1]!).u8(a[2] === 1 ? 1 : 0)
      break
    }
    case "boat": {
      const c = m.c as number[]
      w.u8(WIRE.boat).u8(u8i(c[0]! * 100)).u8(u8i(c[1]! * 100)).u8((c[2] === 1 ? 1 : 0) | (c[5] === 1 ? 2 : 0)).ivar(c[3]!).ivar(c[4]!)
      break
    }
    case "hits":
    case "thits":
      w.u8(WIRE[msg.type]).uvar(m.on).uvar(m.n)
      break
    case "shiphits":
    case "tshiphits":
      w.u8(WIRE[msg.type]).uvar(m.ship).uvar(m.n)
      break
    case "bhits":
      w.u8(WIRE.bhits).u8(m.k).uvar(m.on).uvar(m.n)
      break
    case "deckhits":
      w.u8(WIRE.deckhits).u8(m.w).uvar(m.ship).uvar(m.slot).uvar(m.n)
      break
    default:
      return null
  }
  return w.finish()
}

/** The bytes of a binary WebSocket payload (ArrayBuffer or a view), or null for anything else. */
export function wireBytes(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  return null
}

/** Client → room: the message fields of a binary frame, unvalidated; null when it doesn't parse. */
export function decodeClientWire(bytes: Uint8Array): Record<string, unknown> | null {
  return read(bytes, (r, kind) => {
    switch (kind) {
      case WIRE.plane: {
        const base = r.f64()
        if (!Number.isSafeInteger(base)) return null
        const p = readPlane(r, base)
        return p && { type: "plane", p }
      }
      case WIRE.aim:
        return { type: "aim", a: [r.ivar(), r.ivar(), r.u8()] }
      case WIRE.boat: {
        const th = r.u8() - 128
        const st = r.u8() - 128
        const f = r.u8()
        if (f > 3) return null
        return { type: "boat", c: [th / 100 + 0, st / 100 + 0, f & 1, r.ivar(), r.ivar(), (f >> 1) & 1] }
      }
      case WIRE.gun:
        return { type: "gun", on: bool(r.u8()) }
      case WIRE.hits:
        return { type: "hits", on: r.uvar(), n: r.uvar() }
      case WIRE.thits:
        return { type: "thits", on: r.uvar(), n: r.uvar() }
      case WIRE.shiphits:
        return { type: "shiphits", ship: r.uvar(), n: r.uvar() }
      case WIRE.tshiphits:
        return { type: "tshiphits", ship: r.uvar(), n: r.uvar() }
      case WIRE.bhits:
        return { type: "bhits", k: r.u8(), on: r.uvar(), n: r.uvar() }
      case WIRE.deckhits:
        return { type: "deckhits", w: r.u8(), ship: r.uvar(), slot: r.uvar(), n: r.uvar() }
    }
    return null
  })
}

/** Room → client: the message fields of a binary frame, unvalidated; null when it doesn't parse. */
export function decodeServerWire(bytes: Uint8Array): Record<string, unknown> | null {
  return read(bytes, (r, kind) => {
    switch (kind) {
      case WIRE.planes: {
        const p = readTimed(r, 64, (base) => {
          const id = r.uvar()
          const p = readPlane(r, base)
          return p && [id, ...p]
        })
        return p && { type: "planes", p }
      }
      case WIRE.ships: {
        const s = readTimed(r, 64, (base) => [r.uvar(), (base + r.ivar()) / 1000, r.ivar() / 100, r.ivar() / 100, r.ivar() / 1e5, r.ivar() / 1e3, r.ivar() / 1e3, r.ivar() / 1e5, r.ivar() / 1e3, r.ivar() / 1e3, r.ivar() / 1e3])
        return s && { type: "ships", s }
      }
      case WIRE.boats: {
        const b = readTimed(r, 64, (base) => {
          const head = [r.uvar(), (base + r.ivar()) / 1000]
          for (const k of [100, 100, 1e3, 100, 100, 1e3, 100, 100, 1e3, 1e3]) head.push(r.ivar() / k)
          const f = r.u8()
          if (f > 31) return null
          const modeAt = (base + r.ivar()) / 1000
          const ship = r.uvar()
          const from = f & 16 ? [r.ivar() / 100, r.ivar() / 100, r.ivar() / 1e3] : [0, 0, 0]
          return [...head, f & 3, modeAt, ship, ...from, (f >> 2) & 1, (f >> 3) & 1]
        })
        return b && { type: "boats", b }
      }
      case WIRE.turrets: {
        const n = r.uvar()
        if (n > 64) return null
        const t: number[][] = []
        for (let i = 0; i < n; i++) {
          const ship = r.uvar()
          const m = r.u8()
          t.push([ship, m & 127, r.ivar(), r.ivar(), m >> 7, r.uvar()])
        }
        return { type: "turrets", t }
      }
      case WIRE.gunRelay:
        return { type: "gun", id: r.uvar(), on: bool(r.u8()) }
    }
    return null
  })
}

/** Runs a frame body; anything short, long or unknown is null. */
function read(bytes: Uint8Array, body: (r: ByteReader, kind: number) => Record<string, unknown> | null): Record<string, unknown> | null {
  if (bytes.byteLength < 1) return null
  try {
    const r = new ByteReader(bytes)
    const out = body(r, r.u8())
    return out && r.remaining === 0 ? out : null
  } catch {
    return null
  }
}
