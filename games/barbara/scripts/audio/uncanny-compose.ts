// Composes the uncanny tier from curated ingredients (see uncanny.ts). Each recipe is a fixed edit list over named takes,
// so `compose` reproduces the same files from the same work directory.
import { $ } from "bun"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { decode } from "../../../../scripts/sfx/decode"
import { MIMIC_LINES } from "../../shared/distant"
import { bend, cut, envelope, levelTo, mix, peak, pitchTrack, scale, silence, slice, SR, stretch, varispeed } from "./dsp"
import { take, work } from "./uncanny"

const game = new URL("../../", import.meta.url).pathname

type Ingredient = { source: string; prompt: string; requestId: string | null }
type Composed = { x: Float32Array; note: string; from: Ingredient[] }

const used: Ingredient[] = []
function src(id: string, n: number): Float32Array {
  const t = take(id, n)
  used.push({ source: `${id} take ${n}`, prompt: t.prompt, requestId: t.requestId })
  return t.x
}
async function shipped(file: string, source: string): Promise<Float32Array> {
  used.push({ source, prompt: "", requestId: null })
  return (await decode(join(game, "public/audio", file), 1))[0]!
}
function done(x: Float32Array, note: string): Composed {
  const from = used.splice(0)
  return { x, note, from }
}

/** Smooth 0..1..0 window over [a, b] with `edge` s ramps. */
const window = (t: number, a: number, b: number, edge = 0.08) => (t < a - edge || t > b + edge ? 0 : t < a ? (t - a + edge) / edge : t > b ? 1 - (t - b) / edge : 1)

/** The f0 (Hz) of x at time t from a track, holding the last voiced value. */
function f0At(track: ReturnType<typeof pitchTrack>, t: number, fallback: number): number {
  let best = fallback
  for (const f of track) { if (f.t > t) break; if (f.f0) best = f.f0 }
  return best
}

// ── the howl that becomes more than a howl ──────────────────────────────────────────────────────────────────────

/** A wolf's howl that keeps going and turns into a woman's held vowel along the same falling note, then stops dead. */
function howlVoice(): Composed {
  const howl = src("src.wolf", 2), wail = src("src.wail", 1)
  // 0–2.2 s as recorded, then the rest of the glide drawn out 2.2× (one breath, much too long).
  const h = levelTo(stretch(howl, (t) => (t < 2.2 ? 1 : 2.2)), -14)
  const ht = pitchTrack(h, 960)
  const T1 = 3.6, T2 = 7.2, T3 = 10.4
  // The voice follows the howl's note from T1, so the timbre changes and the pitch doesn't.
  const w0 = 0.35
  const wseg = slice(wail, w0, w0 + (T3 - T1) + 0.4)
  const wt = pitchTrack(wseg, 960)
  const v = levelTo(bend(wseg, (t) => 1200 * Math.log2(f0At(ht, T1 + t, 380) / f0At(wt, t, 370))), -15)
  const hx = envelope(h, [[0, 1], [T1 + 0.8, 1], [T2, 0]])
  const vx = envelope(v, [[0, 0], [1.2, 0.35], [T2 - T1, 1], [T3 - T1, 1]])
  return done(cut(mix([{ x: hx, at: 0 }, { x: vx, at: T1 }]), T3), "a wolf's howl that doesn't stop for breath; halfway through it becomes a woman holding the same falling note, then cuts off mid-note")
}

/** A coyote's howl that won't end; its note climbs an octave and becomes a woman's scream, which falls and stops dead. */
function howlScream(): Composed {
  const howl = src("src.coyote", 3), scream = src("src.morph", 1)
  const h = levelTo(stretch(howl, (t) => (t < 1.6 ? 1 : 2)), -14)
  const ht = pitchTrack(h, 960)
  const T1 = 2.4, T2 = 5.6, END = T2 + 3
  const ease = (k: number) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k))
  // The howl's note climbs to where the scream picks it up (about 1190 Hz), which carries on up to its top, holds and falls.
  const target = (t: number) => 725 * (1190 / 725) ** ease((t - T1) / (T2 - T1))
  const hb = bend(h, (t) => (t < T1 ? 0 : 1200 * Math.log2(target(t) / f0At(ht, t, 725))))
  const s = levelTo(slice(scream, 4.05, 7.2), -14)
  const hx = envelope(hb, [[0, 1], [T2 - 0.15, 1], [T2 + 0.6, 0]])
  const sx = envelope(s, [[0, 0], [0.15, 0.5], [0.75, 1]])
  return done(cut(mix([{ x: hx, at: 0 }, { x: sx, at: T2 - 0.15 }]), END), "a coyote's howl that won't end; its note slowly climbs and a woman's scream takes it over, holds and falls, and stops dead mid-note")
}

