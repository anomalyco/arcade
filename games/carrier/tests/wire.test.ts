import { describe, expect, test } from "bun:test"
import { ByteWriter } from "@arcade/kit/net/bytes"
import { BOAT_MODE, packBoat } from "../shared/boat"
import { packTurret } from "../shared/gunnery"
import { type ClientMsg, type PlaneTuple, type ServerMsg, type ShipTuple, compactPlane, decodeClient, decodeServer, encode } from "../shared/protocol"
import { WIRE } from "../shared/wire"

/** A seeded generator, so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = rng(1234)
const between = (lo: number, hi: number) => lo + (hi - lo) * rand()

/** A random jet in a given mode, roughly as the flight seam sends it (unrounded here, to measure the grid). */
function jet(mode: number, tail = 2): PlaneTuple {
  const [x, y, z, w] = [between(-1, 1), between(-1, 1), between(-1, 1), between(-1, 1)]
  const n = Math.hypot(x, y, z, w)
  const q = mode === 3 ? [between(-Math.PI, Math.PI), between(-0.3, 0.3), between(-0.5, 0.5), Math.floor(between(0, 9))] : [x / n, y / n, z / n, w / n]
  const p: number[] = [between(0, 2e5), mode, between(-9500, 9500), between(-50, 9000), between(-9500, 9500), ...q, between(-400, 400), between(-200, 200), between(-400, 400), rand(), rand(), rand(), between(-1, 1), between(-1, 1)]
  if (tail > 0) p.push(Math.floor(between(0, 3)))
  if (tail > 1) p.push(rand())
  return p as PlaneTuple
}

const ship = (id: number): ShipTuple => {
  const r = (v: number, k: number) => Math.round(v * k) / k
  return [id, r(between(0, 1e5), 1e3), r(between(-9000, 9000), 1e2), r(between(-9000, 9000), 1e2), r(between(-Math.PI, Math.PI), 1e5), r(between(-5, 16), 1e3), r(between(-1, 1), 1e3), r(between(-0.05, 0.05), 1e5), r(between(-1, 1), 1e3), r(between(-1, 1), 1e3), r(between(-1, 1), 1e3)]
}

const boat = (id: number, recovering: boolean) =>
  packBoat({ id, t: between(0, 1e5), x: between(-9000, 9000), z: between(-9000, 9000), heading: between(-3, 3), u: between(-2, 20), v: between(-1, 1), r: between(-1, 1), power: rand(), rudder: between(-1, 1), yaw: between(-3, 3), pitch: between(-0.2, 1), mode: recovering ? BOAT_MODE.recover : BOAT_MODE.drive, modeAt: between(0, 1e5), ship: 3, from: recovering ? { x: between(-50, 50), z: between(-150, 150), yaw: between(-3, 3) } : null, firing: rand() < 0.5, boosting: rand() < 0.5 })

const isBinary = (v: unknown): v is Uint8Array => v instanceof Uint8Array
/** The same message as JSON, through the same checks: binary must decode to exactly what JSON would give. */
const jsonClient = (msg: ClientMsg) => decodeClient(JSON.stringify(msg))
const jsonServer = (msg: ServerMsg) => decodeServer(JSON.stringify(msg))

