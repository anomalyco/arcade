import { expect, test } from "bun:test"
import { MIMIC_LINES, type DistantEvent } from "../shared/distant"
import { VOICE_LINES } from "../shared/lines.gen"
import { BOT_ID, createWoods, FEEL, stepWoods, type PlayerInput, type WoodsState } from "../shared/sim"
import { CAST, createVoices, lineOf as findLine, openingLines, stepVoices, voiceRoles, type VoiceEvent, type Walker } from "../shared/voices"
import { makeWorld } from "../shared/world"

const world = makeWorld()
const walk = (t: number): PlayerInput => ({ yaw: t * 0.05, pitch: 0, light: true, tie: false, map: false, mx: 0.3 * Math.sin(t * 0.03), mz: -0.6, sprint: false })
const lineOf = (id: string) => findLine(id)!
/** The night's key moments: a clue's reaction, dawn, the cassette, the extra searcher (NIGHT.md). */
const NIGHT_KEYS = ["car", "page", "badge", "cassette", "strip", "dawn", "daylight", "tape-tower", "extra"]

function run(seconds: number, feel = FEEL, humans = [{ id: 0, name: "You" }]): { state: WoodsState; lines: VoiceEvent[] } {
  const state = createWoods(world, 3, world.params.seed, humans)
  const lines: VoiceEvent[] = []
  for (let i = 0; i < seconds * 30; i++) {
    stepWoods(state, world, new Map(humans.map((h) => [h.id, walk(state.t)])), 1 / 30, feel)
    for (const e of state.events) if (e.kind === "voice") lines.push(e)
  }
  return { state, lines }
}

test("every line has a file's worth of data and every searcher has calls", () => {
  for (const c of CAST) expect(VOICE_LINES.filter((l) => l.cast === c && l.pool === "call").length).toBeGreaterThanOrEqual(4)
  for (const l of VOICE_LINES) expect(l.seconds).toBeGreaterThan(0.3)
})

test("who plays whom: solo you're Owen, bots are Walt, Joyce and Gary, and Dale and Tess are out in the woods", () => {
  const roles = voiceRoles([{ id: 0, bot: false }, { id: BOT_ID, bot: true }, { id: BOT_ID + 1, bot: true }, { id: BOT_ID + 2, bot: true }], BOT_ID)
  expect(roles.byWalker.get(0)).toBe("owen")
  expect([BOT_ID, BOT_ID + 1, BOT_ID + 2].map((id) => roles.byWalker.get(id))).toEqual(["walt", "joyce", "gary"])
  expect(roles.roaming).toEqual(["dale", "tess"])
  const room = voiceRoles([{ id: 1, bot: false }, { id: 2, bot: false }, { id: BOT_ID, bot: true }, { id: BOT_ID + 1, bot: true }], BOT_ID)
  expect([1, 2].map((id) => room.byWalker.get(id))).toEqual(["owen", "tess"])
  expect(createWoods(world, 3).players.filter((p) => p.bot).map((p) => p.name)).toEqual(["Walt", "Joyce", "Gary"])
})

test("the same seed gives the same conversation", () => {
  const a = run(300, { ...FEEL, chatter: 1 }).lines, b = run(300, { ...FEEL, chatter: 1 }).lines
  expect(a.length).toBeGreaterThan(0)
  expect(b).toEqual(a)
})

test("sparse: one voice at a time, a few lines a minute at most, long silences", () => {
  const { lines } = run(900, { ...FEEL, chatter: 1 })
  const perMinute = lines.length / 15
  expect(perMinute).toBeGreaterThan(0.5)
  expect(perMinute).toBeLessThan(5)
  // A line never starts before the last one has been said.
  for (let i = 1; i < lines.length; i++) expect(lines[i]!.at).toBeGreaterThanOrEqual(lines[i - 1]!.at + lineOf(lines[i - 1]!.line).seconds)
  // Some minute of the fifteen has no voice in it at all.
  const minutes = new Set(lines.map((l) => Math.floor(l.at / 60)))
  expect(minutes.size).toBeLessThan(15)
  // Nothing in the first half-minute: the opening (the client's) has the trailhead.
  expect(lines.every((l) => l.at > 30)).toBe(true)
})

test("the default leaves only key moments and the mimic's call, and people's own searchers only speak at key moments", () => {
  const quiet = run(600, { ...FEEL, uncanny: false }).lines.map((l) => lineOf(l.line).pool)
  for (const pool of quiet) expect(["clue", "coming", "sighting", "sightreply", ...NIGHT_KEYS]).toContain(pool)
  const { lines } = run(900, { ...FEEL, chatter: 1 })
  for (const l of lines.filter((l) => l.by === 0)) expect(["clue", "sighting", "sightreply", ...NIGHT_KEYS]).toContain(lineOf(l.line).pool)
})

