import { VOICE_LINES } from "./lines.gen"
import type { ClueKind } from "./night"
import { NIGHT_LINES, type NightLine } from "./night-lines.gen"
import { nextRandom, terrainHeight, type WoodsWorld } from "./world"

/**
 * The search party's voices (STORY.md): who is which searcher, and who says what, when, from where.
 *
 * Like `distant.ts`, the schedule is plain seeded data stepped in `stepWoods` with only + − × ÷ √ and `nextRandom`, so
 * a room's sim and every client agree: the same line from the same place at the same emission time. Clients add travel
 * delay, distance, trees in the way and reverb, and the subtitle.
 *
 * Mostly silence. One voice at a time, a few lines a minute at most, more often a long gap; nobody talks over a distant
 * sound or a signal, and the woods' distant sounds wait for the voices. People's own searchers stay off-mic apart from
 * key moments (a find, a sighting), and not even then with `voicePeople` 0.
 */

export const CAST = ["walt", "joyce", "gary", "dale", "tess", "owen"] as const
export type CastId = (typeof CAST)[number]
export const CAST_NAMES: Readonly<Record<CastId, string>> = { walt: "Walt", joyce: "Joyce", gary: "Gary", dale: "Dale", tess: "Tess", owen: "Owen" }
/** Every voice a line can be in: the searchers, and Barbara on her cassette (`shared/night.ts`). */
export type Voice = CastId | "barbara"
export const VOICE_NAMES: Readonly<Record<Voice, string>> = { ...CAST_NAMES, barbara: "Barbara (tape)" }
/** How loud a line is where it's said: a full shout carries through the woods, quiet words barely reach the next person. */
export type Loudness = "shout" | "call" | "talk" | "quiet"
export const POOLS = [
  "open", "call", "ask", "answer", "keep", "where", "here", "hear", "dismiss", "tape", "torch", "apart", "regroup", "light", "sighting", "sightreply", "clue", "coming", "bark",
  // The night's (NIGHT.md): a reaction to each clue, dawn coming and come, the cassette, and the extra searcher's call.
  "car", "page", "badge", "cassette", "strip", "dawn", "daylight", "tape-tower", "extra", "taken",
] as const
export type Pool = (typeof POOLS)[number]

/** People take searchers in this order; bots (by id) take these. Solo, you are Owen. */
const PEOPLE_ORDER: readonly CastId[] = ["owen", "tess", "dale", "gary", "walt", "joyce"]
export const BOT_ORDER: readonly CastId[] = ["walt", "joyce", "gary", "dale", "tess"]

export type VoiceEvent = {
  kind: "voice"
  line: string
  cast: Voice
  /** The walker saying it, or −1 for a searcher out in the woods nobody plays. */
  by: number
  /** Where it's said (m), mouth height. */
  x: number
  y: number
  z: number
  /** Sim time it's said at the source (s); a listener d metres away hears it d / 343 s later. */
  at: number
  seq: number
}

type Planned = { at: number; cast: CastId; pool: Pool; key?: boolean; near?: { x: number; z: number } }
type Roamer = { cast: CastId; x: number; z: number; hx: number; hz: number; turn: number }

export type VoiceState = {
  rng: { seed: number }
  seq: number
  /** Sim time the director next thinks about starting some chatter. */
  next: number
  /** Nobody starts a line before this: someone is speaking (travel to the furthest listener included). */
  busyUntil: number
  queue: Planned[]
  /** Last time each searcher spoke (by `CAST` index). */
  last: number[]
  /** Lines said lately, not repeated. */
  recent: string[]
  roamers: Roamer[]
  /** Cooldowns by context (sim time it's allowed again). */
  cool: Record<string, number>
  /** Walkers whose torch was already flickering last step, so a new dip is noticed once. */
  flicker: number[]
  /** A person on their own since this sim time (by player id). */
  alone: Record<number, number>
}

export type VoiceFeel = { chatter: number; voicePeople: number }