describe("binary frames (shared/wire.ts)", () => {
  const client: ClientMsg[] = [
    { type: "plane", p: compactPlane(jet(1)) },
    { type: "plane", p: compactPlane(jet(0, 0)) },
    { type: "plane", p: compactPlane(jet(2, 1)) },
    { type: "plane", p: compactPlane(jet(3)) },
    { type: "aim", a: [-1500, 420, 1] },
    { type: "aim", a: [7000, -7000, 0] },
    { type: "boat", c: [1, -0.55, 1, 1200, -100, 1] },
    { type: "boat", c: [-0.3, 0, 0, -4000, 2000, 0] },
    { type: "gun", on: true },
    { type: "gun", on: false },
    { type: "hits", on: 12, n: 3 },
    { type: "thits", on: 300, n: 300 },
    { type: "shiphits", ship: 4, n: 200 },
    { type: "bhits", k: 2, on: 3, n: 60 },
  ]
  const server: ServerMsg[] = [
    { type: "planes", p: [] },
    { type: "planes", p: [[3, ...compactPlane(jet(1))], [17, ...compactPlane(jet(3))], [31, ...compactPlane(jet(0))]] },
    { type: "ships", s: [] },
    { type: "ships", s: [ship(1), ship(2), ship(7), ship(12)] },
    { type: "boats", b: [] },
    { type: "boats", b: [boat(4, false), boat(9, true)] },
    { type: "turrets", t: [] },
    { type: "turrets", t: [packTurret(2, { mount: 4, yaw: -1.234, pitch: 0.5, firing: true, id: 9 }), packTurret(1, { mount: 0, yaw: 3, pitch: -0.1, firing: false, id: 31 })] },
    { type: "gun", id: 5, on: true },
    { type: "gun", id: 0, on: false },
  ]

  test("every high-rate message is a binary frame that decodes to exactly what its JSON would", () => {
    for (const m of client) {
      const raw = encode(m)
      expect(isBinary(raw)).toBe(true)
      expect(decodeClient(raw)).toEqual(m)
      expect(decodeClient(raw)).toEqual(jsonClient(m))
      // Socket payloads arrive as ArrayBuffers.
      expect(decodeClient((raw as Uint8Array).slice().buffer)).toEqual(m)
    }
    for (const m of server) {
      const raw = encode(m)
      expect(isBinary(raw)).toBe(true)
      expect(decodeServer(raw)).toEqual(m)
      expect(decodeServer(raw)).toEqual(jsonServer(m))
    }
  })

  test("everything else stays JSON text", () => {
    for (const m of [{ type: "hello", build: "x" }, { type: "ping", c: 1 }, { type: "chat", text: "hi" }, { type: "op", op: "hornet" }] as ClientMsg[]) expect(typeof encode(m)).toBe("string")
    for (const m of [{ type: "pong", c: 1, s: 2 }, { type: "obj", o: [] }, { type: "hulls", h: [] }, { type: "nope", error: "x" }] as ServerMsg[]) expect(typeof encode(m)).toBe("string")
  })

  test("frames are compact", () => {
    expect(encode({ type: "plane", p: compactPlane(jet(1)) }).length).toBeLessThanOrEqual(44)
    expect(encode({ type: "aim", a: [-1500, 420, 1] }).length).toBeLessThanOrEqual(6)
    expect(encode({ type: "gun", on: true }).length).toBe(2)
    const planes = encode({ type: "planes", p: Array.from({ length: 12 }, (_, i) => [i, ...compactPlane(jet(1))]) })
    // Random times far apart (real frames hold jets a few ms apart: ~32 B each, tests/room-size.test.ts).
    expect(planes.length / 12).toBeLessThan(40)
    expect(encode({ type: "ships", s: [ship(1), ship(2), ship(3), ship(4)] }).length / 4).toBeLessThan(30)
  })

  test("quantization: jets within half a grid step, and compactPlane is exactly what a receiver decodes", () => {
    const steps = [1e-3, 0, 0.01, 0.01, 0.01, 1 / 32767, 1 / 32767, 1 / 32767, 1 / 32767, 0.1, 0.1, 0.1, 0.01, 0.01, 0.01, 0.01, 0.01, 0, 0.01]
    const landing = [...steps.slice(0, 5), 1e-4, 1e-4, 1e-4, 0, ...steps.slice(9)]
    for (let i = 0; i < 500; i++) {
      const mode = i % 4
      const p = jet(mode)
      const raw = encode({ type: "plane", p })
      const got = decodeClient(raw)
      expect(got?.type).toBe("plane")
      const q = (got as Extract<ClientMsg, { type: "plane" }>).p
      const grid = mode === 3 ? landing : steps
      for (let k = 0; k < p.length; k++) expect(Math.abs(q[k]! - p[k]!)).toBeLessThanOrEqual(grid[k]! / 2 + 1e-9)
      expect(compactPlane([...p] as PlaneTuple)).toEqual(q)
      // Idempotent: the room re-encoding a decoded jet changes nothing.
      expect(decodeClient(encode({ type: "plane", p: q }))).toEqual(got)
      expect(compactPlane([...q] as PlaneTuple)).toEqual(q)
    }
  })

  test("quantization: ships and boats keep the room's own rounding exactly", () => {
    for (let i = 0; i < 200; i++) {
      const s = [ship(i), ship(i + 1)]
      // Rounding can give -0, which JSON also reads back as 0.
      expect(decodeServer(encode({ type: "ships", s }))).toEqual(jsonServer({ type: "ships", s }))
      const b = [boat(i, i % 2 === 0)]
      expect(decodeServer(encode({ type: "boats", b }))).toEqual(jsonServer({ type: "boats", b }))
    }
  })

  test("malformed frames decode to null and never throw", () => {
    for (const m of client) {
      const raw = encode(m) as Uint8Array
      for (let n = 0; n < raw.length; n++) expect(decodeClient(raw.subarray(0, n))).toBeNull()
      expect(decodeClient(new Uint8Array([...raw, 0]))).toBeNull()
      expect(decodeServer(raw)).toBeNull()
    }
    for (const m of server) {
      const raw = encode(m) as Uint8Array
      for (let n = 0; n < raw.length; n++) expect(decodeServer(raw.subarray(0, n))).toBeNull()
      expect(decodeServer(new Uint8Array([...raw, 0]))).toBeNull()
      expect(decodeClient(raw)).toBeNull()
    }
    // Unknown kinds, out-of-range flags and values the JSON checks refuse.
    expect(decodeClient(new Uint8Array([200, 0]))).toBeNull()
    expect(decodeClient(new Uint8Array([WIRE.gun, 2]))).toBeNull()
    expect(decodeServer(new Uint8Array([WIRE.gunRelay, 1, 7]))).toBeNull()
    expect(decodeClient(new Uint8Array([WIRE.boat, 128, 128, 4, 0, 0]))).toBeNull()
    expect(decodeClient(new Uint8Array([WIRE.boat, 255, 128, 0, 0, 0]))).toBeNull()
    expect(decodeClient(new Uint8Array([WIRE.bhits, 3, 1, 1]))).toBeNull()
    expect(decodeClient(new Uint8Array([WIRE.hits, 1, 0]))).toBeNull()
    expect(decodeClient(encode({ type: "aim", a: [9000, 0, 0] }))).toBeNull()
    expect(decodeServer(new Uint8Array([WIRE.turrets, 1, 0, 100, 0, 0, 0]))).toBeNull()
    // A jet header with an impossible tail, a vehicle code on a short tuple, a doors byte over 1, a position off the map.
    const plane = encode({ type: "plane", p: compactPlane(jet(1)) }) as Uint8Array
    const bad = (at: number, v: number) => {
      const b = plane.slice()
      b[at] = v
      return b
    }
    expect(decodeClient(bad(9, plane[9]! | 12))).toBeNull()
    expect(decodeClient(bad(9, 1 | (3 << 4)))).toBeNull()
    expect(decodeClient(bad(plane.length - 1, 101))).toBeNull()
    const far = new ByteWriter().u8(WIRE.plane).f64(1000).u8(1).ivar(0).ivar(2e8).ivar(0).ivar(0)
    for (let i = 0; i < 4; i++) far.i16(0)
    for (let i = 0; i < 3; i++) far.ivar(0)
    far.u8(0).u8(0).u8(0).ivar(0).ivar(0)
    expect(decodeClient(far.finish())).toBeNull()
    // The sender clamps instead (2 km past the limit reads as the limit).
    expect((decodeClient(encode({ type: "plane", p: [1, 1, 2e6, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0] })) as Extract<ClientMsg, { type: "plane" }>).p[2]).toBe(1e6)
    // Oversized frames.
    expect(decodeClient(new Uint8Array(600))).toBeNull()
    expect(decodeServer(new Uint8Array(1 << 17))).toBeNull()
    // Random bytes: always null or a valid message, never an exception.
    const r = rng(99)
    for (let i = 0; i < 5000; i++) {
      const b = new Uint8Array(1 + Math.floor(r() * 60)).map(() => Math.floor(r() * 256))
      if (r() < 0.7) b[0] = [1, 2, 3, 4, 5, 9, 64, 65, 66, 67, 68][Math.floor(r() * 11)]!
      expect(() => decodeClient(b)).not.toThrow()
      expect(() => decodeServer(b)).not.toThrow()
    }
  })
})