/** A coyote's howl that splits into two voices drifting out of tune with each other, then stops dead. */
function howlSplit(): Composed {
  const howl = src("src.coyote", 5)
  const h = levelTo(stretch(howl, (t) => (t < 1.6 ? 1 : 1.8)), -14)
  const S = 3.4, END = 9.2
  const a = bend(h, (t) => (t < S ? 0 : 30 * Math.min(1, (t - S) / 4)))
  const b = bend(h, (t) => (t < S ? 0 : -120 * Math.min(1, (t - S) / 4.5) ** 1.3))
  const bx = envelope(b, [[0, 0], [S, 0], [S + 0.9, 0.8]])
  return done(cut(mix([{ x: a, at: 0, gain: 0.8 }, { x: bx, at: 0.028 }]), END), "a coyote's howl that splits into two of the same voice, drifting out of tune against each other, then stops dead")
}

/** A coyote's howl drawn out far past any breath, sinking, and cut off while it's still loud. */
function howlLong(): Composed {
  const howl = src("src.coyote", 2)
  const h = levelTo(stretch(howl, (t) => (t < 1.8 ? 1 : t < 5.2 ? 2.6 : 1.4)), -14)
  return done(cut(h, 11.6), "a coyote's howl drawn out to three times its breath, still sinking when it stops dead")
}

// ── an animal getting got ───────────────────────────────────────────────────────────────────────────────────────

/** Cry, a struggle in the brush, a second cry cut off by a heavy impact and a crack; then nothing. */
function taken(o: { cry: Float32Array; cry2?: Float32Array; cry2At?: number; thrash: Float32Array; thrashAt: number; impact: Float32Array; crack: Float32Array; at: number }, note: string): Composed {
  const end = o.at
  const parts = [
    { x: cut(levelTo(o.cry, -13), end), at: 0 },
    { x: cut(envelope(levelTo(o.thrash, -19), [[0, 0], [0.05, 1]]), end - o.thrashAt + 0.06, 30), at: o.thrashAt },
    { x: levelTo(o.impact, -11), at: end },
    { x: levelTo(o.crack, -15), at: end + 0.025 },
  ]
  if (o.cry2) parts.push({ x: cut(levelTo(o.cry2, -12), end - o.cry2At!), at: o.cry2At! })
  return done(mix(parts), note)
}

function takenDeer(): Composed {
  const deer = src("src.deer", 3)
  return taken({ cry: slice(deer, 0.4, 1.8), cry2: bend(slice(deer, 0.55, 1.4), () => 160), cry2At: 2.0, thrash: src("src.thrash", 1), thrashAt: 1.55, impact: src("src.impact", 3), crack: slice(src("src.crack", 3), 0.3, 0.74), at: 2.5 },
    "a deer's distress cry, a struggle through the brush, a second cry cut off by a heavy impact and a wet crack, then nothing")
}
function takenRabbit(): Composed {
  return taken({ cry: slice(src("src.rabbit", 3), 0.1, 2.05), thrash: src("src.thrash", 3), thrashAt: 1.05, impact: src("src.impact", 2), crack: slice(src("src.crack", 4), 0, 0.3), at: 1.85 },
    "a rabbit screaming like a child, thrashing under it, the scream cut off by a thud and a crack, then nothing")
}
function takenDeer2(): Composed {
  return taken({ cry: slice(src("src.deer", 5), 0, 2.05), thrash: src("src.thrash", 4), thrashAt: 1.15, impact: src("src.impact", 4), crack: slice(src("src.crack", 3), 0.3, 0.74), at: 1.98 },
    "a deer bleating faster and faster, a squeal, kicking in the leaves, a thud and a crack, then nothing")
}

// ── the mimic ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A searcher's own call, answered from somewhere else: the same take, a little flat and sagging flatter, the gap
 * between words drawn out, and the last vowel held about twice too long.
 */
