// Offline listening reel and loudness check for the layered weapon sounds (AR-102). Never plays audio. Every weapon
// fires, reloads, dry-fires, swings, hits and lands, outdoors on a street and indoors in Elm's house (plus a pistol
// between two houses for the slapback), through the same `WeaponSounds` calls the game makes, the catalog's baked
// takes, the runtime's spatial model and the game's street/room reverb. Writes reel.wav (+ reel.mp4 with a
// spectrogram and scene titles when ffmpeg is present, its audio lifted 6 dB with a limiter for listening on a
// phone), today-pistol.wav for comparison, and loudness.json (in-game levels, before that lift).
//
//   bun scripts/weapon-reel.ts [--out <dir>] [--only <scene prefix>]
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"
import { AudioRuntime, busVolume, sfxEntry } from "@arcade/kit/audio"
import { mulberry32 } from "@arcade/kit/sim/rng"
import { integratedLufs, momentaryMaxLufs } from "../../../packages/kit/audio/sfx-analysis"
import { convolve, wav } from "./reel-audio"
import { decode } from "../../../scripts/sfx/decode"
import { CoopSim } from "../shared/coop-sim"
import { MELEE_WEAPON_IDS, MELEE_WEAPONS, type CombatMeleeEvent, type CombatShotEvent, type MeleeWeaponId } from "../shared/combat"
import { impactDelay, type ImpactMaterial } from "../src/audio/impacts"
import { RELOAD_STARTS } from "../src/audio/reload"
import { AUDIO_BUS_LEVELS, DEFAULT_AUDIO_SETTINGS, WEAPON_GROUP_KEYS } from "../src/audio/settings"
import { indoors, SoundOcclusion } from "../src/audio/space"
import type { SoundEvent } from "../src/audio/types"
import { weaponMix } from "../src/audio/weapons/bank"
import { WEAPON_SAMPLE_RATE, weaponSound } from "../src/audio/weapons/catalog"
import { weaponSpace, WeaponSounds } from "../src/audio/weapons/weapons"

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1]! : fallback
}
const OUT = arg("out", join(process.env.TMPDIR ?? "/tmp", "opencode", "weapon-reel"))
const ONLY = arg("only", "")
const SR = 48000
const settings = { ...DEFAULT_AUDIO_SETTINGS }
const MASTER = settings.volumeMaster / 100

// --- World ---------------------------------------------------------------------------------------------------------
const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
sim.addSurvivor("reel", 0)
sim.syncWorldChunks()
const town = sim.town
const occlusion = new SoundOcclusion()
occlusion.sync(town, 1)
const rt = new AudioRuntime({ visibilityQuery: occlusion.query })

type Spot = { name: string; x: number; y: number; aim: number }
function findSpot(want: "alley" | "street" | "open", near: { x: number; y: number }): { x: number; y: number } {
  let best: { x: number; y: number; d: number } | null = null
  for (let x = near.x - 40; x <= near.x + 40; x += 1) {
    for (let y = near.y - 40; y <= near.y + 40; y += 1) {
      if (weaponSpace(town, x, y) !== want) continue
      const d = Math.hypot(x - near.x, y - near.y)
      if (!best || d < best.d) best = { x, y, d }
    }
  }
  return best ?? near
}
const STREET: Spot = { name: "outdoors", ...findSpot("street", { x: 44.2, y: 57 }), aim: 0 }
const ROOM: Spot = { name: "indoors", x: 25.2, y: 57.2, aim: Math.PI / 2 }
// Seed 7's origin block has wide side yards and no alley, so the reel stages one: the pistol scene "between houses"
// fires from the street spot with its tail forced to the alley's slapback.
const ALLEY: Spot = { name: "between houses", x: STREET.x, y: STREET.y, aim: 0 }
console.log(`spots: street ${STREET.x},${STREET.y} → ${weaponSpace(town, STREET.x, STREET.y)}; room → ${weaponSpace(town, ROOM.x, ROOM.y)} (indoors ${indoors(town, ROOM.x, ROOM.y)})`)