/** The walkers the director needs to see (the sim's `Player` fits). */
export type Walker = { id: number; bot: boolean; x: number; z: number; light: boolean; flickerLeft: number; signal: number }
export type VoiceCue =
  | { kind: "tape-tied"; by: number; x: number; z: number }
  | { kind: "clue-found"; by: number; x: number; z: number; what: ClueKind }
  | { kind: "dawn" }
  | { kind: "daylight" }
  | { kind: "signal"; by: number; x: number; z: number }
  | { kind: "distant"; x: number; z: number; at: number }
  | { kind: "creature"; x0: number; z0: number; x1: number; z1: number; at: number; dur: number }

const SPEED_OF_SOUND = 343
const MOUTH = 1.6
/** How far each loudness carries before it's not worth saying (m): it also bounds who reacts. */
const CARRY: Record<Loudness, number> = { shout: 400, call: 160, talk: 30, quiet: 12 }

export function createVoices(seed: number): VoiceState {
  const rng = { seed: (seed * 2246822519) | 0 }
  // The first chatter comes after the opening (the client's) has had its time.
  return { rng, seq: 0, next: 40 + 20 * nextRandom(rng), busyUntil: 0, queue: [], last: CAST.map(() => -1e9), recent: [], roamers: [], cool: {}, flicker: [], alone: {} }
}

/** Who plays whom: bots by id, people by id from what's left; the rest are out in the woods. */
export function voiceRoles(walkers: readonly { id: number; bot: boolean }[], botBase = 100): { byWalker: Map<number, CastId>; roaming: CastId[] } {
  const byWalker = new Map<number, CastId>(), used = new Set<CastId>()
  for (const w of [...walkers].filter((w) => w.bot).sort((a, b) => a.id - b.id)) {
    const c = BOT_ORDER[(w.id - botBase) % BOT_ORDER.length]!
    if (!used.has(c)) { byWalker.set(w.id, c); used.add(c) }
  }
  for (const w of [...walkers].filter((w) => !w.bot).sort((a, b) => a.id - b.id)) {
    const c = PEOPLE_ORDER.find((c) => !used.has(c))
    if (c) { byWalker.set(w.id, c); used.add(c) }
  }
  return { byWalker, roaming: CAST.filter((c) => !used.has(c)) }
}

const ALL_LINES: readonly NightLine[] = [...VOICE_LINES, ...NIGHT_LINES]
const linesOf = (cast: Voice, pool: Pool) => ALL_LINES.filter((l) => l.cast === cast && l.pool === pool)
/** A line by id, from the searchers' or the night's. */
export const lineOf = (id: string): NightLine | undefined => ALL_LINES.find((l) => l.id === id)
const dist = (ax: number, az: number, bx: number, bz: number) => Math.sqrt((ax - bx) * (ax - bx) + (az - bz) * (az - bz))

/** A random unit direction by rejection sampling (no trig, so every engine agrees). */
function direction(rng: { seed: number }): [number, number] {
  for (let i = 0; i < 16; i++) {
    const x = nextRandom(rng) * 2 - 1, z = nextRandom(rng) * 2 - 1
    const l = Math.sqrt(x * x + z * z)
    if (l > 0.2 && l <= 1) return [x / l, z / l]
  }
  return [1, 0]
}

/** Searchers nobody plays wander 50–140 m out from the people, mostly away from camp, at a walking pace. */
function stepRoamers(vs: VoiceState, world: WoodsWorld, roaming: readonly CastId[], people: readonly Walker[], dt: number) {
  vs.roamers = vs.roamers.filter((r) => roaming.includes(r.cast))
  if (!people.length) return
  let cx = 0, cz = 0
  for (const p of people) { cx += p.x; cz += p.z }
  cx /= people.length; cz /= people.length
  const half = world.params.half - 10
  for (const cast of roaming) {
    let r = vs.roamers.find((r) => r.cast === cast)
    if (!r) {
      // Out ahead: away from camp from wherever the people are, spread to the sides.
      let ax = cx - world.camp.x, az = cz - world.camp.z
      const al = Math.sqrt(ax * ax + az * az)
      if (al < 1) { ax = 0; az = -1 } else { ax /= al; az /= al }
      const [sx, sz] = direction(vs.rng)
      const d = 55 + 60 * nextRandom(vs.rng)
      let x = cx + (ax * 0.8 + sx * 0.6) * d, z = cz + (az * 0.8 + sz * 0.6) * d
      x = Math.max(-half, Math.min(half, x)); z = Math.max(-half, Math.min(half, z))
      r = { cast, x, z, hx: sx, hz: sz, turn: 0 }
      vs.roamers.push(r)
    }
    r.turn -= dt
    if (r.turn <= 0) {
      const [sx, sz] = direction(vs.rng)
      const d = dist(r.x, r.z, cx, cz)
      // Drift back in when far, out when close.
      const pull = d > 140 ? -1 : d < 50 ? 1 : 0
      r.hx = sx + (pull * (r.x - cx)) / Math.max(d, 1); r.hz = sz + (pull * (r.z - cz)) / Math.max(d, 1)
      const l = Math.sqrt(r.hx * r.hx + r.hz * r.hz) || 1
      r.hx /= l; r.hz /= l
      r.turn = 6 + 10 * nextRandom(vs.rng)
    }
    r.x = Math.max(-half, Math.min(half, r.x + r.hx * 0.9 * dt))
    r.z = Math.max(-half, Math.min(half, r.z + r.hz * 0.9 * dt))
  }
}

