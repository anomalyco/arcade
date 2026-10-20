// Designed monster sounds (round 2): raw sources (sources.ts) and lab takes layered and processed (dsp.ts).
// Each category renders 3 takes; take k varies the sources, pitch ratios and space. `about` is shown on the audition
// page in place of a prompt.
import { join } from "node:path"
import * as D from "./dsp"
import { sourcePath } from "./sources"

const LAB = join(import.meta.dir, "..", "sfx")
const cache = new Map<string, Promise<D.Mono>>()
/** A raw source (sources/<id>.mp3) or a lab take ("ban-keen-wail/v1"). */
export const src = (id: string) => {
  let p = cache.get(id)
  if (!p) {
    p = D.load(id.includes("/") ? join(LAB, `${id}.mp3`) : sourcePath(id)).then((x) => D.peakNorm(D.trim(x), 0.9))
    cache.set(id, p)
  }
  return p
}

/** Transient slices (cracks, clicks) from a take: each from 15 ms before an onset to `len` s after. */
function chop(x: D.Mono, len = 0.25, gap = 0.08): D.Mono[] {
  const win = 256
  const env: number[] = []
  for (let i = 0; i + win < x.length; i += win / 2) {
    let s = 0
    for (let j = 0; j < win; j++) s += x[i + j]! ** 2
    env.push(Math.sqrt(s / win))
  }
  const peak = Math.max(...env)
  const out: D.Mono[] = []
  let last = -1e9
  for (let k = 1; k < env.length; k++) {
    const t = (k * win) / 2 / D.SR
    if (env[k]! > 0.25 * peak && env[k]! > 2.5 * (env[k - 1]! + 1e-6) && t - last > gap) {
      last = t
      out.push(D.fade(D.slice(x, Math.max(0, t - 0.015), t + len), 0.002, 0.08))
    }
  }
  return out.length ? out : [D.slice(x, 0, len)]
}

const pick = <T>(arr: T[], r: D.Rng) => arr[Math.floor(r() * arr.length) % arr.length]!

export type Recipe = {
  id: string
  subgroup: "Banshee" | "Skinwalker" | "Wendigo"
  label: string
  intent: string
  about: string[]
  sources: string[]
  render: (k: number, r: D.Rng) => Promise<D.Stereo>
}

