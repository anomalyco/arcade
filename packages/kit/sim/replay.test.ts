import { expect, test } from "bun:test"
import { assertReplayMatches, recordReplay, replay, replayHash, type ReplaySim } from "./replay"

const sim: ReplaySim<{ x: number; health: number }, { dx: number; hit: boolean }> = {
  version: "test-v1",
  init: ({ seed }) => ({ x: seed, health: 10 }),
  step: (s, inputs) => { for (const input of inputs) { s.x += input.dx; s.health -= Number(input.hit) } },
  fields: (s) => ({ "player.x": s.x, "player.health": s.health }),
}
const recorded = () => recordReplay(sim, { seed: 7, tickDt: 1 / 60, players: ["a", "b"], ticks: 4 }, (_, tick) => [
  { dx: 1 / 3, hit: tick === 2 }, { dx: -1, hit: false },
])

test("state hashing is key-order independent, bit-exact and type delimited", () => {
  expect(replayHash({ b: [1, 2], a: { z: true, y: null } })).toBe(replayHash({ a: { y: null, z: true }, b: [1, 2] }))
  const distinct = [0, -0, 1, 1 + Number.EPSILON, NaN, Infinity, -Infinity, null, undefined, "", "1", false, [], {}, [1, 2], [2, 1], ["ab", "c"], ["a", "bc"], { x: undefined }]
  expect(new Set(distinct.map(replayHash)).size).toBe(distinct.length)
  expect(replayHash(new Float64Array([1, 2]).subarray(1))).toBe(replayHash(new Float64Array([2])))
  expect(replayHash(new Float32Array([2]))).not.toBe(replayHash(new Float64Array([2])))
  expect(() => replayHash(new Map([["x", 1]]))).toThrow("plain data")
  expect(() => replayHash({ fn() {} })).toThrow("function")
  const cycle: { self?: unknown } = {}; cycle.self = cycle
  expect(() => replayHash(cycle)).toThrow("cycles")
})

test("recorded multiplayer inputs survive JSON and replay every tick", () => {
  const { recording, golden } = recorded()
  const trace = replay(sim, JSON.parse(JSON.stringify(recording)))
  expect(trace.hashes).toHaveLength(5)
  expect(() => assertReplayMatches(trace, golden)).not.toThrow()
})

test("a transient regression reports the first divergent tick and field, even if the final state agrees", () => {
  const { recording, golden } = recorded()
  let tick = 0
  const regressed = replay({ ...sim, step(s, inputs, dt) {
    sim.step(s, inputs, dt)
    tick++
    if (tick === 2) s.health--
    if (tick === 3) s.health++
  } }, recording)
  expect(regressed.hashes.at(-1)).toBe(golden.hashes.at(-1))
  expect(() => assertReplayMatches(regressed, golden)).toThrow(/tick 2:[\s\S]*player.health/)
})

test("added and removed fields are named, including undefined versus missing", () => {
  const { recording, golden } = recorded()
  const added = replay({ ...sim, fields: (s) => ({ ...sim.fields(s), extra: undefined }) }, recording)
  expect(() => assertReplayMatches(added, golden)).toThrow(/tick 0:[\s\S]*extra: <absent>/)
  expect(() => assertReplayMatches(golden, added)).toThrow(/extra: .* -> <absent>/)
})

test("rejects incompatible headers, missing players and changed recordings", () => {
  const { recording, golden } = recorded()
  expect(() => replay(sim, { ...recording, version: 2 as 1 })).toThrow("version")
  expect(() => replay(sim, { ...recording, simVersion: "old" })).toThrow("sim version")
  expect(() => replay(sim, { ...recording, tickDt: NaN })).toThrow("tickDt")
  expect(() => replay(sim, { ...recording, players: ["a", "a"] })).toThrow("unique")
  expect(() => replay(sim, { ...recording, inputs: [[recording.inputs[0]![0]!]] })).toThrow("one input")
  expect(() => assertReplayMatches(replay(sim, { ...recording, seed: 8 }), golden)).toThrow("recording changed")
})