type Speaker = { cast: CastId; by: number; x: number; z: number; person: boolean }

function speakers(walkers: readonly Walker[], roles: ReturnType<typeof voiceRoles>, roamers: readonly Roamer[], silent?: (id: number) => boolean): Speaker[] {
  const out: Speaker[] = []
  for (const w of walkers) { const c = roles.byWalker.get(w.id); if (c && !silent?.(w.id)) out.push({ cast: c, by: w.id, x: w.x, z: w.z, person: !w.bot }) }
  for (const r of roamers) out.push({ cast: r.cast, by: -1, x: r.x, z: r.z, person: false })
  return out
}

/** The trailhead belongs to the opening (the client's) for this long: only key moments before it. */
export const OPENING_SECONDS = 30

function plan(vs: VoiceState, p: Planned) {
  if (vs.queue.length < 6) vs.queue.push(p)
}

/** The nearest searcher (not a person unless `key`) to a point, within `range`, other than `not`. */
function nearestTo(all: readonly Speaker[], x: number, z: number, range: number, opts: { key?: boolean; not?: CastId; people: boolean }): Speaker | null {
  let best: Speaker | null = null, bd = range
  for (const s of all) {
    if (s.cast === opts.not || (s.person && !(opts.key && opts.people))) continue
    const d = dist(s.x, s.z, x, z)
    if (d < bd) { bd = d; best = s }
  }
  return best
}

/**
 * One step of the voices at sim time `t`: reactions to this step's `cues`, chatter when it's due, and whatever is
 * planned for now. Returns the lines that start now.
 */