// --- Sounds --------------------------------------------------------------------------------------------------------
const takes = new Map<string, Float32Array[]>()
const lastTake = new Map<string, number>()
async function buffers(id: string): Promise<{ bufs: Float32Array[]; rate: number } | null> {
  const def = weaponSound(id)
  if (def) {
    let t = takes.get(id)
    if (!t) takes.set(id, (t = Array.from({ length: def.variants }, (_, v) => def.bake(WEAPON_SAMPLE_RATE, v))))
    return { bufs: t, rate: WEAPON_SAMPLE_RATE }
  }
  let t = takes.get(id)
  if (!t) {
    const entry = sfxEntry(id)
    t = []
    for (let v = 1; v <= entry.variants; v++) t.push((await decode(join(import.meta.dir, "../../../packages/kit/audio/sfx", `${id}.${v}.ogg`), 1))[0]!)
    takes.set(id, t)
  }
  return { bufs: t, rate: SR }
}

// --- Scenes --------------------------------------------------------------------------------------------------------
type Cue = SoundEvent & { at: number; hold?: number }
type Scene = { name: string; spot: Spot; listener?: { x: number; y: number }; cues: Cue[]; seconds: number }
const wpn = new WeaponSounds()
weaponMix(settings, wpn.mix)

function scene(name: string, spot: Spot, build: (add: (at: number) => (e: SoundEvent) => void, hold: (at: number, seconds: number, e: SoundEvent) => void) => number, listener?: { x: number; y: number }): Scene {
  const cues: Cue[] = []
  wpn.frame(town, listener ?? spot)
  const seconds = build(
    (at) => (e) => cues.push({ ...e, at }),
    (at, s, e) => cues.push({ ...e, at, hold: s }),
  )
  return { name, spot, ...(listener ? { listener } : {}), cues, seconds }
}

/** Indoors everything happens across the room, outdoors across the yard. */
const across = (s: Spot) => (s === ROOM ? 2.6 : 7)
const ahead = (s: Spot, d: number, side = 0) => ({ x: s.x + Math.cos(s.aim) * d - Math.sin(s.aim) * side, y: s.y + Math.sin(s.aim) * d + Math.cos(s.aim) * side })
let shotId = 0
const shotAt = (s: Spot, from = s as { x: number; y: number }): CombatShotEvent => ({ id: ++shotId, time: 0, fromX: from.x, fromY: from.y, toX: from.x + Math.cos(s.aim) * 8, toY: from.y + Math.sin(s.aim) * 8, aim: s.aim, hitZombieId: null, killed: false, detachBone: null, seed: shotId * 7 })
let swingId = 0
const swingOf = (w: MeleeWeaponId, s: Spot, heavy: boolean, hits: { headshot?: boolean; killed?: boolean; finisher?: boolean }[] = []): CombatMeleeEvent => {
  const p = ahead(s, 1.2)
  return { id: ++swingId, time: 0, attackerId: "reel", attackerIndex: 0, weapon: w, x: s.x, y: s.y, aim: s.aim, arc: 1, reach: MELEE_WEAPONS[w].reach, combo: 1, heavy, charge: heavy ? 1 : 0, hits: hits.map((h, i) => ({ zombieId: i + 1, x: p.x, y: p.y, damage: 30, killed: Boolean(h.killed), knockdown: false, headshot: Boolean(h.headshot), finisher: h.finisher, detachBone: null, seed: swingId })), hitDoorId: null, doorBroke: false, weaponBroke: false, durabilityLow: false, seed: swingId } as CombatMeleeEvent
}

function pistolScene(spot: Spot, surfaces: ImpactMaterial[]): Scene {
  wpn.spaceOf = spot === ALLEY ? () => "alley" : weaponSpace
  return scene(`Pistol ${spot.name}`, spot, (add) => {
    wpn.draw("pistol", spot.x, spot.y, add(0), "reel")
    let t = 0.8
    for (const m of surfaces) {
      wpn.shot(shotAt(spot), add(t), true)
      const hit = ahead(spot, across(spot))
      if (m === "flesh") wpn.fleshHit(hit.x, hit.y, add(t))
      else wpn.bulletImpact(m, hit.x, hit.y, add(t), { delay: impactDelay(across(spot)), gain: 1, fallback: { id: "impact.bullet.concrete" } })
      t += 0.55
    }
    t += 0.5
    wpn.dryFire(spot.x, spot.y, add(t), "reel")
    t += 0.5
    for (const part of RELOAD_STARTS) wpn.reloadPart(part.id, spot.x, spot.y, part.start, add(t), "reel")
    return t + 2
  })
}