async function mimic(line: string): Promise<Composed> {
  const x = await shipped(`voice/${line}.ogg`, `voice line ${line} (Eleven v4, scripts/audio/voice-specs.ts)`)
  const tr = pitchTrack(x, 480)
  const top = Math.max(...tr.map((f) => f.rms))
  const voiced = tr.map((f) => f.f0 > 0 && f.rms > top - 30)
  // The last voiced run is the final vowel; hold its middle.
  let e = voiced.lastIndexOf(true), s = e
  while (s > 0 && voiced[s - 1]) s--
  const v0 = tr[s]!.t, v1 = tr[e]!.t
  const hold = [v0 + (v1 - v0) * 0.3, v1 - (v1 - v0) * 0.15] as const
  // The longest quiet gap between words (≥ 120 ms), drawn out 2.5×.
  let gap: [number, number] | null = null
  for (let i = 0, j = 0; i < s; i = j + 1) {
    j = i
    if (tr[i]!.rms > top - 32) continue
    while (j + 1 < s && tr[j + 1]!.rms <= top - 32) j++
    const a = tr[i]!.t, b = tr[j]!.t
    if (b - a >= 0.12 && a > 0.1 && (!gap || b - a > gap[1] - gap[0])) gap = [a, b]
  }
  const y = stretch(x, (t) => 1 + 0.95 * window(t, hold[0], hold[1]) + (gap ? 1.5 * window(t, gap[0] + 0.03, gap[1] - 0.03, 0.03) : 0))
  const len = y.length / SR
  const z = bend(y, (t) => -30 - 45 * (t / len))
  return done(levelTo(z, -12), `${line}: the same take answering from the wrong side: about 50 cents flat and sagging, ${gap ? "the gap between words drawn out, " : ""}the last vowel held twice too long`)
}

// ── a recording ─────────────────────────────────────────────────────────────────────────────────────────────────

async function echo2(): Promise<Composed> {
  const loon = await shipped("far.loon.1.ogg", "far.loon take 1 (shipped file)")
  return done(mix([{ x: loon, at: 0 }, { x: loon, at: loon.length / SR + 1.3 }]), "the loon, then exactly the same call again, sample for sample, like a tape")
}
async function echo3(): Promise<Composed> {
  const loon = await shipped("far.loon.2.ogg", "far.loon take 2 (shipped file)")
  const d = loon.length / SR + 1.1
  return done(mix([{ x: loon, at: 0 }, { x: loon, at: d }, { x: cut(loon, (loon.length / SR) * 0.55), at: 2 * d }]), "the loon three times, identical, the third stopping dead halfway")
}

// ── something heavy climbing ────────────────────────────────────────────────────────────────────────────────────

function climb(n: number, rate: number, note: string): Composed {
  const x = src("src.climb", n)
  return done(levelTo(varispeed(x, () => rate), -14), note)
}

// ── every cricket stops, then one knock ─────────────────────────────────────────────────────────────────────────

/** Silence while the crickets stop (the soundscape hushes them at the start), then one knock far off. */
function stop(n: number, wait: number): Composed {
  const k = src("src.knock", n)
  return done(mix([{ x: silence(wait), at: 0 }, { x: levelTo(k, -12), at: wait }]), `the crickets all stop at once; ${wait} s of nothing; one knock on a hollow trunk`)
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function compose(): Promise<void> {
  const out = join(work, "composed")
  rmSync(out, { recursive: true, force: true })
  const files: Record<string, (Composed | Promise<Composed>)[]> = {
    "far.howl": [howlScream(), howlSplit(), howlLong()],
    // Not shipped: for the listening page, in case Kit prefers them.
    "alt.howl": [howlVoice(), done(src("src.morph", 1), "ElevenLabs' own try at 'a howl that turns into a woman's scream', unedited")],
    "far.taken": [takenDeer(), takenRabbit(), takenDeer2()],
    "far.mimic": [],
    "far.echo": [await echo2(), await echo3()],
    "far.climb": [climb(4, 0.89, "deep, strained creaks of a big trunk taking a slow weight, in steps, as if something heavy is climbing it"), climb(1, 0.84, "the same, slower and lower: four long groans with stillness between")],
    "far.stop": [stop(4, 4), stop(6, 5.5)],
  }
  for (const line of MIMIC_LINES) files["far.mimic"]!.push(await mimic(line))
  for (const [id, list] of Object.entries(files)) {
    mkdirSync(join(out, id), { recursive: true })
    let n = 0
    for (const p of list) {
      const c = await p
      n++
      const g = 0.89 / Math.max(1e-6, peak(c.x))
      const x = g < 1 ? scale(c.x, g) : c.x
      const f32 = join(out, id, `${n}.f32`)
      writeFileSync(f32, new Uint8Array(x.buffer, x.byteOffset, x.byteLength))
      writeFileSync(join(out, id, `${n}.json`), JSON.stringify({ id, n, seconds: x.length / SR, note: c.note, from: c.from }, null, 1))
      await $`ffmpeg -v error -y -f f32le -ar ${SR} -ac 1 -i ${f32} ${join(out, id, `${n}.wav`)}`.quiet()
      console.log(`${id} #${n}: ${(x.length / SR).toFixed(2)} s  ${c.note}`)
    }
  }
}