export function stepVoices(vs: VoiceState, world: WoodsWorld, walkers: readonly Walker[], cues: readonly VoiceCue[], t: number, dt: number, feel: VoiceFeel, botBase = 100, silent?: (id: number) => boolean): VoiceEvent[] {
  const people = walkers.filter((w) => !w.bot)
  if (!people.length) return []
  const roles = voiceRoles(walkers, botBase)
  stepRoamers(vs, world, roles.roaming, people, dt)
  // Roles come from everyone (so nobody's voice changes when someone is taken); the taken say nothing.
  const all = speakers(walkers, roles, vs.roamers, silent)
  const keyPeople = feel.voicePeople > 0
  const roll = () => nextRandom(vs.rng)
  // Chatter 0 (and the opening) leaves only key moments: a find, a sighting.
  const talk = feel.chatter > 0 && t >= OPENING_SECONDS
  const okAt = (k: string, every: number) => { if (!talk || (vs.cool[k] ?? -1e9) > t) return false; vs.cool[k] = t + every; return true }

  // ── reactions ──
  for (const c of cues) {
    if (c.kind === "clue-found") {
      // The finder says what it is, in their own words; someone near answers.
      const finder = all.find((s) => s.by === c.by)
      if (finder && (!finder.person || keyPeople)) {
        plan(vs, { at: t + 0.4, cast: finder.cast, pool: c.what, key: true })
        const other = nearestTo(all, c.x, c.z, 160, { not: finder.cast, people: keyPeople })
        if (other && c.what !== "strip") plan(vs, { at: t + 0.5, cast: other.cast, pool: "coming", key: true })
      }
    } else if (c.kind === "dawn" || c.kind === "daylight") {
      // Whoever has a line for it and isn't one of the people (Walt first).
      const s = (["walt", "joyce", "gary"] as const).map((k) => all.find((x) => x.cast === k && !x.person)).find((x) => x && linesOf(x.cast, c.kind).length)
      if (s) plan(vs, { at: t + 0.2, cast: s.cast, pool: c.kind, key: true })
    } else if (c.kind === "creature") {
      // Shaken and quiet, from whoever is nearest the crossing, while it crosses.
      const mx = (c.x0 + c.x1) / 2, mz = (c.z0 + c.z1) / 2
      const s = nearestTo(all, mx, mz, 70, { key: true, people: keyPeople })
      if (s && okAt("sighting", 90)) {
        plan(vs, { at: c.at + c.dur * 0.6, cast: s.cast, pool: "sighting", key: true })
        const o = nearestTo(all, s.x, s.z, 25, { not: s.cast, key: true, people: keyPeople })
        if (o) plan(vs, { at: c.at + c.dur * 0.6 + 0.3, cast: o.cast, pool: "sightreply", key: true })
      }
    } else if (c.kind === "signal") {
      const s = nearestTo(all, c.x, c.z, 200, { not: all.find((x) => x.by === c.by)?.cast, people: false })
      if (s && okAt("light", 70) && roll() < 0.7) plan(vs, { at: t + 1.2, cast: s.cast, pool: roll() < 0.5 ? "light" : "coming" })
    } else if (c.kind === "distant") {
      // Nobody talks over it.
      vs.busyUntil = Math.max(vs.busyUntil, c.at + 5)
      if (!talk) continue
      // Someone near the people noticed, once it has reached them.
      const p = people[0]!
      const s = nearestTo(all, p.x, p.z, 45, { people: false })
      if (s && okAt("hear", 80) && roll() < 0.55) {
        const heard = c.at + dist(c.x, c.z, s.x, s.z) / SPEED_OF_SOUND + 1.6
        plan(vs, { at: heard, cast: s.cast, pool: "hear" })
        if (roll() < 0.5) { const o = nearestTo(all, s.x, s.z, 40, { not: s.cast, people: false }); if (o) plan(vs, { at: heard + 0.3, cast: o.cast, pool: "dismiss" }) }
      }
    } else if (c.kind === "tape-tied") {
      // A bot coming across tape isn't modelled yet: someone near a fresh tape remarks on it, now and then.
      const s = nearestTo(all, c.x, c.z, 20, { not: all.find((x) => x.by === c.by)?.cast, people: false })
      if (s && okAt("tape", 75) && roll() < 0.3) plan(vs, { at: t + 2, cast: s.cast, pool: "tape" })
    }
  }
  // A torch starting to die.
  const flickering = walkers.filter((w) => w.light && w.flickerLeft > 0).map((w) => w.id)
  for (const id of flickering) {
    if (vs.flicker.includes(id)) continue
    const s = all.find((x) => x.by === id)
    if (s && !s.person && okAt("torch", 150) && roll() < 0.45) plan(vs, { at: t + 0.3, cast: s.cast, pool: "torch" })
  }
  vs.flicker = flickering
  // A person on their own for a while: someone out there calls for the group.
  for (const p of people) {
    if (!talk) break
    const near = walkers.some((w) => w.id !== p.id && dist(w.x, w.z, p.x, p.z) < 60)
    if (near) { delete vs.alone[p.id]; continue }
    vs.alone[p.id] ??= t
    if (t - vs.alone[p.id]! > 25 && okAt("apart", 150)) {
      const s = nearestTo(all, p.x, p.z, 260, { people: false })
      if (s) {
        plan(vs, { at: t, cast: s.cast, pool: roll() < 0.5 ? "apart" : "where" })
        if (roll() < 0.6) plan(vs, { at: t + 0.4, cast: s.cast, pool: "regroup" })
      }
    }
  }

  // ── chatter ──
  if (talk && t >= vs.next && !vs.queue.length) {
    vs.next = t + (30 + 40 * roll()) / feel.chatter
    const npc = all.filter((s) => !s.person)
    if (npc.length) {
      const p = people[Math.floor(roll() * people.length) % people.length]!
      const byDist = [...npc].sort((a, b) => dist(a.x, a.z, p.x, p.z) - dist(b.x, b.z, p.x, p.z))
      const far = byDist.filter((s) => dist(s.x, s.z, p.x, p.z) > 25)
      const near = byDist.filter((s) => dist(s.x, s.z, p.x, p.z) <= 25)
      const r = roll()
      if (r < 0.5 && far.length) {
        // Somebody out there calls her name; sometimes another answers them.
        const a = far[Math.floor(roll() * far.length)]!
        plan(vs, { at: t, cast: a.cast, pool: "call" })
        const b = npc.find((s) => s.cast !== a.cast && dist(s.x, s.z, a.x, a.z) < 160)
        if (b && roll() < 0.45) plan(vs, { at: t + 0.6, cast: b.cast, pool: "answer" })
      } else if (r < 0.75 && npc.length >= 2) {
        // Checking in: "Anything?" "Nothing." "Keep going."
        const a = npc[Math.floor(roll() * npc.length)]!
        const b = npc.find((s) => s.cast !== a.cast && dist(s.x, s.z, a.x, a.z) < 160)
        if (b) {
          plan(vs, { at: t, cast: a.cast, pool: "ask" })
          plan(vs, { at: t + 0.5, cast: b.cast, pool: "answer" })
          if (roll() < 0.5) plan(vs, { at: t + 1, cast: a.cast, pool: "keep" })
        }
      } else if (r < 0.88 && far.length) {
        const a = far[0]!
        plan(vs, { at: t, cast: a.cast, pool: "where" })
        const b = npc.find((s) => s.cast !== a.cast)
        if (b) plan(vs, { at: t + 0.5, cast: b.cast, pool: "here" })
      } else if (near.length) {
        plan(vs, { at: t, cast: near[0]!.cast, pool: "keep" })
      }
    }
  }

  // ── speak ──
  const out: VoiceEvent[] = []
  vs.queue.sort((a, b) => a.at - b.at)
  while (vs.queue.length && vs.queue[0]!.at <= t && t >= vs.busyUntil) {
    const p = vs.queue.shift()!
    const s = all.find((x) => x.cast === p.cast)
    if (!s || (s.person && !(p.key && keyPeople))) continue
    // Only lines loud enough to reach somebody: nobody mutters to themselves 200 m from anyone.
    let near = Infinity
    for (const w of people) if (w.id !== s.by) near = Math.min(near, dist(s.x, s.z, w.x, w.z))
    if (s.person) near = Math.min(near, ...walkers.filter((w) => w.id !== s.by).map((w) => dist(s.x, s.z, w.x, w.z)))
    const reach = linesOf(p.cast, p.pool).filter((l) => CARRY[l.loud] >= near)
    const fresh = reach.filter((l) => !vs.recent.includes(l.id))
    // Out of fresh lines, a key moment repeats one; anything else stays quiet.
    const line = fresh.length ? fresh[Math.floor(roll() * fresh.length) % fresh.length]! : p.key ? reach[0] : undefined
    if (!line) continue
    out.push(say(vs, world, line, s, people, t))
    break
  }
  // Stale plans (their moment has passed by a long way) are dropped.
  vs.queue = vs.queue.filter((p) => t - p.at < 20)
  return out
}

