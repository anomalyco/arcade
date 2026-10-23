/**
 * The night's last beat (NIGHT.md "The verdict"): what took Barbara. The seed picks the culprit and one piece of evidence
 * on each of the first four clues; at the radio by the tower the group names it. Right wins; wrong strikes that suspect
 * and it starts taking searchers, one at a time, until it's named right or dawn. Plain data, only + − × ÷ √, no random
 * draws while stepping, so the room, solo play and every client agree.
 */
import type { NightState, NightWalker } from "./night"

export const SUSPECTS = ["figure", "spider", "bear", "man"] as const
export type Suspect = (typeof SUSPECTS)[number]
/** What the card and captions call each one. */
export const SUSPECT_NAMES: Record<Suspect, string> = { figure: "the tall one", spider: "the harvestman", bear: "a black bear", man: "R., the man in her book" }
/** One line on the naming card: what the searchers know of it. */
export const SUSPECT_LINES: Record<Suspect, string> = {
  figure: "The thin black shape crossing between the trees: too tall, too fast.",
  spider: "Something long-legged that keeps to the trunks and binds what it takes.",
  bear: "Black bears come down off the ridge in the fall, and they climb.",
  man: "She wrote \"6:00 R.\" in her book. Nobody knows who R. is.",
}
/** What can have taken her (the creatures the woods have); the bear and R. are the decoys. */
export const CULPRITS: readonly Suspect[] = ["figure", "spider"]

/** Clue ids the evidence lies with (`CLUE` in night.ts: car, page, badge, cassette). */
const CAR = 0, PAGE = 1, BADGE = 2, CASSETTE = 3
export type Evidence = { id: string; clue: number; text: string; /** Said by a bot naming a suspect for this reason. */ why: string; fits: readonly Suspect[] }
export const EVIDENCE: readonly Evidence[] = [
  { id: "roof", clue: CAR, text: "Long scrapes run across the roof, as if something climbed over it.", why: "something climbed right over her car", fits: ["figure", "spider", "bear"] },
  { id: "aerial", clue: CAR, text: "The car aerial is snapped off, and the end is gone.", why: "her aerial was snapped off", fits: ["figure", "spider", "man"] },
  { id: "high", clue: PAGE, text: "The tape is knotted round the trunk higher than anyone could reach.", why: "that tape was tied higher than any of us can reach", fits: ["figure", "spider"] },
  { id: "thread", clue: PAGE, text: "The page was torn and wound back on with fine grey thread.", why: "the page was wound on with grey thread", fits: ["spider", "man"] },
  { id: "bark", clue: PAGE, text: "The bark above it is scored in long lines, far over your head.", why: "the bark was scored way over our heads", fits: ["figure", "bear"] },
  { id: "scratch", clue: BADGE, text: "Four fine scratches run across her photo.", why: "those scratches on her badge", fits: ["figure", "bear"] },
  { id: "feet", clue: BADGE, text: "Round it, big prints in the mud, too far apart for anyone walking.", why: "those prints by her badge were too far apart", fits: ["figure", "bear"] },
  { id: "cut", clue: BADGE, text: "The lanyard wasn't snapped: it's cut clean.", why: "her lanyard was cut clean", fits: ["spider", "man"] },
  { id: "pins", clue: BADGE, text: "Round it, a ring of small deep holes in the mud, like tent-peg holes.", why: "that ring of holes round her badge", fits: ["spider", "man"] },
  { id: "tick", clue: CASSETTE, text: "Under her voice, all the way through, a dry ticking, like a great many small steps.", why: "that ticking on her tape", fits: ["spider"] },
  { id: "breath", clue: CASSETTE, text: "Under her voice, something breathing, close to the microphone and too slow.", why: "the breathing on her tape", fits: ["figure", "bear", "man"] },
  { id: "name", clue: CASSETTE, text: "At the very end, her own voice again, saying her own name, flat.", why: "her own voice saying her name at the end of the tape", fits: ["figure"] },
]

/** The night's answer and the evidence on each of the first four clues (indices into `EVIDENCE`). */
export type Verdict = { culprit: Suspect; evidence: number[] }

const fitsAll = (items: readonly number[], s: Suspect) => items.every((i) => EVIDENCE[i]!.fits.includes(s))
/** Suspects every one of `items` fits, struck ones left out. */
export function consistent(items: readonly number[], struck: readonly Suspect[] = []): Suspect[] {
  return SUSPECTS.filter((s) => !struck.includes(s) && fitsAll(items, s))
}

/**
 * From the seed: the culprit (one of `culprits`) and one item per clue, so that the culprit fits all four and nobody
 * else does, while the car with either the page or the badge still fits two or more (a group that hasn't shared
 * everything can name the wrong one).
 */