function teammateScene(spot: Spot): Scene {
  return scene(`Teammate's pistol at 8, 20, 40 m (${spot.name})`, spot, (add) => {
    let t = 0.2
    for (const d of [8, 20, 40]) {
      const from = ahead(spot, 0, d)
      const s = { ...spot, x: from.x, y: from.y }
      wpn.frame(town, spot)
      wpn.shot(shotAt(s, from), add(t), true)
      t += 1.6
    }
    return t + 1
  })
}

function meleeScene(w: MeleeWeaponId, spot: Spot, wall: ImpactMaterial): Scene {
  return scene(`${MELEE_WEAPONS[w].label} ${spot.name}`, spot, (add) => {
    wpn.draw(w, spot.x, spot.y, add(0), "reel")
    const swingAt = (t: number, m: CombatMeleeEvent) => wpn.swing(m, 0, add(t), "melee.swing.light")
    const whiff = swingOf(w, spot, false)
    swingAt(0.6, whiff)
    const light = swingOf(w, spot, false, [{}])
    swingAt(1.3, light)
    wpn.meleeHit(light, light.hits[0]!, true, undefined, add(1.3 + 0.12))
    const heavy = swingOf(w, spot, true, [{ headshot: true, killed: true }])
    swingAt(2.2, heavy)
    wpn.meleeHit(heavy, heavy.hits[0]!, true, undefined, add(2.2 + 0.16))
    const miss = swingOf(w, spot, false)
    swingAt(3.3, miss)
    const p = ahead(spot, 1.4)
    wpn.meleeSurface(miss, { id: "melee.hit.wood", material: wall, x: p.x, y: p.y, gain: 0.82 }, add(3.3 + 0.1))
    return 4.6
  })
}

function flareScene(spot: Spot): Scene {
  return scene(`Flare gun ${spot.name}`, spot, (add) => {
    wpn.draw("flare-gun", spot.x, spot.y, add(0), "reel")
    wpn.flareGun(spot.x, spot.y, add(0.7))
    return 3.4
  })
}

function fireScene(spot: Spot): Scene {
  return scene(`Fire & explosives ${spot.name}`, spot, (add, hold) => {
    const p = ahead(spot, across(spot))
    add(0)({ id: "wpn.draw.flamer", x: spot.x, y: spot.y, source: "reel" })
    add(0.6)({ id: "wpn.flamer.ignite", x: spot.x, y: spot.y, source: "reel" })
    hold(0.75, 2, { id: "wpn.flamer.loop", x: spot.x, y: spot.y, source: "reel" })
    add(2.75)({ id: "wpn.flamer.stop", x: spot.x, y: spot.y, source: "reel" })
    add(3.8)({ id: "wpn.throw.light", x: spot.x, y: spot.y, source: "reel" })
    add(4.3)({ id: "wpn.molotov.smash", x: p.x, y: p.y, source: "reel" })
    hold(4.4, 2, { id: "wpn.fire.loop", x: p.x, y: p.y, source: "reel" })
    add(7)({ id: "wpn.fuse.strike", x: spot.x, y: spot.y, source: "reel" })
    hold(7.2, 1.6, { id: "wpn.fuse.loop", x: p.x, y: p.y, source: "reel" })
    wpn.report("blast", p.x, p.y, add(8.8), { source: "reel" })
    add(11.5)({ id: "wpn.fuse.strike", x: p.x, y: p.y, source: "reel" })
    for (let k = 0; k < 7; k++) {
      const c = ahead(spot, across(spot) + (k % 3) * 0.3, (k % 2) - 0.5)
      wpn.report("cracker", c.x, c.y, add(12.1 + k * 0.23 + (k % 3) * 0.04), { source: "reel" })
    }
    add(14.6)({ id: "wpn.trap.set", x: p.x, y: p.y, source: "reel" })
    add(15.6)({ id: "wpn.trap.snap", x: p.x, y: p.y, source: "reel" })
    return 17
  })
}

function throwScene(spot: Spot): Scene {
  return scene(`Thrown things ${spot.name}`, spot, (add) => {
    let t = 0.2
    for (const item of ["baseball", "brick", "rock", "tin-can", "bottle"] as const) {
      const p = ahead(spot, across(spot))
      wpn.draw(item, spot.x, spot.y, add(t), "reel")
      add(t + 0.5)({ id: item === "brick" || item === "rock" ? "wpn.throw.heavy" : "wpn.throw.light", x: spot.x, y: spot.y, source: "reel" })
      add(t + 1.05)({ id: `wpn.land.${item}`, x: p.x, y: p.y, source: "reel" })
      t += 1.9
    }
    const p = ahead(spot, across(spot))
    add(t)({ id: "wpn.throw.light", x: spot.x, y: spot.y, source: "reel" })
    add(t + 0.45)({ id: "wpn.bonk", x: p.x, y: p.y, source: "reel" })
    add(t + 0.75)({ id: "wpn.land.baseball", x: p.x, y: p.y, gain: 0.55, source: "reel" })
    return t + 1.8
  })
}