test("a find: the finder says so and another searcher answers; with player barks off, a person's find is silent", () => {
  const walkers: Walker[] = [
    { id: 0, bot: false, x: 0, z: 0, light: true, flickerLeft: 0, signal: 0 },
    { id: BOT_ID, bot: true, x: 10, z: 0, light: true, flickerLeft: 0, signal: 0 },
  ]
  const say = (by: number, voicePeople: number) => {
    const vs = createVoices(7)
    const out: VoiceEvent[] = []
    for (let i = 0; i < 300; i++) {
      const t = 50 + i / 30
      out.push(...stepVoices(vs, world, walkers, i === 0 ? [{ kind: "clue-found", by, x: 0, z: 0, what: "badge" }] : [], t, 1 / 30, { chatter: 0, voicePeople }, BOT_ID))
    }
    return out.map((e) => `${e.cast}:${lineOf(e.line).pool}`)
  }
  expect(say(BOT_ID, 1)[0]).toBe("walt:badge")
  expect(say(0, 1)[0]).toBe("owen:badge")
  expect(say(0, 1)[1]).toBe("walt:coming")
  expect(say(0, 0)).toEqual([])
})

test("sighting reactions survive chatter off and still respect their cooldown", () => {
  const walkers: Walker[] = [
    { id: 0, bot: false, x: 0, z: 0, light: true, flickerLeft: 0, signal: 0 },
    { id: BOT_ID, bot: true, x: 4, z: 0, light: true, flickerLeft: 0, signal: 0 },
  ]
  const vs = createVoices(7), out: VoiceEvent[] = []
  for (let i = 0; i < 600; i++) {
    const t = 50 + i / 30
    out.push(...stepVoices(vs, world, walkers, [{ kind: "creature", x0: 2, z0: 0, x1: 6, z1: 0, at: t, dur: 1 }], t, 1 / 30, FEEL))
  }
  expect(out.map((e) => lineOf(e.line).pool)).toEqual(["sighting", "sightreply"])
})

test("a quiet default night still stages one matching mimic call and answer deterministically", () => {
  const night = (uncanny = true) => {
    const state = createWoods(world, 1, 7)
    state.brains = [] // Hold both walkers still, out in the woods.
    Object.assign(state.players[0]!, { x: 100, z: -40 })
    Object.assign(state.players[1]!, { x: 100, z: -120 })
    state.t = 1500
    const events: (VoiceEvent | DistantEvent)[] = []
    for (let i = 0; i < 600 * 30; i++) {
      stepWoods(state, world, new Map(), 1 / 30, { ...FEEL, uncanny })
      for (const e of state.events) if (e.kind === "voice" || e.kind === "distant") events.push(e)
    }
    return { state, events }
  }
  const a = night(), b = night()
  expect(a).toEqual(b)
  const calls = a.events.filter((e): e is VoiceEvent => e.kind === "voice" && lineOf(e.line).pool === "call")
  const answers = a.events.filter((e): e is DistantEvent => e.kind === "distant" && e.sound === "far.mimic")
  expect(calls).toHaveLength(1)
  expect(answers).toHaveLength(1)
  expect(MIMIC_LINES[answers[0]!.take]).toBe(calls[0]!.line)
  expect(answers[0]!.at).toBeGreaterThan(calls[0]!.at + lineOf(calls[0]!.line).seconds)
  expect(night(false).events.filter((e) => e.kind === "voice" && lineOf(e.line).pool === "call")).toEqual([])
})

test("the opening: Walt and five calls the first night, two calls after, never your own searcher", () => {
  const y = world.camp.spawn.yaw, from = { x: world.camp.spawn.x, z: world.camp.spawn.z, fx: -Math.sin(y), fz: -Math.cos(y) }
  const first = openingLines(world, from, "owen", 1, 5)
  expect(first.map((e) => e.cast)).toEqual(["walt", "joyce", "gary", "tess", "dale", "walt"])
  expect(lineOf(first[0]!.line).pool).toBe("open")
  expect(openingLines(world, from, "owen", 1, 5)).toEqual(first)
  expect(openingLines(world, from, "owen", 3, 5).length).toBe(2)
  expect(openingLines(world, from, "walt", 1, 5).some((e) => e.cast === "walt")).toBe(false)
  // Some close, some far ahead.
  const d = first.map((e) => Math.hypot(e.x - from.x, e.z - from.z))
  expect(Math.min(...d)).toBeLessThan(15)
  expect(Math.max(...d)).toBeGreaterThan(100)
})

test("two players seated as different searchers hear the same opening takes from the others", () => {
  const y = world.camp.spawn.yaw, from = { x: world.camp.spawn.x, z: world.camp.spawn.z, fx: -Math.sin(y), fz: -Math.cos(y) }
  const owen = openingLines(world, from, "owen", 1, 9), tess = openingLines(world, from, "tess", 1, 9)
  const key = (e: VoiceEvent) => `${e.seq}:${e.line}`
  // Owen isn't in the opening, so Owen's client hears every beat; Tess's misses only her own.
  expect(tess.map(key)).toEqual(owen.filter((e) => e.cast !== "tess").map(key))
  expect(owen.some((e) => e.cast === "tess")).toBe(true)
})