function say(vs: VoiceState, world: WoodsWorld, line: NightLine, s: Pick<Speaker, "by" | "x" | "z">, people: readonly Walker[], t: number): VoiceEvent {
  let reach = 0
  for (const p of people) reach = Math.max(reach, Math.min(dist(s.x, s.z, p.x, p.z), CARRY[line.loud]))
  // The next line waits for this one to reach everyone and end, then a breath.
  vs.busyUntil = t + reach / SPEED_OF_SOUND + line.seconds + 0.5
  if (line.cast !== "barbara") vs.last[CAST.indexOf(line.cast)] = t
  vs.recent.push(line.id)
  if (vs.recent.length > 14) vs.recent.shift()
  const cm = (v: number) => Math.round(v * 100) / 100
  return { kind: "voice", line: line.id, cast: line.cast, by: s.by, x: cm(s.x), y: cm(terrainHeight(world.terrain, s.x, s.z) + MOUTH), z: cm(s.z), at: Math.round(t * 1000) / 1000, seq: vs.seq++ }
}

/** Barbara's cassette, played from the hand of whoever found it (`shared/night.ts`): where she said she was going. */
export function sayTape(vs: VoiceState, world: WoodsWorld, from: { id: number; x: number; z: number }, walkers: readonly Walker[], t: number): VoiceEvent {
  const line = linesOf("barbara", "tape-tower")[0]!
  return say(vs, world, line, { by: from.id, x: from.x, z: from.z }, walkers.filter((w) => !w.bot), t)
}