export function chooseVerdict(seed: number, culprits: readonly Suspect[] = CULPRITS): Verdict {
  const h = hash(seed, 0x51ca)
  const culprit = culprits[h % culprits.length] ?? "figure"
  const by = (clue: number) => EVIDENCE.map((e, i) => (e.clue === clue && e.fits.includes(culprit) ? i : -1)).filter((i) => i >= 0)
  const sets: number[][] = []
  for (const a of by(CAR)) for (const b of by(PAGE)) for (const c of by(BADGE)) for (const d of by(CASSETTE)) {
    const all = [a, b, c, d]
    if (consistent(all).length !== 1) continue
    if (consistent([a, b]).length < 2 || consistent([a, c]).length < 2) continue
    sets.push(all)
  }
  return { culprit, evidence: sets[hash(seed, 0x7e1d) % sets.length]! }
}

/** Evidence ids on a map that knows `clues`. */
export function evidenceKnown(v: Verdict, clues: readonly number[]): number[] {
  return v.evidence.filter((_, k) => clues.includes(k))
}

/** A bot's guess from what's on its map: one of the suspects that fit it all (struck ones out), picked by seed. */
export function botGuess(v: Verdict, clues: readonly number[], struck: readonly Suspect[], seed: number, id: number): Suspect {
  const fit = consistent(evidenceKnown(v, clues), struck)
  const pool = fit.length ? fit : SUSPECTS.filter((s) => !struck.includes(s))
  return pool[hash(seed ^ (id * 0x9e37), struck.length + 3) % pool.length]!
}

/** Why a bot names `s`: the item on its map that fits it and the fewest others. */
export function botReason(v: Verdict, clues: readonly number[], s: Suspect): string | null {
  const items = evidenceKnown(v, clues).map((i) => EVIDENCE[i]!).filter((e) => e.fits.includes(s))
  items.sort((a, b) => a.fits.length - b.fits.length)
  return items[0]?.why ?? null
}

/** An integer hash of the seed and a salt (+ × and shifts only). */
function hash(seed: number, salt: number): number {
  let x = Math.imul((seed | 0) ^ salt, 0x2c1b3c6d) >>> 0
  x = Math.imul(x ^ (x >>> 15), 0x297a2d39) >>> 0
  return (x ^ (x >>> 13)) >>> 0
}

// ---------------------------------------------------------------- naming and taking

/** How close to the radio you must stand to name it (m). */
export const RADIO_NEAR = 5
/** After a person's first vote, the other people have this long to vote (s). */
export const VOTE_WINDOW = 20
/** With only bots' votes in, they decide this long after the first (s), unless a person is within `WAIT_FOR` of the radio. */
export const BOT_WAIT = 45
export const WAIT_FOR = 25
/** After a wrong name: the first searcher is taken this long after (s), then one every `TAKE_EVERY`. */
export const TAKE_FIRST = 25
export const TAKE_EVERY = 60

export type Vote = { by: number; suspect: Suspect; at: number; bot: boolean; /** The event has been sent. */ said: boolean }
export type Gone = { id: number; x: number; z: number; yaw: number; at: number }
export type VerdictState = {
  votes: Vote[]
  /** Suspects named wrong, in order. */
  struck: Suspect[]
  /** Searchers taken, where and when (their torch lies there). */
  gone: Gone[]
  /** The next one is taken at this time (0: nothing is taking anyone). */
  takeAt: number
}
export const createVerdict = (): VerdictState => ({ votes: [], struck: [], gone: [], takeAt: 0 })

export type VerdictEvent =
  | { kind: "vote"; by: number; suspect: Suspect; why: string | null }
  | { kind: "verdict"; suspect: Suspect; right: boolean; at: number }
  | { kind: "taken"; by: number; x: number; z: number; at: number }

export const isGone = (n: Pick<NightState, "verdict">, id: number) => n.verdict.gone.some((g) => g.id === id)
/** The radio by the tower is live once the extra searcher's strip has been found. */
export const radioLive = (n: Pick<NightState, "finds">) => n.finds.some((f) => f.clue === 4)
const dist = (ax: number, az: number, bx: number, bz: number) => Math.sqrt((ax - bx) * (ax - bx) + (az - bz) * (az - bz))

/** Whether `w` can name it now: the radio is live, they're at it, still here, and `s` isn't struck. */
export function canVote(n: NightState, w: Pick<NightWalker, "id" | "x" | "z">, s?: Suspect): boolean {
  if (n.phase !== "search" || !radioLive(n) || isGone(n, w.id)) return false
  if (s && n.verdict.struck.includes(s)) return false
  return dist(w.x, w.z, n.layout.radio.x, n.layout.radio.z) <= RADIO_NEAR + 1
}