const scenes: Scene[] = []
for (const spot of [STREET, ROOM]) {
  const outdoors = spot === STREET
  scenes.push(pistolScene(spot, outdoors ? ["car", "concrete", "glass", "dirt", "wood", "flesh"] : ["plaster", "wood", "glass", "plaster", "flesh", "flesh"]))
  if (outdoors) {
    scenes.push(pistolScene(ALLEY, ["wood", "concrete", "flesh"]))
    wpn.spaceOf = weaponSpace
    scenes.push(teammateScene(spot))
  }
  scenes.push(flareScene(spot))
  for (const w of MELEE_WEAPON_IDS) scenes.push(meleeScene(w, spot, outdoors ? "car" : w === "knife" || w === "machete" ? "wood" : "plaster"))
  scenes.push(throwScene(spot), fireScene(spot))
}
const chosen = scenes.filter((s) => s.name.toLowerCase().startsWith(ONLY.toLowerCase()))

// Today's pistol, for comparison: the library shot, casing, impacts, dry-fire and reload parts.
const todayPistol = (spot: Spot): Scene => ({
  name: `Today pistol ${spot.name}`,
  spot,
  seconds: 7,
  cues: [
    ...[0, 1, 2, 3, 4, 5].flatMap((k): Cue[] => {
      const h = ahead(spot, 8)
      return [
        { id: "gun.pistol.shot", x: spot.x, y: spot.y, at: 0.8 + k * 0.55, source: "shot" },
        { id: "gun.casing", x: spot.x, y: spot.y, at: 0.8 + k * 0.55 + 0.44, source: "shot" },
        { id: k === 5 ? "zombie.hit" : "impact.bullet.concrete", x: h.x, y: h.y, at: 0.8 + k * 0.55 + 0.02, source: "shot" },
      ]
    }),
    { id: "gun.dry-fire", x: spot.x, y: spot.y, at: 4.4, source: "reel" },
    ...RELOAD_STARTS.map((p): Cue => ({ id: p.id, x: spot.x, y: spot.y, at: 4.9 + p.start, source: "reel" })),
  ],
})

// --- Mixer ---------------------------------------------------------------------------------------------------------
const bus = (b: keyof typeof AUDIO_BUS_LEVELS) => ((settings[AUDIO_BUS_LEVELS[b]] as number) / 100) * busVolume(settings, b)
const street = impulse(1.65, 1234567, true)
const room = impulse(0.55, 7654321, false)

