import { packAngle, unpackAngle, type ByteReader, type ByteWriter } from "@arcade/kit/net/bytes"
import type { OutbreakNetSectionCodec } from "../feature-registry"
import type { DeathSnapshot, DeathState, FallenBody, LifeRecord } from "./rules"

/** The death section's bit in the snapshot header (the first eight are taken). */
export const SEC_DEATH = 256

const cm = (v: number) => Math.round(v * 100)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** The state as the wire carries it; undefined while everyone is up, nobody has fallen and the run goes on. */
export function deathSnapshotOf(state: DeathState, slots: readonly { index: number }[]): DeathSnapshot | undefined {
  const survivors: DeathSnapshot["survivors"] = []
  for (const s of slots) {
    const rec = state.records[s.index]
    if (!rec || rec.state === "alive") continue
    survivors.push({
      index: s.index,
      state: rec.state,
      cause: clamp(rec.cause, 0, 63),
      night: clamp(rec.night, 0, 255),
      dark: rec.dark,
      bleed: rec.state === "down" ? Math.round(clamp(rec.bleed, 0, 6553.5) * 10) / 10 : 0,
      revive: rec.state === "down" ? Math.round(clamp(rec.revive, 0, 1) * 255) / 255 : 0,
      reviver: rec.state === "down" ? clamp(rec.reviver, -1, 254) : -1,
    })
  }
  const bodies: FallenBody[] = state.bodies.map((b) => ({ index: b.index, n: b.n, x: cm(b.x) / 100, y: cm(b.y) / 100, yaw: unpackAngle(packAngle(b.yaw)) }))
  const over = state.runOver
    ? { dawns: state.dawns, kills: slots.map((s) => ({ index: s.index, kills: state.records[s.index]?.kills ?? 0 })) }
    : null
  if (!survivors.length && !bodies.length && !over) return undefined
  return { survivors, bodies, over }
}

export function writeDeath(w: ByteWriter, d: DeathSnapshot): void {
  w.u8(d.over ? 1 : 0)
  w.u8(d.survivors.length)
  for (const s of d.survivors) {
    w.u8(s.index)
    w.u8((s.state === "dead" ? 1 : 0) | (s.dark ? 2 : 0) | (s.cause << 2))
    w.u8(s.night)
    if (s.state === "down") {
      w.u16(Math.round(s.bleed * 10))
      w.u8(Math.round(s.revive * 255))
      w.u8(s.reviver + 1)
    }
  }
  w.u8(d.bodies.length)
  for (const b of d.bodies) {
    w.u8(b.index)
    w.uvar(b.n)
    w.i32(cm(b.x)).i32(cm(b.y)).u16(packAngle(b.yaw))
  }
  if (d.over) {
    w.uvar(d.over.dawns)
    w.u8(d.over.kills.length)
    for (const k of d.over.kills) w.u8(k.index).uvar(k.kills)
  }
}

export function readDeath(r: ByteReader): DeathSnapshot {
  const flags = r.u8()
  const survivors: DeathSnapshot["survivors"] = []
  for (let n = r.u8(), i = 0; i < n; i++) {
    const index = r.u8()
    const bits = r.u8()
    const night = r.u8()
    const dead = Boolean(bits & 1)
    const bleed = dead ? 0 : r.u16() / 10
    const revive = dead ? 0 : r.u8() / 255
    const reviver = dead ? -1 : r.u8() - 1
    survivors.push({ index, state: dead ? "dead" : "down", cause: bits >> 2, night, dark: Boolean(bits & 2), bleed, revive, reviver })
  }
  const bodies: FallenBody[] = []
  for (let n = r.u8(), i = 0; i < n; i++) {
    const index = r.u8()
    const nth = r.uvar()
    const x = r.i32() / 100
    const y = r.i32() / 100
    bodies.push({ index, n: nth, x, y, yaw: unpackAngle(r.u16()) })
  }
  let over: DeathSnapshot["over"] = null
  if (flags & 1) {
    const dawns = r.uvar()
    const kills: { index: number; kills: number }[] = []
    for (let n = r.u8(), i = 0; i < n; i++) kills.push({ index: r.u8(), kills: r.uvar() })
    over = { dawns, kills }
  }
  return { survivors, bodies, over }
}

const same = (a: DeathSnapshot | undefined, b: DeathSnapshot | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * Down and dead survivors, fallen bodies and the run's end. Sent whole when it differs from the acked base snapshot
 * (a delta that leaves it out keeps the base's), so a quiet run costs nothing and a downed survivor ~6 bytes a snapshot.
 */
export const deathNetSection: OutbreakNetSectionCodec<DeathState, DeathSnapshot, DeathSnapshot> = {
  bit: SEC_DEATH,
  key: "death",
  collect: ({ sim, isDelta, baseSnap, state }) => {
    const value = state ? deathSnapshotOf(state, sim.slots) : undefined
    const base = isDelta ? baseSnap?.death : undefined
    const shouldWrite = !same(value, base)
    const empty: DeathSnapshot = { survivors: [], bodies: [], over: null }
    return { snapshotValue: value, shouldWrite, writePayload: value ?? empty }
  },
  encode: (w, d) => writeDeath(w, d),
  decode: (r) => {
    const d = readDeath(r)
    return d.survivors.length || d.bodies.length || d.over ? d : undefined
  },
  decodeOmitted: ({ isDelta, baseSnap }) => (isDelta ? baseSnap?.death : undefined),
}

/** A client's death state, rebuilt from a snapshot's section (records for the down and dead, bodies, the run's end). */
export function applyDeathSnapshot(state: DeathState, d: DeathSnapshot | undefined, time: number): void {
  const seen = new Set<number>()
  for (const s of d?.survivors ?? []) {
    seen.add(s.index)
    const prev = state.records[s.index]
    const rec: LifeRecord = prev ?? { index: s.index, state: "alive", since: time, bleed: 0, revive: 0, reviver: -1, reviveAt: 0, cause: 0, night: 0, dark: false, kills: 0, deaths: 0 }
    if (rec.state !== s.state) rec.since = time
    Object.assign(rec, { state: s.state, cause: s.cause, night: s.night, dark: s.dark, bleed: s.bleed, revive: s.revive, reviver: s.reviver })
    state.records[s.index] = rec
  }
  for (const rec of Object.values(state.records)) {
    if (seen.has(rec.index) || rec.state === "alive") continue
    rec.state = "alive"
    rec.since = time
    rec.bleed = rec.revive = 0
    rec.reviver = -1
  }
  state.bodies = (d?.bodies ?? []).map((b) => ({ ...b }))
  for (const b of state.bodies) {
    const rec = state.records[b.index]
    if (rec) rec.deaths = Math.max(rec.deaths, b.n)
  }
  state.runOver = Boolean(d?.over)
  if (d?.over) {
    state.dawns = d.over.dawns
    for (const k of d.over.kills) {
      const rec = (state.records[k.index] ??= { index: k.index, state: "alive", since: time, bleed: 0, revive: 0, reviver: -1, reviveAt: 0, cause: 0, night: 0, dark: false, kills: 0, deaths: 0 })
      rec.kills = k.kills
    }
  }
}