/**
 * A walker names `s` at the radio (a person's message, or a bot from `stepVerdict`). Their latest vote counts; naming
 * the same one again changes nothing, and a changed vote keeps its first time (so it can't hold the window open).
 */
export function castVote(n: NightState, w: Pick<NightWalker, "id" | "x" | "z" | "bot">, s: Suspect, t: number): boolean {
  if (!SUSPECTS.includes(s) || !canVote(n, w, s)) return false
  const v = n.verdict, prev = v.votes.find((q) => q.by === w.id)
  if (prev?.suspect === s) return false
  v.votes = v.votes.filter((q) => q.by !== w.id)
  v.votes.push({ by: w.id, suspect: s, at: prev?.at ?? t, bot: w.bot, said: false })
  n.rev++
  return true
}

/** Plurality of `votes`, ties to `tie`'s plurality, then to the earliest vote, then to the lowest voter id. */
export function tally(votes: readonly Vote[], tie: readonly Vote[]): Suspect {
  const count = (list: readonly Vote[], s: Suspect) => list.filter((q) => q.suspect === s).length
  const first = (s: Suspect) => Math.min(...votes.filter((q) => q.suspect === s).map((q) => q.at))
  const lowest = (s: Suspect) => Math.min(...votes.filter((q) => q.suspect === s).map((q) => q.by))
  const named = [...new Set(votes.map((q) => q.suspect))]
  named.sort((a, b) => count(votes, b) - count(votes, a) || count(tie, b) - count(tie, a) || first(a) - first(b) || lowest(a) - lowest(b))
  return named[0]!
}

/**
 * One tick of the verdict, during the search with everyone still here (`active`): bots at the radio vote, the votes
 * are decided, a wrong name starts the taking. Returns "named" when it was named right, "taken" when nobody is left.
 */
export function stepVerdict(n: NightState, active: readonly NightWalker[], t: number, events: VerdictEvent[]): "" | "named" | "taken" {
  const v = n.verdict, verdict = n.layout.verdict
  if (radioLive(n)) {
    // Bots at the radio name what fits their map, and change their minds as the others' maps fill theirs in.
    for (const w of active) {
      if (!w.bot || !canVote(n, w)) continue
      const guess = botGuess(verdict, w.map.clues, v.struck, n.seed, w.id)
      if (v.votes.find((q) => q.by === w.id)?.suspect !== guess) castVote(n, w, guess, t)
    }
    for (const q of v.votes) {
      if (q.said) continue
      q.said = true
      const w = active.find((a) => a.id === q.by)
      events.push({ kind: "vote", by: q.by, suspect: q.suspect, why: q.bot && w ? botReason(verdict, w.map.clues, q.suspect) : null })
    }
    const people = active.filter((w) => !w.bot)
    const pv = v.votes.filter((q) => !q.bot), bv = v.votes.filter((q) => q.bot)
    let named: Suspect | null = null
    if (pv.length && (people.every((p) => pv.some((q) => q.by === p.id)) || t >= Math.min(...pv.map((q) => q.at)) + VOTE_WINDOW)) named = tally(pv, bv)
    else if (!pv.length && bv.length) {
      const coming = people.some((p) => dist(p.x, p.z, n.layout.radio.x, n.layout.radio.z) < WAIT_FOR)
      if (!coming && t >= Math.min(...bv.map((q) => q.at)) + BOT_WAIT) named = tally(bv, [])
    }
    if (named) {
      const right = named === verdict.culprit
      events.push({ kind: "verdict", suspect: named, right, at: t })
      v.votes = []
      n.rev++
      if (right) return "named"
      v.struck.push(named)
      if (!v.takeAt) v.takeAt = t + TAKE_FIRST
    }
  }
  if (v.takeAt > 0 && t >= v.takeAt) {
    // The one furthest from anyone else goes first (ties: the lower id).
    let victim: NightWalker | null = null, far = -1
    for (const w of active) {
      let near = Infinity
      for (const o of active) if (o !== w) near = Math.min(near, dist(w.x, w.z, o.x, o.z))
      if (near > far || (near === far && victim && w.id < victim.id)) { far = near; victim = w }
    }
    if (victim) {
      victim.light = false
      v.gone.push({ id: victim.id, x: victim.x, z: victim.z, yaw: victim.yaw, at: t })
      v.votes = v.votes.filter((q) => q.by !== victim!.id)
      events.push({ kind: "taken", by: victim.id, x: victim.x, z: victim.z, at: t })
      n.rev++
    }
    v.takeAt = t + TAKE_EVERY
    if (active.length <= 1) return "taken"
  }
  return ""
}