async function render(list: readonly Scene[], seed = 5): Promise<{ L: Float32Array; R: Float32Array; marks: { name: string; t0: number; t1: number }[]; per: Record<string, { L: Float32Array; R: Float32Array }> }> {
  const total = list.reduce((s, x) => s + x.seconds + 0.6, 0)
  const N = Math.ceil(total * SR)
  const L = new Float32Array(N)
  const R = new Float32Array(N)
  const marks: { name: string; t0: number; t1: number }[] = []
  const per: Record<string, { L: Float32Array; R: Float32Array }> = {}
  const rand = mulberry32(seed)
  let t0 = 0
  for (const sc of list) {
    const n = Math.ceil((sc.seconds + 0.6) * SR)
    const dryL = new Float32Array(n), dryR = new Float32Array(n), wetL = new Float32Array(n), wetR = new Float32Array(n)
    const me = sc.listener ?? sc.spot
    rt.setListener({ x: me.x, z: me.y, vx: 0, vz: 0, rightX: 1, rightZ: 0, earHeight: 1.7, panScale: 12 })
    for (const cue of sc.cues) {
      const def = weaponSound(cue.id)
      const lib = def ? null : sfxEntry(cue.id)
      const src = await buffers(cue.id)
      if (!src) continue
      const pickFrom = src.bufs.length
      let k = Math.floor(rand() * pickFrom)
      if (pickFrom > 1 && k === lastTake.get(cue.id)) k = (k + 1) % pickFrom
      lastTake.set(cue.id, k)
      const buf = src.bufs[k]!
      const range = def?.range ?? lib!.range
      const variation = settings.audioWpnVariation / 100
      const pj = (def?.pitchJitter ?? lib!.pitchJitter) * (def ? variation : 1)
      const gj = (def?.gainJitter ?? lib!.gainJitter) * (def ? variation : 1)
      const level = def ? (settings[WEAPON_GROUP_KEYS[def.group]] as number) / 100 : 1
      const mix = rt.spatialize({ x: cue.x, z: cue.y, refDistance: range.ref * 0.78, maxDistance: range.max, rolloff: settings.audioFalloff })
      const gain = (def?.gain ?? lib!.gain) * (cue.gain ?? 1) * level * mix.gain * (1 + (rand() * 2 - 1) * gj) * bus(def?.bus ?? lib!.bus)
      const rate = (cue.rate ?? 1) * (1 + (rand() * 2 - 1) * pj) * (src.rate / SR)
      const cutoff = Math.min(cue.cutoffHz ?? 18000, mix.cutoffHz)
      const wet = Math.min(0.85, (def?.wet ?? lib!.wet) + mix.wet * 0.65)
      const a = 1 - Math.exp((-2 * Math.PI * Math.min(cutoff, 15000)) / SR)
      const gl = Math.cos(((mix.pan + 1) * Math.PI) / 4)
      const gr = Math.sin(((mix.pan + 1) * Math.PI) / 4)
      const start = Math.round((cue.at + (cue.delay ?? 0)) * SR)
      const end = cue.hold !== undefined ? Math.min(n, start + Math.round(cue.hold * SR)) : n
      let p = 0
      let lp1 = 0, lp2 = 0
      for (let i = start; i < end; i++) {
        let kk = Math.floor(p)
        if (kk + 1 >= buf.length) {
          if (cue.hold === undefined) break
          p -= buf.length - 1
          kk = Math.floor(p)
        }
        const x = buf[kk]! + (buf[kk + 1]! - buf[kk]!) * (p - kk)
        p += rate
        lp1 += (x - lp1) * a
        lp2 += (lp1 - lp2) * a
        const fade = cue.hold !== undefined ? Math.min(1, (i - start) / (0.08 * SR), (end - i) / (0.25 * SR)) : 1
        const y = lp2 * gain * fade
        dryL[i]! += y * gl
        dryR[i]! += y * gr
        wetL[i]! += y * gl * wet
        wetR[i]! += y * gr * wet
      }
    }
    const ir = indoors(town, me.x, me.y) ? room : street
    const rl = convolve(wetL, ir[0]!)
    const rr = convolve(wetR, ir[1]!)
    const sL = new Float32Array(n), sR = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      sL[i] = (dryL[i]! + rl[i]! * settings.audioReverb) * MASTER * 0.66
      sR[i] = (dryR[i]! + rr[i]! * settings.audioReverb) * MASTER * 0.66
    }
    per[sc.name] = { L: sL, R: sR }
    const o = Math.round(t0 * SR)
    L.set(sL.subarray(0, Math.min(n, N - o)), o)
    R.set(sR.subarray(0, Math.min(n, N - o)), o)
    marks.push({ name: sc.name, t0, t1: t0 + sc.seconds })
    t0 += sc.seconds + 0.6
  }
  return { L, R, marks, per }
}

function impulse(seconds: number, seed0: number, streetIr: boolean): Float32Array[] {
  const n = Math.floor(SR * seconds)
  let seed = seed0
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff - 0.5
  }
  const out: Float32Array[] = []
  for (let c = 0; c < 2; c++) {
    const d = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const t = i / SR
      d[i] = streetIr ? rnd() * Math.exp(-t * 3.6) * (t < 0.012 ? t / 0.012 : 1) : rnd() * Math.exp(-t * (6.9 / seconds)) * (t < 0.003 ? t / 0.003 : 1)
    }
    let lp = 0
    for (let i = 0; i < n; i++) {
      lp += (d[i]! - lp) * (streetIr ? 0.5 * Math.exp((-i / n) * 2.5) : 0.85 - 0.6 * (i / n))
      d[i] = lp
    }
    out.push(d)
  }
  let power = 0
  for (const d of out) for (const v of d) power += v * v
  const scale = (1 / Math.sqrt(power / (2 * n))) * 0.00125 * (44100 / SR)
  for (const d of out) for (let i = 0; i < n; i++) d[i]! *= scale
  return out
}