export const RECIPES: Recipe[] = [
  // ---------------- Banshee ----------------
  {
    id: "ban2-scream-tear",
    subgroup: "Banshee",
    label: "Scream that tears inhuman",
    intent: "a female scream that starts human and tears into an inhuman multi-voiced shriek (stacked, detuned, ring-modulated, metallic); horror, terrifying",
    about: [
      "woman-scream source → at 30% a detuned stack (+4/−5 semitones, ±35/70 cents) with fox scream, 70 Hz ring mod and light bitcrush tears in; corridor reverb",
      "ban-scream-near v2 → stack with pig squeal and fox scream (varispeed), 100 Hz ring mod; stairwell reverb",
      "ban-scream-near v3 (approved take) → stack with fox scream and bowed metal, 130 Hz ring mod, heavier crush; forest reverb",
    ],
    sources: ["ban-scream-near/v1-v3", "fox-scream", "pig-squeal", "bowed-metal"],
    render: async (k, r) => {
      const base = k === 0 ? await src("woman-scream") : await src(`ban-scream-near/v${k + 1}`)
      const t = D.dur(base) * (k === 0 ? 0.3 : 0.35)
      const fox = D.varispeed(await src("fox-scream"), [1.1, 0.9, 1.3][k]!)
      const tearIn = (x: D.Mono) => D.envelope(x, [[0, 0], [t, 0], [t + 0.18, 1], [D.dur(x), 1]])
      const hi = tearIn(D.pitch(base, 1.26, { rnd: r }))
      const lo = tearIn(D.ringMod(D.pitch(base, 0.75, { rnd: r }), 70 + 30 * k, 0.8))
      const extra = k === 1 ? D.varispeed(await src("pig-squeal"), 1.15) : k === 2 ? D.pitch(await src("bowed-metal"), 1.5, { rnd: r }) : D.silence(0.1)
      const stack = D.chorus(base, [-70, -35, 0, 35, 70], { rnd: r })
      const tear = D.mix([
        { x: hi, gain: 0.7, pan: -0.4 },
        { x: lo, gain: 0.75, pan: 0.4 },
        { x: D.bitcrush(D.envelope(fox, [[0, 0], [0.1, 1], [D.dur(fox), 1]]), 6, 3, 0.35 + 0.15 * k), at: t, gain: 0.55 },
        { x: D.fade(extra, 0.15, 0.4), at: t + 0.05, gain: 0.35 },
      ])
      const human = D.envelope(base, [[0, 1], [t + 0.15, 1], [t + 0.45, 0.25], [D.dur(base), 0.2]])
      const tail = D.mix([{ x: human, gain: 0.9 }, { x: tear }, { x: stack, gain: 0.25 }])
      return D.finish(D.reverb(D.toMono(tail), (["corridor", "stairwell", "forest"] as const)[k]!, 0.35, r))
    },
  },
  {
    id: "ban2-keen-warp",
    subgroup: "Banshee",
    label: "Keening that warps down",
    intent: "a distant female keening wail whose pitch slides down unnaturally and warps, reverberant, eerie; no music",
    about: [
      "ban-keen-wail v1 (approved) → varispeed slides from 1.0 to 0.55 over the second half, granular smear layer; forest reverb",
      "ban-keen-wail v2 (approved) → slides to 0.6 with a wobble, smear; forest reverb",
      "ban-keen-wail v3 (approved) → slides to 0.5, stretched smear doubling; cavern reverb",
    ],
    sources: ["ban-keen-wail/v1-v3"],
    render: async (k, r) => {
      const base = await src(`ban-keen-wail/v${k + 1}`)
      const D0 = D.dur(base)
      const end = [0.55, 0.6, 0.5][k]!
      const curve = (t: number) => {
        const u = Math.max(0, Math.min(1, (t - D0 * 0.45) / (D0 * 0.6)))
        const wob = k === 1 ? 1 + 0.03 * Math.sin(2 * Math.PI * 5.5 * t) * u : 1
        return (1 - (1 - end) * u * u) * wob
      }
      const warped = D.varispeed(base, curve)
      const smear = D.stretch(warped, 1.15, { jitter: 0.06, grain: 0.12, pitchJitter: 0.01, rnd: r })
      const m = D.mix([{ x: warped, gain: 0.9 }, { x: smear, gain: 0.35, pan: 0.3 }])
      return D.finish(D.reverb(D.filter(D.toMono(m), "highpass", 120), k === 2 ? "cavern" : "forest", 0.6, r, 0.7))
    },
  },
  {
    id: "ban2-whisper-swell",
    subgroup: "Banshee",
    label: "Reversed whisper swell → click",
    intent: "a breathy reversed whisper swell (sucked-in, reverse-reverb) that ends abruptly in a sharp click, close, ghostly",
    about: [
      "ban-whisper-breath v2 reversed (its decay becomes a rising swell), stretched \u00d71.6, reverse-reverb (corridor) arriving first; cut dead on a twig click",
      "ban-whisper-breath v3 reversed, \u00d72, stairwell reverse-reverb swell; cut on a wet throat click",
      "both whisper takes stacked and reversed, room swell; cut on a teeth click (wen-clicks v3)",
    ],
    sources: ["ban-whisper-breath/v2", "ban-whisper-breath/v3", "out-twig/v1", "skin-clicks-breath/v1", "wen-clicks/v3"],
    render: async (k, r) => {
      const w = k === 2 ? D.toMono(D.mix([{ x: await src("ban-whisper-breath/v2") }, { x: D.pitch(await src("ban-whisper-breath/v3"), 0.94, { rnd: r }), at: 0.05 }])) : await src(`ban-whisper-breath/v${k + 2}`)
      // Reversed whisper (its decay becomes a rising swell), stretched, with a reverse-reverb tail arriving first.
      const rev = D.stretch(D.reverse(D.filter(w, "highpass", 300)), [1.6, 2, 1.4][k]!, { jitter: 0.015, grain: 0.08, rnd: r })
      const swell = D.reverseSwell(rev, (["corridor", "stairwell", "room"] as const)[k]!, r)
      const n = D.dur(swell)
      const body = D.toMono(D.mix([{ x: swell, gain: 1.1 }, { x: rev, at: n - D.dur(rev), gain: 0.7 }]))
      const shaped = D.envelope(body, [[0, 0], [n * 0.6, 0.6], [n - 0.02, 1], [n, 0]])
      const clickSrc = k === 0 ? await src("out-twig/v1") : k === 1 ? await src("skin-clicks-breath/v1") : await src("wen-clicks/v3")
      const click = D.peakNorm(chop(clickSrc, 0.08)[0]!, 0.9)
      return D.finish(D.mix([{ x: shaped, gain: 0.9 }, { x: click, at: n - 0.01, gain: 0.9 }]), { tail: 70 })
    },
  },
  {
    id: "ban2-choral-wail",
    subgroup: "Banshee",
    label: "Detuned choral wail",
    intent: "a sorrowful wordless choral wail, detuned and unsettling, ghostly female voices, cavernous; no instruments",
    about: [
      "female choir source stacked at −38/−13/0/+17/+41 cents with an octave-down shadow and slow vibrato, keen-wail v1 blended in; cavern reverb",
      "choir pitched −1 semitone, wider detune (±60 cents), keen-wail v2 blended; cavern reverb",
      "choir +1 semitone, detune stack with a slow downward slide at the end, keen-wail v3 blended; stairwell reverb",
    ],
    sources: ["female-choir", "ban-keen-wail/v1-v3"],
    render: async (k, r) => {
      const choir = D.pitch(await src("female-choir"), [1, 0.944, 1.059][k]!, { rnd: r })
      const vib = D.varispeed(choir, (t) => (1 + 0.012 * Math.sin(2 * Math.PI * 0.3 * t)) * (k === 2 ? Math.max(0.8, 1 - Math.max(0, t - 4) * 0.08) : 1))
      const cents = k === 1 ? [-60, -25, 0, 30, 62] : [-38, -13, 0, 17, 41]
      const stack = D.chorus(vib, cents, { rnd: r, delay: 0.05 })
      const shadow = D.varispeed(vib, 0.5)
      const keen = D.slice(await src(`ban-keen-wail/v${k + 1}`), 0, 6)
      const m = D.mix([{ x: stack }, { x: shadow, gain: 0.25 }, { x: keen, at: 0.8, gain: 0.3 }])
      return D.finish(D.reverb(D.fade(D.toMono(m), 0.6, 1.5), k === 2 ? "stairwell" : "cavern", 0.55, r, 0.8))
    },
  },

  // ---------------- Skinwalker ----------------
  {
    id: "skin2-breath-pant",
    subgroup: "Skinwalker",
    label: "Human breath → animal pant",
    intent: "close human breathing that turns into a fast animal (dog-like) pant, almost human but not quite; unsettling",
    about: [
      "human panting crossfades at 45% into dog panting slowed to 0.8 with a 30 Hz ring mod; wen-starving-breath v1 under it, pitched down; small room",
      "same with the dog pant at 0.7 and a granular smear across the seam",
      "human pant pitched down 0.85, dog pant 0.9, wen-starving-breath v3 layer",
    ],
    sources: ["human-pant", "dog-pant", "wen-starving-breath/v1-v3"],
    render: async (k, r) => {
      const human = k === 2 ? D.pitch(await src("human-pant"), 0.85, { rnd: r }) : await src("human-pant")
      const dog = D.ringMod(D.varispeed(await src("dog-pant"), [0.8, 0.7, 0.9][k]!), 30, 0.25)
      const t = D.dur(human) * 0.45
      let morph = D.crossfade(human, dog, t, 0.9)
      if (k === 1) morph = D.toMono(D.mix([{ x: morph }, { x: D.stretch(D.slice(morph, t - 0.4, t + 0.8), 1.6, { jitter: 0.05, rnd: r }), at: t - 0.4, gain: 0.4 }]))
      const low = D.varispeed(await src(`wen-starving-breath/v${[1, 2, 3][k]}`), 0.8)
      const m = D.mix([{ x: morph }, { x: D.slice(low, 0, D.dur(morph)), gain: 0.3, pan: 0.2 }])
      return D.finish(D.reverb(D.toMono(m), "room", 0.25, r))
    },
  },
  {
    id: "skin2-throat-chatter",
    subgroup: "Skinwalker",
    label: "Wet throat-click chatter",
    intent: "a fast wet throat-click chatter from a creature, clicks and moist gurgles, very close; not mechanical",
    about: [
      "throat clicks chopped from skin-clicks-breath v1/v2 into an accelerating chatter pitched 0.5\u20130.8, a wet squelch layer and a low pant; tight room",
      "chatter at 0.65\u20130.95 doubled and detuned",
      "chatter at 0.7\u20131.3, stuttering",
    ],
    sources: ["skin-clicks-breath/v1", "skin-clicks-breath/v2", "wen-feeding/v2", "human-pant"],
    render: async (k, r) => {
      const wet = D.filter(D.slice(await src("wen-feeding/v2"), 0, 3), "lowpass", 2500)
      const pool = [...chop(await src("skin-clicks-breath/v1"), 0.09, 0.04), ...chop(await src("skin-clicks-breath/v2"), 0.09, 0.04)]
      const [lo, hi] = [[0.5, 0.8], [0.65, 0.95], [0.7, 1.3]][k]!
      const parts: D.Part[] = []
      let t = 0
      for (let i = 0; i < 44 && t < 3; i++) {
        parts.push({ x: D.varispeed(pick(pool, r), lo + r() * (hi - lo)), at: t, gain: 0.6 + r() * 0.4 })
        t += Math.max(0.035, 0.16 - i * 0.004) * (0.7 + r() * 0.6)
      }
      const clicks = D.toMono(D.mix(parts))
      const dbl = k === 1 ? D.chorus(clicks, [-25, 0, 22], { rnd: r }) : D.mix([{ x: clicks }])
      const breath = D.filter(D.slice(D.varispeed(await src("human-pant"), 0.75), 0, t + 0.3), "lowpass", 1800)
      const m = D.mix([{ x: dbl }, { x: wet, gain: 0.35, pan: 0.2 }, { x: breath, gain: 0.25, pan: -0.2 }])
      return D.finish(D.reverb(D.toMono(m), "room", 0.2, r))
    },
  },
  {
    id: "skin2-woman-fox",
    subgroup: "Skinwalker",
    label: "Scream half woman, half fox",
    intent: "a scream that is half woman, half fox: a human scream that morphs mid-way into a harsh fox scream, both voices overlapping, horror",
    about: [
      "woman scream source crossfades at 40% into a fox scream, both overlapping for half a second, light detune; forest reverb",
      "ban-scream-near v2 into fox scream slowed to 0.85, ring mod on the overlap; forest reverb",
      "woman scream into fox scream at 1.15 with a pig squeal buried in the seam; corridor reverb",
    ],
    sources: ["woman-scream", "ban-scream-near/v2", "fox-scream", "heron-croak"],
    render: async (k, r) => {
      const woman = k === 1 ? await src("ban-scream-near/v2") : await src("woman-scream")
      const fox = D.varispeed(await src("fox-scream"), [1, 0.85, 1.15][k]!)
      const t = D.dur(woman) * 0.35
      // Both voices overlap for a second: the woman fading, the fox (same pitch region) rising through her.
      const both = D.toMono(D.mix([{ x: D.envelope(woman, [[0, 1], [t, 1], [t + 1, 0.15], [99, 0]]) }, { x: D.envelope(fox, [[0, 0.2], [0.4, 1], [99, 1]]), at: t - 0.3 }]))
      let morph = D.drive(both, 1.5)
      if (k === 1) morph = D.toMono(D.mix([{ x: morph }, { x: D.ringMod(D.slice(morph, t, t + 0.8), 90, 0.7), at: t, gain: 0.35 }]))
      const parts: D.Part[] = [{ x: D.chorus(morph, [-15, 0, 12], { rnd: r }) }]
      if (k === 2) parts.push({ x: D.fade(D.varispeed(await src("pig-squeal"), 1.2), 0.2, 0.3), at: t + 0.4, gain: 0.35 })
      return D.finish(D.reverb(D.toMono(D.mix(parts)), k === 2 ? "corridor" : "forest", 0.4, r))
    },
  },
  {
    id: "skin2-howl-sob",
    subgroup: "Skinwalker",
    label: "Guttural howl → human sob",
    intent: "a guttural, distorted animal howl that ends in a close, quiet human sob; almost human but not quite; horror",
    about: [
      "elk-bugle source slowed to 0.6 over a throat-drone growl, driven, forest reverb; ends dry and close on ban-weeping v1",
      "elk-bugle at 0.5 (lower, more guttural) with the growl; ends on ban-weeping v2",
      "skin-animal-human v3 at 0.75, detuned \u00d73, driven; ends on ban-weeping v3",
    ],
    sources: ["elk-bugle", "skin-animal-human/v3", "throat-drone", "ban-weeping/v1-v3"],
    render: async (k, r) => {
      const base = k === 2 ? D.varispeed(await src("skin-animal-human/v3"), 0.75) : D.toMono(D.mix([{ x: D.varispeed(await src("elk-bugle"), [0.6, 0.5][k]!) }, { x: D.varispeed(await src("throat-drone"), 0.7), gain: 0.6 }]))
      const howl = D.drive(base, 3)
      const growl = D.slice(D.varispeed(await src("throat-drone"), 0.6), 0, D.dur(howl))
      const body = k === 2 ? D.chorus(howl, [-30, 0, 30], { rnd: r }) : D.mix([{ x: howl }, { x: growl, gain: 0.45 }])
      const far = D.reverb(D.toMono(body), "forest", 0.7, r, 0.6)
      const sob = D.slice(await src(`ban-weeping/v${k + 1}`), 0, 2.6)
      const at = D.dur(howl) - 0.25
      return D.finish(D.mix([{ x: D.stereoGain(far, 0.9) }, { x: D.fade(sob, 0.1, 0.5), at, gain: 0.6 }]))
    },
  },
  {
    id: "skin2-bones-reshape",
    subgroup: "Skinwalker",
    label: "Bones cracking, reshaping",
    intent: "bones cracking, popping and reshaping during a body transformation: dense wet cracks, squelches, deep thuds and a low groan; horror",
    about: [
      "~26 cracks chopped from bone-cracks and wen-bone-creak, pitched down 0.45\u20130.9 with a 180 Hz body boost, each with a wet squelch, sub thumps under the big ones, a groan pitched down; room",
      "denser and lower (0.35\u20130.75), more squelch",
      "sparser (24) with longer pauses, the groan rising",
    ],
    sources: ["bone-cracks", "wen-bone-creak/v1-v3", "wen-feeding/v1", "wen-feeding/v3", "wen-distant-moan/v2"],
    render: async (k, r) => {
      const pool: D.Mono[] = []
      for (const id of ["bone-cracks", "wen-bone-creak/v1", "wen-bone-creak/v2", "wen-bone-creak/v3"]) pool.push(...chop(await src(id), 0.22))
      const squelch = chop(await src("wen-feeding/v1"), 0.3, 0.12).concat(chop(await src("wen-feeding/v3"), 0.3, 0.12))
      const [lo, hi] = [[0.45, 0.9], [0.35, 0.75], [0.55, 1]][k]!
      const parts: D.Part[] = []
      let t = 0.1
      const n = [26, 34, 24][k]!
      for (let i = 0; i < n; i++) {
        const big = r() < 0.2
        // Cracks pitched down and body-filtered (meat, not wood), each with a wet squelch and sometimes a thump.
        const c = D.filter(D.varispeed(pick(pool, r), big ? lo : lo + r() * (hi - lo)), "peak", 180, 0.8, 9)
        parts.push({ x: c, at: t, gain: big ? 1 : 0.45 + r() * 0.4, pan: r() * 1.2 - 0.6 })
        if (r() < 0.6) parts.push({ x: D.varispeed(pick(squelch, r), 0.7 + r() * 0.5), at: t + 0.01, gain: 0.35 + r() * 0.3 })
        if (big) parts.push({ x: D.tone(0.5, (u) => 60 - 32 * u, [[0, 0], [0.004, 1], [0.5, 0]]), at: t, gain: 0.7 })
        t += (k === 2 ? 0.3 : 0.24) * (1 - (i / n) * 0.6) * (0.4 + r() * 1.2)
      }
      const groan = D.slice(D.varispeed(await src("wen-distant-moan/v2"), k === 2 ? 0.7 : 0.55), 0, t + 1)
      parts.push({ x: D.fade(groan, 1.2, 1), gain: 0.4 })
      return D.finish(D.reverb(D.toMono(D.mix(parts)), "room", 0.3, r))
    },
  },

  // ---------------- Wendigo ----------------
  {
    id: "wen2-starving-groan",
    subgroup: "Wendigo",
    label: "Starving groan with bone creaks",
    intent: "a deep, slow, starving groan from something huge and gaunt, with bone creaks inside it, cavernous and wrong; no music",
    about: [
      "wen-distant-moan v2 (approved) slowed to 0.62 and driven, loud bone creaks pitched down inside it, 36 Hz sub; cavern reverb",
      "wen-distant-moan v3 (approved) at 0.7, driven, a slowed starving breath through it and creaks",
      "throat drone at 0.6, smeared \u00d71.4, moan v2 detuned under it, sparse creaks",
    ],
    sources: ["wen-distant-moan/v2", "wen-distant-moan/v3", "throat-drone", "bone-cracks", "wen-bone-creak/v1-v3"],
    render: async (k, r) => {
      const base = k === 2 ? D.varispeed(await src("throat-drone"), 0.6) : D.varispeed(await src(`wen-distant-moan/v${k + 2}`), [0.62, 0.7][k]!)
      const groan = k === 2 ? D.stretch(base, 1.4, { jitter: 0.03, grain: 0.15, rnd: r }) : D.drive(base, 1.6)
      const L = D.dur(groan)
      const pool = [...chop(await src("bone-cracks"), 0.3), ...chop(await src("wen-bone-creak/v2"), 0.3), ...chop(await src("wen-bone-creak/v3"), 0.3)]
      const parts: D.Part[] = [{ x: groan }]
      if (k === 1) parts.push({ x: D.slice(D.stretch(D.varispeed(await src("wen-starving-breath/v2"), 0.75), 1.8, { jitter: 0.02, rnd: r }), 0, L), gain: 0.45 })
      if (k === 2) parts.push({ x: D.chorus(D.slice(D.varispeed(await src("wen-distant-moan/v2"), 0.55), 0, L), [-25, 0, 25], { rnd: r }), gain: 0.4 })
      const nc = k === 2 ? 4 : 7
      for (let i = 0; i < nc; i++) parts.push({ x: D.filter(D.varispeed(pick(pool, r), 0.5 + r() * 0.3), "peak", 200, 0.8, 6), at: 0.5 + r() * L * 0.85, gain: 0.9, pan: r() - 0.5 })
      parts.push({ x: D.tone(L, () => 36, [[0, 0], [1.5, 1], [L - 1.5, 1], [L, 0]]), gain: 0.15 })
      return D.finish(D.reverb(D.fade(D.toMono(D.mix(parts)), 0.5, 1.5), "cavern", 0.45, r, 0.85))
    },
  },
  {
    id: "wen2-chatter",
    subgroup: "Wendigo",
    label: "Teeth chatter from the dark",
    intent: "fast chattering teeth and dry clicks from something in the dark, predatory, distant-ish, wrong; not a machine",
    about: [
      "wen-clicks v3 (5/5) barely touched: slowed to 0.9, light forest reverb",
      "wen-clicks v3 at 0.9 with a second, lower mouth (0.78) answering",
      "teeth (wen-clicks v3) and wet throat clicks (skin-clicks-breath v1) chopped into a low accelerating chatter; forest reverb",
    ],
    sources: ["wen-clicks/v3", "skin-clicks-breath/v1"],
    render: async (k, r) => {
      const a = await src("wen-clicks/v3")
      if (k === 2) {
        // Teeth plus wet throat clicks chopped into a low, accelerating chatter.
        const pool = [...chop(await src("skin-clicks-breath/v1"), 0.09, 0.04), ...chop(a, 0.08, 0.04)]
        const parts: D.Part[] = []
        let t = 0
        for (let i = 0; i < 40 && t < 3; i++) {
          parts.push({ x: D.varispeed(pick(pool, r), 0.55 + r() * 0.3), at: t, gain: 0.6 + r() * 0.4, pan: r() * 0.8 - 0.4 })
          t += Math.max(0.04, 0.15 - i * 0.003) * (0.7 + r() * 0.6)
        }
        return D.finish(D.reverb(D.toMono(D.mix(parts)), "forest", 0.4, r, 0.85))
      }
      // wen-clicks v3 already reads as teeth in the dark (5/5): barely touched, slightly lower, a second mouth on v2.
      const parts: D.Part[] = [{ x: D.varispeed(a, 0.9) }]
      if (k === 1) parts.push({ x: D.varispeed(a, 0.78), at: 0.35, gain: 0.5, pan: 0.4 })
      return D.finish(D.reverb(D.toMono(D.mix(parts)), "forest", 0.25, r, 0.9))
    },
  },
  {
    id: "wen2-bark-scrape",
    subgroup: "Wendigo",
    label: "Antler scrape on bark",
    intent: "a long, slow antler or bone scrape dragging along tree bark or wood, heavy and grinding, with a faint metallic resonance",
    about: [
      "wen-antler-scrape v1 slowed to 0.5 and dulled, the antler-on-bark source slowed to 0.4 as a grinding layer, fine bark crackle grains along the drag; forest reverb",
      "wen-antler-scrape v2 at 0.55, same layers",
      "wen-antler-scrape v3 at 0.6, dulled, same layers",
    ],
    sources: ["wen-antler-scrape/v1-v3", "antler-bark", "out-twig/v2", "out-twig/v3"],
    render: async (k, r) => {
      const main = D.filter(D.varispeed(await src(`wen-antler-scrape/v${k + 1}`), [0.5, 0.55, 0.6][k]!), "lowpass", k === 1 ? 3500 : 2200)
      const L = D.dur(main)
      const bark = D.filter(D.stretch(D.varispeed(await src("antler-bark"), 0.4), 1.2, { jitter: 0.02, grain: 0.04, rnd: r }), "bandpass", 900, 0.7)
      // Bark crackle: tiny twig-snap grains along the drag.
      const crack = [...chop(await src("out-twig/v2"), 0.06, 0.03), ...chop(await src("out-twig/v3"), 0.06, 0.03)]
      const parts: D.Part[] = [{ x: main }, { x: D.slice(bark, 0, L), gain: 0.35, pan: 0.2 }]
      for (let t = 0.2; t < L - 0.2; t += 0.08 + r() * 0.25) parts.push({ x: D.varispeed(pick(crack, r), 0.5 + r() * 0.4), at: t, gain: 0.15 + r() * 0.2, pan: r() * 0.6 - 0.3 })
      parts.push({ x: D.tone(L, () => 55, [[0, 0], [0.5, 1], [L - 0.5, 1], [L, 0]], [1, 0.3]), gain: 0.06 })
      return D.finish(D.reverb(D.filter(D.toMono(D.mix(parts)), "highpass", 50), "forest", 0.4, r))
    },
  },
  {
    id: "wen2-endless-inhale",
    subgroup: "Wendigo",
    label: "Endless hollow inhale",
    intent: "a hollow, cavernous inhale that goes on far too long, deep and starving, never seeming to end; close but huge",
    about: [
      "breath takes reversed into inhales (long-inhale + wen-starving-breath v1), slowed to 0.75 and stretched, a throat resonance sweeping 350\u21921100 Hz, a faint voiced rattle; cavern reverb, ends unresolved",
      "with wen-starving-breath v2, slower (0.65), more rattle",
      "with wen-starving-breath v3, 0.8, drier",
    ],
    sources: ["long-inhale", "wen-starving-breath/v1-v3", "throat-drone"],
    render: async (k, r) => {
      // Inhales: the breath takes reversed, a moving throat resonance (band-pass sweeping up) so it reads as a
      // mouth, a faint voiced rattle under it.
      const breathA = D.reverse(await src("long-inhale"))
      const breathB = D.reverse(await src(`wen-starving-breath/v${k + 1}`))
      const raw = D.toMono(D.mix([{ x: breathA }, { x: breathB, gain: 0.6 }]))
      const slow = D.stretch(D.varispeed(raw, [0.75, 0.65, 0.8][k]!), [2.2, 2.6, 2] [k]! * [0.75, 0.65, 0.8][k]!, { jitter: 0.01, grain: 0.14, rnd: r })
      const L = D.dur(slow)
      const sweep = (x: D.Mono, f0: number, f1: number) => {
        const out = new Float32Array(x.length)
        const seg = D.sec(0.25)
        for (let i = 0; i < x.length; i += seg) {
          const f = f0 * (f1 / f0) ** (i / x.length)
          const y = D.filter(x.subarray(Math.max(0, i - seg), Math.min(x.length, i + seg)), "bandpass", f, 0.9)
          for (let j = 0; j < seg && i + j < x.length; j++) out[i + j] = y[j + Math.min(i, seg)]!
        }
        return out
      }
      const throat = sweep(slow, 350, 1100)
      const rattle = D.slice(D.varispeed(await src("throat-drone"), 0.55), 0, L)
      const m = D.toMono(D.mix([{ x: slow, gain: 0.6 }, { x: throat, gain: 1.4 }, { x: D.fade(rattle, 2, 1), gain: k === 2 ? 0 : 0.04 }]))
      return D.finish(D.reverb(D.envelope(m, [[0, 0], [L * 0.25, 0.5], [L * 0.9, 1], [L, 0.6]]), "cavern", 0.45, r, 0.85), { tail: 50 })
    },
  },
  {
    id: "wen2-huge-scream",
    subgroup: "Wendigo",
    label: "Huge inhuman scream (rare)",
    intent: "a rare, huge, inhuman scream that echoes across the woods for seconds: layered animal and human shrieks pitched down, enormous, terrifying",
    about: [
      "elk-bugle, pig squeal, fox and woman screams stacked at 0.7 with detune, a sub hit at the onset; huge forest + cavern tail",
      "elk-bugle and fox scream only at 0.62, bowed metal ring-modded under them",
      "pig squeal and woman scream at 0.8, a little elk on top, heavier drive; cavern tail",
    ],
    sources: ["elk-bugle", "pig-squeal", "fox-scream", "woman-scream", "bowed-metal"],
    render: async (k, r) => {
      const ratio = [0.7, 0.62, 0.8][k]!
      // Fewer voices than a crowd: two or three sources, each with its own role.
      const ids = [["elk-bugle", "pig-squeal", "fox-scream", "woman-scream"], ["elk-bugle", "fox-scream"], ["pig-squeal", "woman-scream", "elk-bugle"]][k]!
      const layers = await Promise.all(ids.map(src))
      const parts: D.Part[] = layers.map((x, i) => ({ x: D.varispeed(x, ratio * (1 + (i - 1) * 0.015)), at: i * 0.03, gain: k === 2 && i === 2 ? 0.3 : 0.7, pan: -0.5 + i * 0.4 }))
      if (k === 1) parts.push({ x: D.ringMod(D.varispeed(await src("bowed-metal"), 0.7), 60, 0.6), gain: 0.35 })
      parts.push({ x: D.tone(1.2, (u) => 48 - 22 * u, [[0, 0], [0.01, 1], [1.2, 0]]), gain: 0.7 })
      const dry = D.drive(D.toMono(D.mix(parts)), k === 2 ? 3.5 : 2.5)
      const big = D.reverb(D.reverb(D.fade(dry, 0.01, 0.6), "forest", 0.8, r, 1), "cavern", 0.5, r, 0.9)
      return D.finish(big, { tail: 55 })
    },
  },
  {
    id: "wen2-silence-sting",
    subgroup: "Wendigo",
    label: "Forest goes silent",
    intent: "the moment the forest goes silent: a short whoosh into near silence, a sub drop, and a high thin ringing tone left hanging; 3 s",
    about: [
      "reversed noise whoosh into a 70→22 Hz sub drop; a 7.4 kHz ring with a 3 Hz beat fades in and hangs",
      "no whoosh: sub drop alone, ring at 8.9 kHz with a faint second partial",
      "a reversed forest rustle sucked away, sub drop, ring at 10.5 kHz with a slow 1.5 Hz beat",
    ],
    sources: ["(synthesised)", "out-rustle/v1"],
    render: async (k, r) => {
      const parts: D.Part[] = []
      const t0 = 0.6
      if (k === 0) parts.push({ x: D.filter(D.envelope(D.noise(t0, r), [[0, 0], [t0 - 0.02, 1], [t0, 0]]), "lowpass", 3000), gain: 0.25 })
      if (k === 2) parts.push({ x: D.filter(D.reverse(D.fade(D.slice(await src("out-rustle/v1"), 0, t0), 0.01, 0.2)), "lowpass", 2500), gain: 0.4 })
      parts.push({ x: D.tone(1.6, (u) => 70 * Math.exp(-u * 1.4), [[0, 0], [0.01, 1], [1.6, 0]]), at: t0, gain: 0.9 })
      const f = [7400, 8900, 10500][k]!
      const ring = D.mix([
        { x: D.tone(3, () => f, [[0, 0], [0.4, 1], [3, 0.7]]), gain: 0.05 },
        { x: D.tone(3, () => f + [3, f * 0.5, 1.5][k]!, [[0, 0], [0.4, 1], [3, 0.7]]), gain: k === 1 ? 0.015 : 0.04 },
      ])
      parts.push({ x: ring, at: t0 })
      return D.finish(D.mix(parts), { tail: 80, peak: 0.85 })
    },
  },
]