/** The extra searcher (STORY.md key moment 5): Walt's voice shouting "Over here!" from the ridge, where none of them is. */
export function sayExtra(vs: VoiceState, world: WoodsWorld, x: number, z: number, walkers: readonly Walker[], t: number): VoiceEvent {
  const line = linesOf("walt", "extra")[0]!
  return say(vs, world, line, { by: -1, x, z }, walkers.filter((w) => !w.bot), t)
}

/** A searcher taken (`verdict.ts`): one short cut-off cry from where they stood, in their own voice. */
export function sayTaken(vs: VoiceState, world: WoodsWorld, cast: CastId, at: { by: number; x: number; z: number }, walkers: readonly Walker[], t: number): VoiceEvent | null {
  const line = linesOf(cast, "taken")[0]
  return line ? say(vs, world, line, at, walkers.filter((w) => !w.bot), t) : null
}

/** Until when the woods' distant sounds should wait for the voices (`holdDistant`). */
export const voicesBusyUntil = (vs: VoiceState) => vs.busyUntil

/**
 * The opening at the trailhead, as lines relative to Begin (`at` in seconds from it), placed around `from` facing
 * `(fx, fz)` (a unit plan direction): Walt sends everyone out, then calls for Barbara near, to the side and far ahead.
 * `night` 2 and later get two calls. Each client plays it at its own Begin; it's seeded by the room so everyone hears
 * the same lines.
 */
export function openingLines(world: WoodsWorld, from: { x: number; z: number; fx: number; fz: number }, me: CastId | null, night: number, seed: number): VoiceEvent[] {
  const rng = { seed: (seed * 3266489917) | 0 }
  const fx = from.fx, fz = from.fz, rx = -fz, rz = fx
  const at = (ahead: number, right: number) => ({ x: from.x + fx * ahead + rx * right, z: from.z + fz * ahead + rz * right })
  const beats: { t: number; cast: CastId; pool: Pool; ahead: number; right: number }[] = night <= 1
    ? [
        { t: 0.8, cast: "walt", pool: "open", ahead: 3, right: -3 },
        { t: 5.2, cast: "joyce", pool: "call", ahead: 9, right: 6 },
        { t: 8.6, cast: "gary", pool: "call", ahead: 55, right: -12 },
        { t: 12.4, cast: "tess", pool: "call", ahead: 24, right: 32 },
        { t: 16.5, cast: "dale", pool: "call", ahead: 150, right: 30 },
        { t: 20.5, cast: "walt", pool: "call", ahead: 18, right: -14 },
      ]
    : [
        { t: 0.8, cast: "joyce", pool: "call", ahead: 9, right: 6 },
        { t: 4.6, cast: "gary", pool: "call", ahead: 70, right: -12 },
      ]
  const out: VoiceEvent[] = []
  let seq = -1000
  for (const b of beats) {
    // Every beat draws its take and seq, said or not, so players seated as different searchers hear the same takes.
    const pool = linesOf(b.cast, b.pool)
    const line = pool[Math.floor(nextRandom(rng) * pool.length) % Math.max(1, pool.length)]
    const n = seq++
    if (b.cast === me || !line) continue
    const p = at(b.ahead, b.right)
    out.push({ kind: "voice", line: line.id, cast: b.cast, by: -1, x: p.x, y: terrainHeight(world.terrain, p.x, p.z) + MOUTH, z: p.z, at: b.t, seq: n })
  }
  return out
}