const measure = (L: Float32Array, R: Float32Array) => {
  let peak = 0
  let over = 0
  for (let i = 0; i < L.length; i++) {
    const p = Math.max(Math.abs(L[i]!), Math.abs(R[i]!))
    peak = Math.max(peak, p)
    if (p > 0.6) over++
  }
  return { integratedLufs: Number(integratedLufs([L, R]).toFixed(1)), momentaryMaxLufs: Number(momentaryMaxLufs([L, R]).toFixed(1)), peakDb: Number((20 * Math.log10(peak)).toFixed(1)), limiterMs: Number(((over / SR) * 1000).toFixed(1)) }
}

mkdirSync(OUT, { recursive: true })
const reel = await render(chosen)
wav(join(OUT, "reel.wav"), reel.L, reel.R)
const report: Record<string, unknown> = { spots: { street: STREET, room: ROOM, alley: ALLEY }, reel: measure(reel.L, reel.R), scenes: {} as Record<string, unknown> }
console.log(`reel ${(reel.L.length / SR).toFixed(1)}s`, report.reel)
for (const m of reel.marks) {
  const s = reel.per[m.name]!
  const r = measure(s.L, s.R)
  ;(report.scenes as Record<string, unknown>)[m.name] = { at: Number(m.t0.toFixed(1)), ...r }
  console.log(`${m.name.padEnd(44)} @${m.t0.toFixed(1).padStart(6)}s  I ${String(r.integratedLufs).padStart(6)}  M max ${String(r.momentaryMaxLufs).padStart(6)}  peak ${String(r.peakDb).padStart(5)} dBFS  limiter ${r.limiterMs} ms`)
}
const today = await render([todayPistol(STREET), todayPistol(ROOM)], 9)
wav(join(OUT, "today-pistol.wav"), today.L, today.R)
for (const m of today.marks) {
  const r = measure(today.per[m.name]!.L, today.per[m.name]!.R)
  ;(report.scenes as Record<string, unknown>)[m.name] = r
  console.log(`${m.name.padEnd(44)}           I ${String(r.integratedLufs).padStart(6)}  M max ${String(r.momentaryMaxLufs).padStart(6)}  peak ${String(r.peakDb).padStart(5)} dBFS`)
}
writeFileSync(join(OUT, "loudness.json"), JSON.stringify(report, null, 2))
writeFileSync(join(OUT, "chapters.txt"), reel.marks.map((m) => `${m.t0.toFixed(1)}\t${m.name}`).join("\n"))
try {
  // Scene titles as stills (this ffmpeg has no drawtext), concatenated into a strip laid over the spectrogram.
  const dir = join(OUT, "titles")
  mkdirSync(dir, { recursive: true })
  const list: string[] = []
  for (const [i, m] of reel.marks.entries()) {
    const png = join(dir, `${String(i).padStart(2, "0")}.png`)
    await $`magick -size 1280x110 xc:#000000 -font /System/Library/Fonts/Helvetica.ttc -fill white -pointsize 44 -gravity west -annotate +40+0 ${m.name} ${png}`.quiet()
    list.push(`file '${png}'`, `duration ${(m.t1 - m.t0 + 0.6).toFixed(3)}`)
  }
  list.push(`file '${join(dir, `${String(reel.marks.length - 1).padStart(2, "0")}.png`)}'`)
  writeFileSync(join(dir, "list.txt"), list.join("\n"))
  await $`ffmpeg -v error -y -i ${join(OUT, "reel.wav")} -f concat -safe 0 -i ${join(dir, "list.txt")} -filter_complex ${"[0:a]volume=6dB,alimiter=limit=0.89:level=false,asplit[a][b];[b]showspectrum=s=1280x610:mode=combined:color=fire:scale=log:slide=scroll:legend=0:gain=3,fps=30,setpts=N/30/TB[s];[1:v]scale=1280:110,fps=30,setpts=N/30/TB[t];[t][s]vstack=shortest=1,format=yuv420p[v]"} -map [v] -map [a] -t ${(reel.L.length / SR).toFixed(2)} -c:v libx264 -preset veryfast -crf 26 -c:a aac -b:a 192k ${join(OUT, "reel.mp4")}`
  console.log(`wrote ${join(OUT, "reel.mp4")}`)
} catch (e) {
  console.log("ffmpeg video failed:", (e as Error).message)
}
